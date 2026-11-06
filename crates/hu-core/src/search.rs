//! Literal search over the whole document, read in large chunks so it never
//! pollutes the viewport's block cache.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use memchr::memmem::{Finder, FinderRev};

use crate::problem::Problem;

const CHUNK: usize = 4 << 20;

/// Random-access bytes to search.
pub trait Reader {
    fn len(&self) -> u64;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Fills `buf` with the bytes at `offset`.
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()>;
}

/// What counts as a match.
#[derive(Debug, Clone, Copy, Default)]
pub struct Matching {
    pub case_sensitive: bool,
    /// Not where the needle goes on into a longer word or number: `101`
    /// matches neither in `1010` nor in `0.101`.
    pub whole_word: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FindOptions {
    pub matching: Matching,
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
    source: &dyn Reader,
    needle: &[u8],
    from: u64,
    options: &FindOptions,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> io::Result<FindResult> {
    find_in_chunks(source, needle, from, options, cancel, progress, CHUNK)
}

fn find_in_chunks(
    source: &dyn Reader,
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
    let mut search = Search::new(source, needle, options.matching, chunk, cancel, progress);
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

/// Offsets of all non-overlapping matches, left to right; `None` if
/// cancelled. More than `limit` matches is an error, so a careless replace
/// cannot run away with memory.
pub fn find_all(
    source: &dyn Reader,
    needle: &[u8],
    matching: Matching,
    limit: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> io::Result<Option<Vec<u64>>> {
    find_all_in_chunks(source, needle, matching, limit, cancel, progress, CHUNK)
}

fn find_all_in_chunks(
    source: &dyn Reader,
    needle: &[u8],
    matching: Matching,
    limit: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
    chunk: usize,
) -> io::Result<Option<Vec<u64>>> {
    let len = source.len();
    let n = needle.len() as u64;
    let mut found = Vec::new();
    if n == 0 {
        return Ok(Some(found));
    }
    let mut search = Search::new(source, needle, matching, chunk, cancel, progress);
    let mut pos = 0;
    // Chunks overlap, so a match can be seen twice; and matches must not overlap.
    let mut free_from = 0;
    while pos + n <= len {
        if search.cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let read = search.read(pos, len)?;
        let mut i = 0;
        while let Some(j) = search.forward.find(&search.buf[i..read]) {
            let at = pos + (i + j) as u64;
            // Overlapping ones too: one inside a longer word must not hide one beside it.
            i += j + 1;
            if at >= free_from && search.stands_alone(at, pos, read)? {
                if found.len() == limit {
                    return Err(Problem::TooManyMatches { limit }.into());
                }
                found.push(at);
                free_from = at + n;
            }
        }
        search.report(read);
        if pos + read as u64 >= len {
            break;
        }
        pos += read as u64 - (n - 1);
    }
    Ok(Some(found))
}

/// Bytes of words: ASCII letters, digits and `_`, and every byte of other
/// characters, whatever the encoding.
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// Whether the needle's `edge` byte goes on into `next`, the byte beside it
/// outside the match, with `beyond` the one after that. A point next to a
/// digit is a decimal point, part of the number, unless a name is on its
/// other side, as in `Part-1-1.Set-1`.
fn joins(edge: u8, next: Option<u8>, beyond: Option<u8>) -> bool {
    match next {
        Some(b'.') if edge.is_ascii_digit() => {
            !beyond.is_some_and(|b| is_word(b) && !b.is_ascii_digit())
        }
        Some(b) => is_word(edge) && is_word(b),
        None => false,
    }
}

struct Search<'a> {
    source: &'a dyn Reader,
    forward: Finder<'static>,
    backward: FinderRev<'static>,
    needle_len: u64,
    matching: Matching,
    buf: Vec<u8>,
    cancel: &'a AtomicBool,
    progress: &'a mut dyn FnMut(u64),
    searched: u64,
}

impl<'a> Search<'a> {
    fn new(
        source: &'a dyn Reader,
        needle: &[u8],
        matching: Matching,
        chunk: usize,
        cancel: &'a AtomicBool,
        progress: &'a mut dyn FnMut(u64),
    ) -> Self {
        let needle = if matching.case_sensitive {
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
            matching,
            buf: vec![0; chunk],
            cancel,
            progress,
            searched: 0,
        }
    }

    /// Whether the match at `at` is a whole word, if that is asked for. The
    /// buffer holds `read` bytes of the source from `pos`; bytes around the
    /// match outside it are read from the source.
    fn stands_alone(&self, at: u64, pos: u64, read: usize) -> io::Result<bool> {
        if !self.matching.whole_word {
            return Ok(true);
        }
        let byte = |offset: Option<u64>| -> io::Result<Option<u8>> {
            let Some(offset) = offset.filter(|&o| o < self.source.len()) else {
                return Ok(None);
            };
            if offset >= pos && offset < pos + read as u64 {
                return Ok(Some(self.buf[(offset - pos) as usize]));
            }
            let mut b = [0];
            self.source.read_at(offset, &mut b)?;
            Ok(Some(b[0]))
        };
        let needle = self.forward.needle();
        let end = at + self.needle_len;
        let before = joins(
            needle[0],
            byte(at.checked_sub(1))?,
            byte(at.checked_sub(2))?,
        );
        Ok(!before
            && !joins(
                needle[needle.len() - 1],
                byte(Some(end))?,
                byte(Some(end + 1))?,
            ))
    }

    /// First match starting in `[start, end - needle_len]`.
    fn forward(&mut self, start: u64, end: u64) -> io::Result<FindResult> {
        let mut pos = start;
        while pos + self.needle_len <= end {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(FindResult::Cancelled);
            }
            let len = self.read(pos, end)?;
            let mut i = 0;
            while let Some(j) = self.forward.find(&self.buf[i..len]) {
                let at = pos + (i + j) as u64;
                if self.stands_alone(at, pos, len)? {
                    return Ok(FindResult::Found(at));
                }
                i += j + 1;
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
            let mut upto = len;
            while let Some(i) = self.backward.rfind(&self.buf[..upto]) {
                let at = chunk_start + i as u64;
                if self.stands_alone(at, chunk_start, len)? {
                    return Ok(FindResult::Found(at));
                }
                // Overlapping ones too: the next may end inside this one.
                upto = i + self.needle_len as usize - 1;
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
        self.source.read_at(pos, buf)?;
        if !self.matching.case_sensitive {
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

    impl Reader for &[u8] {
        fn len(&self) -> u64 {
            <[u8]>::len(self) as u64
        }

        fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
            buf.copy_from_slice(&self[offset as usize..offset as usize + buf.len()]);
            Ok(())
        }
    }

    /// Every match, overlapping ones too, one byte at a time.
    fn naive_matches(hay: &[u8], needle: &[u8], matching: Matching) -> Vec<usize> {
        let byte = |i: Option<usize>| i.and_then(|i| hay.get(i).copied());
        (0..=hay.len().saturating_sub(needle.len()))
            .filter(|&i| {
                let window = &hay[i..i + needle.len()];
                let same = if matching.case_sensitive {
                    window == needle
                } else {
                    window.eq_ignore_ascii_case(needle)
                };
                let end = i + needle.len();
                same && (!matching.whole_word
                    || !joins(hay[i], byte(i.checked_sub(1)), byte(i.checked_sub(2)))
                        && !joins(hay[end - 1], byte(Some(end)), byte(Some(end + 1))))
            })
            .collect()
    }

    fn naive(hay: &[u8], needle: &[u8], from: usize, options: &FindOptions) -> FindResult {
        let matches = naive_matches(hay, needle, options.matching);
        let found = if options.backward {
            matches.iter().rev().find(|&&m| m < from).or(matches.last())
        } else {
            matches.iter().find(|&&m| m >= from).or(matches.first())
        };
        found.map_or(FindResult::NotFound, |&m| FindResult::Found(m as u64))
    }

    const MATCHINGS: [Matching; 4] = [
        Matching {
            case_sensitive: true,
            whole_word: false,
        },
        Matching {
            case_sensitive: false,
            whole_word: false,
        },
        Matching {
            case_sensitive: true,
            whole_word: true,
        },
        Matching {
            case_sensitive: false,
            whole_word: true,
        },
    ];

    #[test]
    fn matches_naive_search_across_chunk_boundaries() {
        let hay: &[u8] =
            b"*Node\n1, 2, 3\n*NSET, nset=Top\n*nset, NSET=BOTTOM\n2, 3\n*Nset, nset=SIDE\n\
            Set-1 Set-10 0.101 101 xa.a.a 1010 101.5 x.101,1.1.1 a.a.ax";
        let cancel = AtomicBool::new(false);

        for needle in [
            "*Nset", "nset", "NSET=", "3\n", "*Node", "E\n", "missing", "*", "101", "Set-1", "a.a",
            "1", "1.1",
        ] {
            for matching in MATCHINGS {
                for backward in [false, true] {
                    let options = FindOptions {
                        matching,
                        backward,
                        wrap: true,
                    };
                    for from in 0..=hay.len() {
                        let got = find_in_chunks(
                            &hay,
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
    fn find_all_matches_naive_scan_across_chunks() {
        let hay: &[u8] = b"aaaa*Nset*NSET aaa nset*nset xa.a.a 1.1.1 101 1010 0.101 x.101";
        let cancel = AtomicBool::new(false);
        let all = |needle: &[u8], matching, chunk| {
            find_all_in_chunks(&hay, needle, matching, 100, &cancel, &mut |_| {}, chunk)
                .unwrap()
                .unwrap()
        };
        let [exact, _, whole, _] = MATCHINGS;
        let any_case = Matching {
            case_sensitive: false,
            ..exact
        };
        for chunk in [4, 8, 1000] {
            assert_eq!(
                all(b"aa", exact, chunk),
                [0, 2, 15],
                "non-overlapping, chunk {chunk}"
            );
            assert_eq!(all(b"*nset", any_case, chunk), [4, 9, 23]);
            assert_eq!(all(b"*nset", exact, chunk), [23]);
            assert!(
                all(b"aa", whole, chunk).is_empty(),
                "all inside longer words"
            );
            for needle in ["a", "aa", "*nset", "a.a", "1", "1.1", "101", ".", " "] {
                for matching in MATCHINGS {
                    // The leftmost, then the leftmost after it, and so on.
                    let mut expected = Vec::new();
                    for at in naive_matches(hay, needle.as_bytes(), matching) {
                        if expected
                            .last()
                            .is_none_or(|&last| at >= last + needle.len())
                        {
                            expected.push(at);
                        }
                    }
                    let expected: Vec<u64> = expected.into_iter().map(|at| at as u64).collect();
                    let got = all(needle.as_bytes(), matching, chunk);
                    assert_eq!(got, expected, "{needle:?} {matching:?} chunk {chunk}");
                }
            }
        }
        let too_many = find_all_in_chunks(&hay, b"a", exact, 3, &cancel, &mut |_| {}, 8);
        assert!(too_many.is_err());
    }

    #[test]
    fn whole_words_and_numbers() {
        let hay = "GRID,101,0.101,1010,101.,x.101,2101,-101,101.5,.101,1.01+2\n\
            Part-1-1.Set-1, Set-10, 강101, *Nset, nset=Set-1\n";
        let marked = |needle: &str| {
            let whole = Matching {
                case_sensitive: false,
                whole_word: true,
            };
            let found = find_all_in_chunks(
                &hay.as_bytes(),
                needle.as_bytes(),
                whole,
                100,
                &AtomicBool::new(false),
                &mut |_| {},
                8,
            )
            .unwrap()
            .unwrap();
            let mut out = hay.to_string();
            for &at in found.iter().rev() {
                out.replace_range(at as usize..at as usize + needle.len(), "#");
            }
            out
        };
        // A decimal point is part of the number.
        assert_eq!(
            marked("101"),
            "GRID,#,0.101,1010,101.,x.#,2101,-#,101.5,.101,1.01+2\n\
            Part-1-1.Set-1, Set-10, 강101, *Nset, nset=Set-1\n"
        );
        // A name after a point is a name of its own; so is one before it.
        assert_eq!(
            marked("set-1"),
            "GRID,101,0.101,1010,101.,x.101,2101,-101,101.5,.101,1.01+2\n\
            Part-1-1.#, Set-10, 강101, *Nset, nset=#\n"
        );
        assert_eq!(
            marked("part-1-1"),
            "GRID,101,0.101,1010,101.,x.101,2101,-101,101.5,.101,1.01+2\n\
            #.Set-1, Set-10, 강101, *Nset, nset=Set-1\n"
        );
        // Ends that are not word characters need nothing around them.
        assert_eq!(
            marked(",101"),
            "GRID#,0.101,1010,101.,x.101,2101,-101,101.5,.101,1.01+2\n\
            Part-1-1.Set-1, Set-10, 강101, *Nset, nset=Set-1\n"
        );
        assert_eq!(
            marked("*nset,"),
            "GRID,101,0.101,1010,101.,x.101,2101,-101,101.5,.101,1.01+2\n\
            Part-1-1.Set-1, Set-10, 강101, # nset=Set-1\n"
        );
    }

    #[test]
    fn cancelled_search_stops() {
        let hay: &[u8] = &[b'x'; 1000];
        let cancel = AtomicBool::new(true);
        let result = find(
            &hay,
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
