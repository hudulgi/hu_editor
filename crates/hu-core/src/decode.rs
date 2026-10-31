//! Text encodings. Solver decks are ASCII, but comments may carry Korean in
//! UTF-8 or CP949 (the Korean Windows code page). For display each line is
//! decoded as UTF-8 when valid and as CP949 otherwise; typed text is encoded
//! in the encoding detected for the whole file.

use std::borrow::Cow;

// encoding_rs implements the WHATWG EUC-KR, which is CP949.
use encoding_rs::EUC_KR;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Encoding {
    Utf8,
    Cp949,
}

impl Encoding {
    /// UTF-8 unless the sample has bytes that are not valid UTF-8.
    pub fn detect(sample: &[u8]) -> Self {
        match std::str::from_utf8(sample) {
            // A sample can end in the middle of a character.
            Err(e) if e.error_len().is_some() => Encoding::Cp949,
            _ => Encoding::Utf8,
        }
    }

    pub fn encode<'a>(self, text: &'a str) -> Cow<'a, [u8]> {
        match self {
            Encoding::Utf8 => Cow::Borrowed(text.as_bytes()),
            Encoding::Cp949 => EUC_KR.encode(text).0,
        }
    }

    pub fn decode(self, bytes: &[u8]) -> Cow<'_, str> {
        match self {
            Encoding::Utf8 => String::from_utf8_lossy(bytes),
            Encoding::Cp949 => EUC_KR.decode_without_bom_handling(bytes).0,
        }
    }
}

/// One line decoded for display.
pub struct Decoded {
    pub text: String,
    /// Byte offset in the line of each UTF-16 unit of `text`, plus the line
    /// length at the end. `None` for ASCII, where the two are the same.
    pub starts: Option<Vec<u32>>,
}

pub fn decode_line(bytes: &[u8]) -> Decoded {
    if bytes.is_ascii() {
        let text = String::from_utf8(bytes.to_vec()).expect("ASCII is UTF-8");
        return Decoded { text, starts: None };
    }
    let mut text = String::with_capacity(bytes.len());
    let mut starts = Vec::with_capacity(bytes.len() + 1);
    let mut push = |pos: usize, s: &str| {
        for c in s.chars() {
            starts.extend(std::iter::repeat_n(pos as u32, c.len_utf16()));
            text.push(c);
        }
    };
    match std::str::from_utf8(bytes) {
        Ok(s) => {
            for (pos, c) in s.char_indices() {
                push(pos, c.encode_utf8(&mut [0; 4]));
            }
        }
        // CP949: one byte for ASCII, two for anything else.
        Err(_) => {
            let mut pos = 0;
            while pos < bytes.len() {
                let n = if bytes[pos] < 0x80 || pos + 1 == bytes.len() {
                    1
                } else {
                    2
                };
                push(
                    pos,
                    &EUC_KR.decode_without_bom_handling(&bytes[pos..pos + n]).0,
                );
                pos += n;
            }
        }
    }
    starts.push(bytes.len() as u32);
    Decoded {
        text,
        starts: Some(starts),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_utf16_units_to_bytes() {
        let line = decode_line("a한b".as_bytes());
        assert_eq!(line.text, "a한b");
        assert_eq!(line.starts.as_deref(), Some(&[0, 1, 4, 5][..]));

        let (cp949, _, _) = EUC_KR.encode("a한b");
        let line = decode_line(&cp949);
        assert_eq!(line.text, "a한b");
        assert_eq!(line.starts.as_deref(), Some(&[0, 1, 3, 4][..]));
    }

    #[test]
    fn detects_encoding() {
        assert_eq!(Encoding::detect(b"*Node\n"), Encoding::Utf8);
        assert_eq!(Encoding::detect("** 한글".as_bytes()), Encoding::Utf8);
        assert_eq!(
            Encoding::detect(&"** 한글".as_bytes()[..5]),
            Encoding::Utf8,
            "cut mid-character"
        );
        assert_eq!(
            Encoding::detect(&EUC_KR.encode("** 한글").0),
            Encoding::Cp949
        );
    }
}
