//! Regular expressions, a line at a time. A match never takes in a line
//! break, so the text is read in windows cut at line ends and a 30 GB file
//! is searched like a small one. `^` and `$`, and `\A` and `\z` too, are a
//! line's start and end. A line longer than a window is searched in pieces:
//! a match across a cut is missed.

use std::io;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};

use regex_automata::Input;
use regex_automata::meta::Regex;
use regex_syntax::hir::{
    self, Class, ClassBytes, ClassBytesRange, ClassUnicode, ClassUnicodeRange, Hir, HirKind, Look,
};

use crate::problem::Problem;
use crate::search::{FindResult, Hit, Reader, Step, stands_alone_in};

/// Bytes read at a time.
const WINDOW: usize = 1 << 20;
/// Bytes before a search's start that `^`, `\b` and whole words look at: a character.
const BEHIND: u64 = 4;

pub(crate) struct Pattern {
    re: Regex,
    whole_word: bool,
    /// Bytes read at a time.
    pub window: usize,
}

impl Pattern {
    /// With `unicode` (UTF-8 text), classes, `\w`, `\b` and case go by
    /// Unicode; without, by bytes, and the pattern must be ASCII.
    pub fn new(
        pattern: &str,
        case_sensitive: bool,
        whole_word: bool,
        unicode: bool,
    ) -> Result<Self, Problem> {
        if !unicode && !pattern.is_ascii() {
            return Err(Problem::RegexNotAscii);
        }
        let hir = regex_syntax::ParserBuilder::new()
            .case_insensitive(!case_sensitive)
            .multi_line(true)
            .crlf(true)
            .unicode(unicode)
            .utf8(false)
            .build()
            .parse(pattern)
            .map_err(bad)?;
        let re = Regex::builder()
            .configure(Regex::config().utf8_empty(unicode))
            .build_from_hir(&within_line(hir)?)
            .map_err(|e| Problem::BadRegex {
                message: e.to_string(),
            })?;
        Ok(Self {
            re,
            whole_word,
            window: WINDOW,
        })
    }

    /// How many groups a match has, the whole match included.
    pub fn groups(&self) -> usize {
        self.re.captures_len()
    }

    /// Walks through the matches from `resume`, left to right without
    /// overlaps, that start before `start_max` and end by `end_max`; `f` can
    /// stop it. With `groups`, hits carry the spans of the groups. Returns
    /// `false` if cancelled.
    #[allow(clippy::too_many_arguments)]
    pub fn each(
        &self,
        source: &dyn Reader,
        resume: u64,
        start_max: u64,
        end_max: u64,
        groups: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
        f: &mut dyn FnMut(Step) -> ControlFlow<()>,
    ) -> io::Result<bool> {
        let len = source.len();
        let mut buf = Vec::new();
        let mut caps = self.re.create_captures();
        let mut spans = Vec::new();
        let mut searched = 0;
        let mut last_end = None;
        let mut start = resume;
        loop {
            if start >= start_max || start > end_max {
                return Ok(true);
            }
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            if f(Step::Resume(start)).is_break() {
                return Ok(true);
            }
            let at = start.saturating_sub(BEHIND);
            let from = (start - at) as usize;
            let (read, lines) = read_lines(source, at, from, self.window, &mut buf)?;
            let last = at + read as u64 >= len;
            let next = at + lines as u64;
            let hay = &buf[..read];
            let span_end = (next.min(end_max) - at) as usize;
            let mut s = from;
            while s <= span_end {
                let input = Input::new(hay).span(s..span_end);
                let found = if groups {
                    self.re.search_captures(&input, &mut caps);
                    caps.get_match()
                } else {
                    self.re.search(&input)
                };
                let Some(m) = found else { break };
                let (a, b) = (at + m.start() as u64, at + m.end() as u64);
                // An empty one at a line start is the next window's.
                if a >= start_max || a >= next && !last {
                    break;
                }
                s = m.start() + 1;
                // As in the regex crate, no empty match right after a match.
                if m.is_empty() && last_end == Some(a) {
                    continue;
                }
                if self.whole_word && !stands_alone_in(hay, m.start(), m.end()) {
                    continue;
                }
                if groups {
                    spans.clear();
                    spans.extend((0..caps.group_len()).map(|i| {
                        caps.get_group(i)
                            .map(|g| (at + g.start as u64, at + g.end as u64))
                    }));
                }
                let hit = Hit {
                    start: a,
                    end: b,
                    text: hay,
                    at,
                    groups: &spans,
                };
                if f(Step::Match(hit)).is_break() {
                    return Ok(true);
                }
                last_end = Some(b);
                if !m.is_empty() {
                    s = m.end();
                }
            }
            searched += next - start;
            progress(searched);
            if last {
                return Ok(true);
            }
            start = next;
        }
    }

