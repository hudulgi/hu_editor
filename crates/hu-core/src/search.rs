//! Literal search over the whole document, read in large chunks so it never
//! pollutes the viewport's block cache. Regular expressions are in
//! [`crate::pattern`]; [`crate::query`] puts the two together.

use std::io;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};

use memchr::memmem::{Finder, FinderRev};

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
    /// Where the match starts and ends.
    Found(u64, u64),
    NotFound,
    Cancelled,
}

/// What a walk through the matches comes to.
pub(crate) enum Step<'a> {
    /// The walk could start again here and find the rest: every match
    /// before it has been given.
    Resume(u64),
    Match(Hit<'a>),
}

/// A match, with the text read around it.
pub(crate) struct Hit<'a> {
    pub start: u64,
    pub end: u64,
    /// The text from `at`, which holds the match and its groups.
    pub text: &'a [u8],
    pub at: u64,
    /// A regular expression's groups, the whole match first; `None` for one
    /// that took no part. Empty for a literal needle.
    pub groups: &'a [Option<(u64, u64)>],
}

impl Hit<'_> {
    pub fn bytes(&self, (start, end): (u64, u64)) -> &[u8] {
        &self.text[(start - self.at) as usize..(end - self.at) as usize]
    }
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
    let within = (0, source.len());
    find_in_chunks(
        source, needle, from, options, within, cancel, progress, CHUNK,
    )
}

