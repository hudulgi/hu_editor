//! Text encodings. Solver decks are ASCII, but comments may carry Korean or
//! other text in UTF-8 or a legacy code page.
//!
//! Every encoding here is ASCII compatible: a line feed byte is always a line
//! feed, which the line index and the whole byte-offset model rely on. That
//! is why UTF-16 is not among them.
//!
//! Until the user chooses an encoding, each line is shown as UTF-8 when valid
//! and in a fallback (by default CP949, the Korean Windows code page)
//! otherwise, and typed text is encoded in the encoding detected for the
//! whole file.

use std::borrow::Cow;
use std::io::{self, Write};

use encoding_rs::{DecoderResult, EncoderResult};
use serde::{Deserialize, Serialize};

use crate::problem::Problem;

const CONVERT_BUFFER: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Encoding {
    Utf8,
    Cp949,
    ShiftJis,
    Gbk,
    Big5,
    Windows1252,
}

impl Encoding {
    fn codec(self) -> &'static encoding_rs::Encoding {
        match self {
            Encoding::Utf8 => encoding_rs::UTF_8,
            // The WHATWG EUC-KR is CP949, and its Shift_JIS is CP932.
            Encoding::Cp949 => encoding_rs::EUC_KR,
            Encoding::ShiftJis => encoding_rs::SHIFT_JIS,
            Encoding::Gbk => encoding_rs::GBK,
            Encoding::Big5 => encoding_rs::BIG5,
            Encoding::Windows1252 => encoding_rs::WINDOWS_1252,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Cp949 => "CP949",
            Encoding::ShiftJis => "Shift-JIS",
            Encoding::Gbk => "GBK",
            Encoding::Big5 => "Big5",
            Encoding::Windows1252 => "Windows-1252",
        }
    }

    /// UTF-8, or `fallback` if the sample has bytes that are not valid UTF-8.
    pub fn detect(sample: &[u8], fallback: Encoding) -> Self {
        match std::str::from_utf8(sample) {
            // A sample can end in the middle of a character.
            Err(e) if e.error_len().is_some() => fallback,
            _ => Encoding::Utf8,
        }
    }

    pub fn encode<'a>(self, text: &'a str) -> Cow<'a, [u8]> {
        self.codec().encode(text).0
    }

    pub fn decode(self, bytes: &[u8]) -> Cow<'_, str> {
        self.codec().decode_without_bom_handling(bytes).0
    }

    /// The text, if every byte is valid in this encoding.
    pub fn decode_exact(self, bytes: &[u8]) -> Option<Cow<'_, str>> {
        self.codec()
            .decode_without_bom_handling_and_without_replacement(bytes)
    }
}

/// How lines become text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decoding {
    /// In the encoding the user chose.
    Chosen(Encoding),
    /// As UTF-8 when valid, otherwise in this encoding.
    Auto(Encoding),
}

/// One line decoded for display.
pub struct Decoded {
    pub text: String,
    /// Byte offset in the line of each UTF-16 unit of `text`, plus the line
    /// length at the end. `None` for ASCII, where the two are the same.
    pub starts: Option<Vec<u32>>,
}

pub fn decode_line(bytes: &[u8], decoding: Decoding) -> Decoded {
    if bytes.is_ascii() {
        let text = String::from_utf8(bytes.to_vec()).expect("ASCII is UTF-8");
        return Decoded { text, starts: None };
    }
    let encoding = match decoding {
        Decoding::Chosen(encoding) => encoding,
        Decoding::Auto(_) if std::str::from_utf8(bytes).is_ok() => Encoding::Utf8,
        Decoding::Auto(fallback) => fallback,
    };
    let mut text = String::with_capacity(bytes.len());
    let mut starts = Vec::with_capacity(bytes.len() + 1);
    let mut push = |pos: usize, c: char| {
        starts.extend(std::iter::repeat_n(pos as u32, c.len_utf16()));
        text.push(c);
    };
    if encoding == Encoding::Utf8 {
        let mut pos = 0;
        for chunk in bytes.utf8_chunks() {
            for (i, c) in chunk.valid().char_indices() {
                push(pos + i, c);
            }
            pos += chunk.valid().len();
            if !chunk.invalid().is_empty() {
                push(pos, char::REPLACEMENT_CHARACTER);
                pos += chunk.invalid().len();
            }
        }
    } else {
        // Byte by byte: a character comes out when its last byte goes in.
        let mut decoder = encoding.codec().new_decoder_without_bom_handling();
        let mut out = String::with_capacity(32);
        let mut start = 0;
        for (i, byte) in bytes.iter().enumerate() {
            out.clear();
            let last = i + 1 == bytes.len();
            let _ = decoder.decode_to_string(std::slice::from_ref(byte), &mut out, last);
            if !out.is_empty() {
                out.chars().for_each(|c| push(start, c));
                start = i + 1;
            }
        }
    }
    starts.push(bytes.len() as u32);
    Decoded {
        text,
        starts: Some(starts),
    }
}