    /// The last match `each` finds from `lo` that starts before `before` and
    /// ends by `end_max`.
    pub fn last(
        &self,
        source: &dyn Reader,
        lo: u64,
        before: u64,
        end_max: u64,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<FindResult> {
        let mut hi = before;
        let mut searched = 0;
        while hi > lo {
            let start = line_start(source, lo, hi, self.window)?;
            let mut found = FindResult::NotFound;
            let done = self.each(
                source,
                start,
                hi,
                end_max,
                false,
                cancel,
                &mut |n| progress(searched + n),
                &mut |step| {
                    if let Step::Match(hit) = step {
                        found = FindResult::Found(hit.start, hit.end);
                    }
                    ControlFlow::Continue(())
                },
            )?;
            if !done {
                return Ok(FindResult::Cancelled);
            }
            if found != FindResult::NotFound {
                return Ok(found);
            }
            searched += hi - start;
            hi = start;
        }
        Ok(FindResult::NotFound)
    }
}

/// Reads up to a window from `at` into `buf`. Returns how much was read,
/// and where in it the lines end: after the last line break past `from`,
/// unless the text ends there, or a line goes on past the window.
fn read_lines(
    source: &dyn Reader,
    at: u64,
    from: usize,
    window: usize,
    buf: &mut Vec<u8>,
) -> io::Result<(usize, usize)> {
    let len = (source.len() - at).min(window as u64 + BEHIND) as usize;
    buf.resize(len, 0);
    source.read_at(at, buf)?;
    if at + len as u64 >= source.len() {
        return Ok((len, len));
    }
    let from = from.min(len);
    let lines = memchr::memrchr(b'\n', &buf[from..]).map_or(len, |i| from + i + 1);
    Ok((len, lines))
}

/// Where a window ending at `hi` starts: after the first line break of the
/// window's worth before `hi - 1`, so that it holds whole lines; or at `lo`.
fn line_start(source: &dyn Reader, lo: u64, hi: u64, window: usize) -> io::Result<u64> {
    let from = hi.saturating_sub(window as u64).max(lo);
    if from == lo {
        return Ok(lo);
    }
    let mut buf = vec![0; (hi - 1 - from) as usize];
    source.read_at(from, &mut buf)?;
    Ok(memchr::memchr(b'\n', &buf).map_or(from, |i| from + i as u64 + 1))
}

/// A regex error in a few words, without the pattern drawn over it.
fn bad(error: regex_syntax::Error) -> Problem {
    let message = match &error {
        regex_syntax::Error::Parse(e) => e.kind().to_string(),
        regex_syntax::Error::Translate(e) => e.kind().to_string(),
        _ => error.to_string(),
    };
    Problem::BadRegex { message }
}

/// The pattern kept to one line: classes lose the line break characters,
/// and one asked for outright is refused.
fn within_line(hir: Hir) -> Result<Hir, Problem> {
    Ok(match hir.into_kind() {
        HirKind::Empty => Hir::empty(),
        HirKind::Literal(hir::Literal(bytes)) => {
            if bytes.iter().any(|&b| b == b'\n' || b == b'\r') {
                return Err(Problem::RegexLineBreak);
            }
            Hir::literal(bytes)
        }
        HirKind::Class(Class::Unicode(mut class)) => {
            class.difference(&ClassUnicode::new([
                ClassUnicodeRange::new('\n', '\n'),
                ClassUnicodeRange::new('\r', '\r'),
            ]));
            if class.ranges().is_empty() {
                return Err(Problem::RegexLineBreak);
            }
            Hir::class(Class::Unicode(class))
        }
        HirKind::Class(Class::Bytes(mut class)) => {
            class.difference(&ClassBytes::new([
                ClassBytesRange::new(b'\n', b'\n'),
                ClassBytesRange::new(b'\r', b'\r'),
            ]));
            if class.ranges().is_empty() {
                return Err(Problem::RegexLineBreak);
            }
            Hir::class(Class::Bytes(class))
        }
        HirKind::Look(look) => Hir::look(match look {
            Look::Start => Look::StartCRLF,
            Look::End => Look::EndCRLF,
            look => look,
        }),
        HirKind::Repetition(mut repetition) => {
            repetition.sub = Box::new(within_line(*repetition.sub)?);
            Hir::repetition(repetition)
        }
        HirKind::Capture(mut capture) => {
            capture.sub = Box::new(within_line(*capture.sub)?);
            Hir::capture(capture)
        }
        HirKind::Concat(subs) => Hir::concat(
            subs.into_iter()
                .map(within_line)
                .collect::<Result<_, _>>()?,
        ),
        HirKind::Alternation(subs) => Hir::alternation(
            subs.into_iter()
                .map(within_line)
                .collect::<Result<_, _>>()?,
        ),
    })
}
