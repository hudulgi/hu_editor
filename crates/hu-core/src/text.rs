//! Display decoding. Solver decks are ASCII, but comments may carry Korean
//! in UTF-8 or CP949 (the Korean Windows code page), so each line is decoded
//! as UTF-8 when valid and as CP949 otherwise.

use std::borrow::Cow;

// encoding_rs implements the WHATWG EUC-KR, which is CP949.
use encoding_rs::EUC_KR;

pub struct Line<'a> {
    bytes: &'a [u8],
    utf8: bool,
}

impl<'a> Line<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            utf8: std::str::from_utf8(bytes).is_ok(),
        }
    }

    pub fn text(&self) -> String {
        self.decode(self.bytes).into_owned()
    }

    /// Index into the decoded text, in UTF-16 code units (JavaScript string
    /// indices), of byte position `pos`.
    pub fn utf16_index(&self, pos: usize) -> u32 {
        let prefix = &self.bytes[..pos];
        if prefix.is_ascii() {
            pos as u32
        } else {
            self.decode(prefix).encode_utf16().count() as u32
        }
    }

    fn decode<'b>(&self, bytes: &'b [u8]) -> Cow<'b, str> {
        if self.utf8 {
            String::from_utf8_lossy(bytes)
        } else {
            EUC_KR.decode_without_bom_handling(bytes).0
        }
    }
}