/// Converts text between encodings in a stream, chunk by chunk, so a
/// character may straddle two chunks. It refuses rather than damages: a
/// malformed byte or a character the target lacks is an error.
pub struct Converter {
    from: Encoding,
    to: Encoding,
    decoder: encoding_rs::Decoder,
    encoder: encoding_rs::Encoder,
    utf8: String,
    output: Vec<u8>,
    /// Line feeds converted so far, to say where a problem is.
    newlines: u64,
}

impl Converter {
    pub fn new(from: Encoding, to: Encoding) -> Self {
        Self {
            from,
            to,
            decoder: from.codec().new_decoder_without_bom_handling(),
            encoder: to.codec().new_encoder(),
            utf8: String::with_capacity(CONVERT_BUFFER),
            output: Vec::with_capacity(CONVERT_BUFFER),
            newlines: 0,
        }
    }

    /// Converts the next chunk to `out`; `last` marks the end of the text.
    pub fn write(&mut self, mut input: &[u8], last: bool, out: &mut impl Write) -> io::Result<()> {
        loop {
            self.utf8.clear();
            let (result, read) =
                self.decoder
                    .decode_to_string_without_replacement(input, &mut self.utf8, last);
            input = &input[read..];
            match result {
                DecoderResult::Malformed(..) => {
                    return Err(Problem::Malformed {
                        line: self.line(self.utf8.len()),
                        encoding: self.from,
                    }
                    .into());
                }
                DecoderResult::OutputFull => self.encode(false, out)?,
                DecoderResult::InputEmpty => return self.encode(last, out),
            }
        }
    }

    /// Writes `utf8` to `out` in the target encoding.
    fn encode(&mut self, last: bool, out: &mut impl Write) -> io::Result<()> {
        let mut done = 0;
        loop {
            self.output.clear();
            let (result, read) = self.encoder.encode_from_utf8_to_vec_without_replacement(
                &self.utf8[done..],
                &mut self.output,
                last,
            );
            done += read;
            out.write_all(&self.output)?;
            match result {
                EncoderResult::Unmappable(character) => {
                    return Err(Problem::Unmappable {
                        character,
                        line: self.line(done),
                        encoding: self.to,
                    }
                    .into());
                }
                EncoderResult::OutputFull => {}
                EncoderResult::InputEmpty => {
                    self.newlines +=
                        memchr::memchr_iter(b'\n', self.utf8.as_bytes()).count() as u64;
                    return Ok(());
                }
            }
        }
    }

