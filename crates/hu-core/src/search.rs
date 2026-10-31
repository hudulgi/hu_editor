//! Literal search over the whole file, streamed from disk in large chunks
//! so it never pollutes the viewport's block cache.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use memchr::memmem::{Finder, FinderRev};

use crate::source::FileSource;

const CHUNK: usize = 4 << 20;

#[derive(Debug, Clone, Copy, Default)]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub backward: bool,
    /// Continue from the other end of the file when nothing is found.
    pub wrap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindResult {
    /// Offset of the match.
    Found(u64),
    NotFound,
    Cancelled,
}

/// Finds the first match starting at or after `from` (the last one starting
/// before `from` when searching backward). `progress` receives the number of
/// bytes searched so far. Case-insensitive search folds ASCII only.
pub fn find(
    source: &FileSource,
    needle: &[u8],
    from: u64,
    options: &FindOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> io::Result<FindResult> {
    find_in_chunks(source, needle, from, options, cancel, progress, CHUNK)
}

fn find_in_chunks(
    source: &FileSource,
    needle: &[u8],
    from: u64,
    options: &FindOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
    chunk: usize,
) -> io::Result<FindResult> {
    let len = source.len();
    let n = needle.len() as u64;
    if n == 0 || n > len {
        return Ok(FindResult::NotFound);
    }
    let from = from.min(len);
    // `[0, before_from)` holds exactly the matches that start before `from`.
    let before_from = (from + n - 1).min(len);
    let mut search = Search::new(
        source,
        needle,
        options.case_sensitive,
        chunk,
        cancel,
        progress,
    );
    if options.backward {
        match search.backward(0, before_from)? {
            FindResult::NotFound if options.wrap => search.backward(from, len),
            result => Ok(result),
        }
    } else {
        match search.forward(from, len)? {
            FindResult::NotFound if options.wrap => search.forward(0, before_from),
            result => Ok(result),
        }
    }
}

struct Search<'a> {
    source: &'a FileSource,
    forward: Finder<'static>,
    backward: FinderRev<'static>,
    needle_len: u64,
    case_sensitive: bool,
    buf: Vec<u8>,
    cancel: &'a AtomicBool,
    progress: &'a mut dyn FnMut(u64),
    searched: u64,
}

impl<'a> Search<'a> {
    fn new(
        source: &'a FileSource,
        needle: &[u8],
        case_sensitive: bool,
        chunk: usize,
        cancel: &'a AtomicBool,
        progress: &'a mut dyn FnMut(u64),
    ) -> Self {
        let needle = if case_sensitive {
            needle.to_vec()
        } else {
            needle.to_ascii_lowercase()
        };
        // Consecutive chunks overlap by `needle.len() - 1`; keep them clearly larger.
        let chunk = chunk.max(needle.len() * 2);
        Self {
            source,
            forward: Finder::new(&needle).into_owned(),
            backward: FinderRev::new(&needle).into_owned(),
            needle_len: needle.len() as u64,
            case_sensitive,
            buf: vec![0; chunk],
            cancel,
            progress,
            searched: 0,
        }
    }

    /// First match starting in `[start, end - needle_len]`.
    fn forward(&mut self, start: u64, end: u64) -> io::Result<FindResult> {
        let mut pos = start;
        while pos + self.needle_len <= end {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(FindResult::Cancelled);
            }
            let len = self.read(pos, end)?;
            if let Some(i) = self.forward.find(&self.buf[..len]) {
                return Ok(FindResult::Found(pos + i as u64));
            }
            self.report(len);
            if pos + len as u64 >= end {
                break;
            }
            pos += len as u64 - (self.needle_len - 1);
        }
        Ok(FindResult::NotFound)
    }

    /// Last match starting in `[start, end - needle_len]`.
    fn backward(&mut self, start: u64, end: u64) -> io::Result<FindResult> {
        let mut chunk_end = end;
        while chunk_end >= start + self.needle_len {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(FindResult::Cancelled);
            }
            let chunk_start = chunk_end.saturating_sub(self.buf.len() as u64).max(start);
            let len = self.read(chunk_start, chunk_end)?;
            if let Some(i) = self.backward.rfind(&self.buf[..len]) {
                return Ok(FindResult::Found(chunk_start + i as u64));
            }
            self.report(len);
            if chunk_start == start {
                break;
            }
            chunk_end = chunk_start + self.needle_len - 1;
        }
        Ok(FindResult::NotFound)
    }

    /// Reads as much of `[pos, end)` as fits the buffer, folding case if needed.
    fn read(&mut self, pos: u64, end: u64) -> io::Result<usize> {
        let len = (end - pos).min(self.buf.len() as u64) as usize;
        let buf = &mut self.buf[..len];
        self.source.read_uncached(pos, buf)?;
        if !self.case_sensitive {
            buf.make_ascii_lowercase();
        }
        Ok(len)
    }

    fn report(&mut self, len: usize) {
        self.searched += len as u64;
        (self.progress)(self.searched);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn naive(hay: &[u8], needle: &[u8], from: usize, options: &FindOptions) -> FindResult {
        let matches: Vec<usize> = (0..=hay.len().saturating_sub(needle.len()))
            .filter(|&i| {
                let window = &hay[i..i + needle.len()];
                if options.case_sensitive {
                    window == needle
                } else {
                    window.eq_ignore_ascii_case(needle)
                }
            })
            .collect();
        let found = if options.backward {
            matches.iter().rev().find(|&&m| m < from).or(matches.last())
        } else {
            matches.iter().find(|&&m| m >= from).or(matches.first())
        };
        found.map_or(FindResult::NotFound, |&m| FindResult::Found(m as u64))
    }

    #[test]
    fn matches_naive_search_across_chunk_boundaries() {
        let hay = b"*Node\n1, 2, 3\n*NSET, nset=Top\n*nset, NSET=BOTTOM\n2, 3\n*Nset, nset=SIDE\n";
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(hay).unwrap();
        let source = FileSource::open(file.path()).unwrap();
        let cancel = AtomicBool::new(false);

        for needle in [
            "*Nset", "nset", "NSET=", "3\n", "*Node", "E\n", "missing", "*",
        ] {
            for case_sensitive in [true, false] {
                for backward in [false, true] {
                    let options = FindOptions {
                        case_sensitive,
                        backward,
                        wrap: true,
                    };
                    for from in 0..=hay.len() {
                        let got = find_in_chunks(
                            &source,
                            needle.as_bytes(),
                            from as u64,
                            &options,
                            &cancel,
                            &mut |_| {},
                            8,
                        )
                        .unwrap();
                        let expected = naive(hay, needle.as_bytes(), from, &options);
                        assert_eq!(got, expected, "{needle:?} from {from} {options:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn cancelled_search_stops() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&[b'x'; 1000]).unwrap();
        let source = FileSource::open(file.path()).unwrap();
        let cancel = AtomicBool::new(true);
        let result = find(
            &source,
            b"needle",
            0,
            &FindOptions::default(),
            &cancel,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result, FindResult::Cancelled);
    }
}
