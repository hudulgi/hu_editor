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

/// Tab stops, in columns.
pub const TAB: u32 = 8;

/// Columns a character takes in a monospaced font: two for Hangul, CJK and
/// full-width forms.
pub fn char_width(c: char) -> u32 {
    match c as u32 {
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA960..=0xA97F
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1F64F
        | 0x20000..=0x3FFFD => 2,
        _ => 1,
    }
}

/// The bytes of a line (without its terminator) covering the columns
/// `[left, right)`, widened to whole characters, as `(start, end, pad)`.
/// When the line ends before `left`, both are its end and `pad` is the
/// number of spaces missing up to `left`. With `left == right` it is an
/// insertion point.
pub fn column_range(bytes: &[u8], left: u32, right: u32) -> (usize, usize, u32) {
    let line = decode_line(bytes);
    let byte = |unit: usize| line.starts.as_ref().map_or(unit, |s| s[unit] as usize);
    let (mut start, mut end) = (None, None);
    let (mut col, mut unit) = (0, 0);
    for c in line.text.chars() {
        let width = if c == '\t' {
            TAB - col % TAB
        } else {
            char_width(c)
        };
        // A character overlapping the left edge, or the first after it.
        if start.is_none() && col + width > left {
            start = Some(byte(unit));
        }
        if end.is_none() && col >= right {
            end = Some(byte(unit));
        }
        col += width;
        unit += c.len_utf16();
    }
    let start = start.unwrap_or(bytes.len());
    let end = if right <= left {
        start
    } else {
        end.unwrap_or(bytes.len()).max(start)
    };
    (start, end, left.saturating_sub(col))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_ranges_follow_display_width() {
        let line = "1, 한글, x".as_bytes(); // 한 and 글 take two columns each
        assert_eq!(column_range(line, 0, 2), (0, 2, 0));
        assert_eq!(column_range(line, 3, 7), (3, 9, 0), "한글 is columns 3..7");
        assert_eq!(
            column_range(line, 4, 5),
            (3, 6, 0),
            "half of 한 widens to all of it"
        );
        assert_eq!(column_range(line, 7, 7), (9, 9, 0), "insertion point");
        assert_eq!(column_range(line, 12, 14), (12, 12, 2), "past the end: pad");
        assert_eq!(column_range(b"a\tb", 8, 9), (2, 3, 0), "tab to column 8");
    }

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