/// Like [`find`], for matches inside `[lo, hi)` only, going round inside it.
pub(crate) fn find_within(
    source: &dyn Reader,
    needle: &[u8],
    from: u64,
    options: &FindOptions,
    within: (u64, u64),
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> io::Result<FindResult> {
    find_in_chunks(
        source, needle, from, options, within, cancel, progress, CHUNK,
    )
}

#[allow(clippy::too_many_arguments)]
fn find_in_chunks(
    source: &dyn Reader,
    needle: &[u8],
    from: u64,
    options: &FindOptions,
    (lo, hi): (u64, u64),
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
    chunk: usize,
) -> io::Result<FindResult> {
    let n = needle.len() as u64;
    if n == 0 || n > hi - lo {
        return Ok(FindResult::NotFound);
    }
    let from = from.clamp(lo, hi);
    // `[lo, before_from)` holds exactly the matches that start before `from`.
    let before_from = (from + n - 1).min(hi);
    let mut search = Search::new(
        source,
        needle,
        options.matching,
        chunk,
        false,
        cancel,
        progress,
    );
    if options.backward {
        match search.backward(lo, before_from)? {
            FindResult::NotFound if options.wrap => search.backward(from, hi),
            result => Ok(result),
        }
    } else {
        match search.forward(from, hi)? {
            FindResult::NotFound if options.wrap => search.forward(lo, before_from),
            result => Ok(result),
        }
    }
}

/// Walks through the matches from `resume`, left to right without overlaps,
/// that start before `start_max` and end by `end_max`; `f` can stop it.
/// With `original`, hits carry the text as it is rather than case-folded.
/// Returns `false` if cancelled.
#[allow(clippy::too_many_arguments)]
pub(crate) fn each(
    source: &dyn Reader,
    needle: &[u8],
    matching: Matching,
    resume: u64,
    start_max: u64,
    end_max: u64,
    original: bool,
    chunk: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
    f: &mut dyn FnMut(Step) -> ControlFlow<()>,
) -> io::Result<bool> {
    let n = needle.len() as u64;
    if n == 0 {
        return Ok(true);
    }
    let mut search = Search::new(source, needle, matching, chunk, original, cancel, progress);
    let mut pos = resume;
    // Chunks overlap, so a match can be seen twice; and matches must not overlap.
    let mut free_from = resume;
    while pos + n <= end_max && pos < start_max {
        if search.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        // Every match seen so far starts before `pos`: none fit in what was read.
        if f(Step::Resume(pos.max(free_from))).is_break() {
            return Ok(true);
        }
        let read = search.read(pos, end_max)?;
        let mut i = 0;
        while let Some(j) = search.forward.find(&search.buf[i..read]) {
            let at = pos + (i + j) as u64;
            if at >= start_max {
                return Ok(true);
            }
            // Overlapping ones too: one inside a longer word must not hide one beside it.
            i += j + 1;
            if at >= free_from && search.stands_alone(at, pos, read)? {
                free_from = at + n;
                let hit = Hit {
                    start: at,
                    end: at + n,
                    text: search.original(read),
                    at: pos,
                    groups: &[],
                };
                if f(Step::Match(hit)).is_break() {
                    return Ok(true);
                }
            }
        }
        search.report(read);
        if pos + read as u64 >= end_max {
            break;
        }
        pos += read as u64 - (n - 1);
    }
    Ok(true)
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

/// Whether `text[start..end]` is a whole word, judged by the bytes around it
/// in `text`; an empty match always is.
pub(crate) fn stands_alone_in(text: &[u8], start: usize, end: usize) -> bool {
    if start == end {
        return true;
    }
    let byte = |i: Option<usize>| i.and_then(|i| text.get(i).copied());
    !joins(
        text[start],
        byte(start.checked_sub(1)),
        byte(start.checked_sub(2)),
    ) && !joins(text[end - 1], byte(Some(end)), byte(Some(end + 1)))
}

struct Search<'a> {
    source: &'a dyn Reader,
    forward: Finder<'static>,
    backward: FinderRev<'static>,
    needle_len: u64,
    matching: Matching,
    buf: Vec<u8>,
    /// The bytes read before folding case, when they are asked for.
    raw: Vec<u8>,
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
        original: bool,
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
        let raw_len = if original && !matching.case_sensitive {
            chunk
        } else {
            0
        };
        Self {
            source,
            forward: Finder::new(&needle).into_owned(),
            backward: FinderRev::new(&needle).into_owned(),
            needle_len: needle.len() as u64,
            matching,
            buf: vec![0; chunk],
            raw: vec![0; raw_len],
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
                    return Ok(FindResult::Found(at, at + self.needle_len));
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
                    return Ok(FindResult::Found(at, at + self.needle_len));
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
            if !self.raw.is_empty() {
                self.raw[..len].copy_from_slice(buf);
            }
            buf.make_ascii_lowercase();
        }
        Ok(len)
    }

    /// The first `len` bytes read, as they are in the source.
    fn original(&self, len: usize) -> &[u8] {
        if self.raw.is_empty() {
            &self.buf[..len]
        } else {
            &self.raw[..len]
        }
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

    fn naive(
        hay: &[u8],
        needle: &[u8],
        from: usize,
        options: &FindOptions,
        (lo, hi): (usize, usize),
    ) -> FindResult {
        let matches: Vec<usize> = naive_matches(hay, needle, options.matching)
            .into_iter()
            .filter(|&m| m >= lo && m + needle.len() <= hi)
            .collect();
        let from = from.clamp(lo, hi);
        let found = if options.backward {
            matches.iter().rev().find(|&&m| m < from).or(matches.last())
        } else {
            matches.iter().find(|&&m| m >= from).or(matches.first())
        };
        found.map_or(FindResult::NotFound, |&m| {
            FindResult::Found(m as u64, (m + needle.len()) as u64)
        })
    }

    /// The matches `each` finds from `resume`, and where it could resume.
    fn walk(
        hay: &[u8],
        needle: &[u8],
        matching: Matching,
        (resume, start_max, end_max): (u64, u64, u64),
        chunk: usize,
    ) -> (Vec<u64>, Vec<u64>) {
        let (mut found, mut resumes) = (Vec::new(), Vec::new());
        let cancel = AtomicBool::new(false);
        let done = each(
            &hay,
            needle,
            matching,
            resume,
            start_max,
            end_max,
            true,
            chunk,
            &cancel,
            &mut |_| {},
            &mut |step| {
                match step {
                    Step::Resume(at) => resumes.push(at),
                    Step::Match(hit) => {
                        assert!(
                            hit.bytes((hit.start, hit.end)).eq_ignore_ascii_case(needle),
                            "the text as it is"
                        );
                        found.push(hit.start);
                    }
                }
                ControlFlow::Continue(())
            },
        )
        .unwrap();
        assert!(done);
        (found, resumes)
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
        let len = hay.len();

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
                    for within in [(0, len), (7, 60), (31, len - 5), (40, 44)] {
                        for from in 0..=len {
                            let got = find_in_chunks(
                                &hay,
                                needle.as_bytes(),
                                from as u64,
                                &options,
                                (within.0 as u64, within.1 as u64),
                                &cancel,
                                &mut |_| {},
                                8,
                            )
                            .unwrap();
                            let expected = naive(hay, needle.as_bytes(), from, &options, within);
                            assert_eq!(
                                got, expected,
                                "{needle:?} from {from} in {within:?} {options:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn each_walks_like_a_naive_scan_across_chunks() {
        let hay: &[u8] = b"aaaa*Nset*NSET aaa nset*nset xa.a.a 1.1.1 101 1010 0.101 x.101";
        let len = hay.len() as u64;
        let all = |needle: &[u8], matching, chunk| {
            walk(hay, needle, matching, (0, len + 1, len), chunk).0
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
                    let (got, resumes) =
                        walk(hay, needle.as_bytes(), matching, (0, len + 1, len), chunk);
                    assert_eq!(got, expected, "{needle:?} {matching:?} chunk {chunk}");
                    // Going on from where it could resume finds the rest.
                    for at in resumes {
                        let rest: Vec<u64> = got.iter().copied().filter(|&m| m >= at).collect();
                        let again =
                            walk(hay, needle.as_bytes(), matching, (at, len + 1, len), 1000).0;
                        assert_eq!(again, rest, "{needle:?} {matching:?} from {at}");
                    }
                    // Bounds: starting before 30, ending by 50.
                    let inside: Vec<u64> = got
                        .iter()
                        .copied()
                        .filter(|&m| m < 30 && m + needle.len() as u64 <= 50)
                        .collect();
                    let bounded = walk(hay, needle.as_bytes(), matching, (0, 30, 50), chunk).0;
                    assert_eq!(bounded, inside, "{needle:?} {matching:?} bounded");
                }
            }
        }
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
            let len = hay.len() as u64;
            let found = walk(
                hay.as_bytes(),
                needle.as_bytes(),
                whole,
                (0, len + 1, len),
                8,
            )
            .0;
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
        // The same judgement from the bytes around a match alone.
        let text = b"x.101,101.5,(101)";
        assert!(stands_alone_in(text, 2, 5));
        assert!(!stands_alone_in(text, 6, 9));
        assert!(stands_alone_in(text, 13, 16));
        assert!(!stands_alone_in(text, 13, 15));
        assert!(stands_alone_in(text, 3, 3), "an empty match");
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
        let walked = each(
            &hay,
            b"x",
            Matching::default(),
            0,
            1001,
            1000,
            false,
            8,
            &cancel,
            &mut |_| {},
            &mut |_| ControlFlow::Continue(()),
        );
        assert!(!walked.unwrap());
    }
}