    /// 1-based line number of position `pos` in `utf8`.
    fn line(&self, pos: usize) -> u64 {
        let before = &self.utf8.as_bytes()[..pos];
        self.newlines + memchr::memchr_iter(b'\n', before).count() as u64 + 1
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
pub fn column_range(
    bytes: &[u8],
    left: u32,
    right: u32,
    decoding: Decoding,
) -> (usize, usize, u32) {
    let line = decode_line(bytes, decoding);
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

    const AUTO: Decoding = Decoding::Auto(Encoding::Cp949);

    #[test]
    fn a_chosen_encoding_decides() {
        // 日本語 in Shift-JIS, which is not valid UTF-8.
        let sjis = b"a\x93\xFA\x96\x7B\x8C\xEAb";
        let line = decode_line(sjis, Decoding::Chosen(Encoding::ShiftJis));
        assert_eq!(line.text, "a日本語b");
        assert_eq!(line.starts.as_deref(), Some(&[0, 1, 3, 5, 7, 8][..]));
        // Without a choice the same bytes fall back to CP949.
        assert_ne!(decode_line(sjis, AUTO).text, "a日本語b");
        // Unless that fallback is what the user set.
        assert_eq!(
            decode_line(sjis, Decoding::Auto(Encoding::ShiftJis)).text,
            "a日本語b"
        );

        // One byte, one character, whatever the byte.
        let line = decode_line(b"caf\xE9", Decoding::Chosen(Encoding::Windows1252));
        assert_eq!(line.text, "café");
        assert_eq!(line.starts.as_deref(), Some(&[0, 1, 2, 3, 4][..]));

        // Forced UTF-8 keeps its offsets past invalid bytes.
        let line = decode_line(b"a\xFFb\xEC\x95\x88", Decoding::Chosen(Encoding::Utf8));
        assert_eq!(line.text, "a\u{FFFD}b안");
        assert_eq!(line.starts.as_deref(), Some(&[0, 1, 2, 3, 6][..]));

        // A surrogate pair: two units at one byte offset.
        let line = decode_line("😀x".as_bytes(), Decoding::Chosen(Encoding::Utf8));
        assert_eq!(line.starts.as_deref(), Some(&[0, 0, 4, 5][..]));

        // Columns follow the chosen reading: 日本 takes columns 0..4.
        assert_eq!(
            column_range(
                b"\x93\xFA\x96\x7B x",
                0,
                4,
                Decoding::Chosen(Encoding::ShiftJis)
            ),
            (0, 4, 0)
        );
    }

    fn convert(input: &[u8], from: Encoding, to: Encoding, chunk: usize) -> io::Result<Vec<u8>> {
        let mut converter = Converter::new(from, to);
        let mut out = Vec::new();
        let chunks: Vec<_> = input.chunks(chunk.max(1)).collect();
        for (i, part) in chunks.iter().enumerate() {
            converter.write(part, i + 1 == chunks.len(), &mut out)?;
        }
        if chunks.is_empty() {
            converter.write(b"", true, &mut out)?;
        }
        Ok(out)
    }

    #[test]
    fn converts_across_chunk_boundaries() {
        let text = "** 한글 주석\n*Node\n1, 0., 0., 0.\n** 끝\n";
        let cp949 = Encoding::Cp949.encode(text).into_owned();
        for chunk in [1, 2, 3, 7, 1000] {
            let utf8 = convert(&cp949, Encoding::Cp949, Encoding::Utf8, chunk).unwrap();
            assert_eq!(utf8, text.as_bytes(), "chunk {chunk}");
            let back = convert(text.as_bytes(), Encoding::Utf8, Encoding::Cp949, chunk).unwrap();
            assert_eq!(back, cp949, "chunk {chunk}");
        }
        assert_eq!(
            convert(b"", Encoding::Utf8, Encoding::Cp949, 8).unwrap(),
            b""
        );
    }

    #[test]
    fn longer_than_its_buffers() {
        let text = "한글 comment\n".repeat(400_000);
        assert!(text.len() > 2 * CONVERT_BUFFER);
        let cp949 = Encoding::Cp949.encode(&text).into_owned();
        let utf8 = convert(&cp949, Encoding::Cp949, Encoding::Utf8, cp949.len()).unwrap();
        assert!(utf8 == text.as_bytes());
    }

    #[test]
    fn refuses_rather_than_damages() {
        let err = convert(
            "*Node\n** 한글\n".as_bytes(),
            Encoding::Utf8,
            Encoding::Windows1252,
            4,
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "\"한\" on line 2 cannot be written in Windows-1252"
        );

        let err = convert(b"*Node\n\n\xFF\n", Encoding::Utf8, Encoding::Cp949, 3).unwrap_err();
        assert_eq!(
            err.to_string(),
            "line 3 has bytes that are not valid UTF-8; read the file with the right encoding first"
        );
    }

    #[test]
    fn column_ranges_follow_display_width() {
        let line = "1, 한글, x".as_bytes(); // 한 and 글 take two columns each
        assert_eq!(column_range(line, 0, 2, AUTO), (0, 2, 0));
        assert_eq!(
            column_range(line, 3, 7, AUTO),
            (3, 9, 0),
            "한글 is columns 3..7"
        );
        assert_eq!(
            column_range(line, 4, 5, AUTO),
            (3, 6, 0),
            "half of 한 widens to all of it"
        );
        assert_eq!(column_range(line, 7, 7, AUTO), (9, 9, 0), "insertion point");
        assert_eq!(
            column_range(line, 12, 14, AUTO),
            (12, 12, 2),
            "past the end: pad"
        );
        assert_eq!(
            column_range(b"a\tb", 8, 9, AUTO),
            (2, 3, 0),
            "tab to column 8"
        );
    }

    #[test]
    fn maps_utf16_units_to_bytes() {
        let line = decode_line("a한b".as_bytes(), AUTO);
        assert_eq!(line.text, "a한b");
        assert_eq!(line.starts.as_deref(), Some(&[0, 1, 4, 5][..]));

        let (cp949, _, _) = encoding_rs::EUC_KR.encode("a한b");
        let line = decode_line(&cp949, AUTO);
        assert_eq!(line.text, "a한b");
        assert_eq!(line.starts.as_deref(), Some(&[0, 1, 3, 4][..]));
    }

    #[test]
    fn detects_encoding() {
        assert_eq!(
            Encoding::detect(b"*Node\n", Encoding::Cp949),
            Encoding::Utf8
        );
        assert_eq!(
            Encoding::detect("** 한글".as_bytes(), Encoding::Cp949),
            Encoding::Utf8
        );
        assert_eq!(
            Encoding::detect(&"** 한글".as_bytes()[..5], Encoding::Cp949),
            Encoding::Utf8,
            "cut mid-character"
        );
        assert_eq!(
            Encoding::detect(&encoding_rs::EUC_KR.encode("** 한글").0, Encoding::Cp949),
            Encoding::Cp949
        );
    }
}
