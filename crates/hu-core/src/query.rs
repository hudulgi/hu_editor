//! What the find bar asks for, made ready for a document: a literal needle
//! or a regular expression, in the whole text or in a selection of it.

use std::io;
use std::ops::ControlFlow;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::decode::Encoding;
use crate::pattern::Pattern;
use crate::search::{self, FindOptions, FindResult, Hit, Matching, Reader, Step};

/// Walks read this much of a literal search at a time; finding where one
/// match is in a count reads no more.
const CHUNK: usize = 1 << 20;

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub needle: String,
    pub case_sensitive: bool,
    /// See [`Matching::whole_word`].
    pub whole_word: bool,
    /// The needle is a regular expression, matched within a line.
    pub regex: bool,
    /// Find in Selection: only matches inside `[start, end)`.
    pub scope: Option<(u64, u64)>,
}

/// How many matches there are, and which one is selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchCount {
    pub total: u64,
    /// From 1; `None` if the selection is not one of them.
    pub index: Option<u64>,
}

/// The matches counted, with places on the way where a walk can start
/// again, so that finding where one match is needs no walk from the start.
pub(crate) struct Count {
    pub total: u64,
    /// Where a walk can start again, and how many matches came before.
    marks: Vec<(u64, u64)>,
}

/// A query made ready for a text: what it finds, and where.
pub(crate) struct Matcher {
    kind: Kind,
    lo: u64,
    hi: u64,
    /// Matches start before this: an empty one at the end of the text
    /// counts, but not one at the end of a selection.
    starts_before: u64,
    /// How much a literal walk reads at a time.
    chunk: usize,
}

enum Kind {
    Literal { needle: Vec<u8>, matching: Matching },
    Regex(Pattern),
}

impl Matcher {
    /// For a text of `len` bytes in `encoding`; `None` for an empty needle,
    /// which finds nothing.
    pub fn new(query: &Query, encoding: Encoding, len: u64) -> io::Result<Option<Self>> {
        if query.needle.is_empty() {
            return Ok(None);
        }
        let kind = if query.regex {
            Kind::Regex(Pattern::new(
                &query.needle,
                query.case_sensitive,
                query.whole_word,
                encoding == Encoding::Utf8,
            )?)
        } else {
            Kind::Literal {
                needle: encoding.encode(&query.needle).into_owned(),
                matching: Matching {
                    case_sensitive: query.case_sensitive,
                    whole_word: query.whole_word,
                },
            }
        };
        let (lo, hi) = match query.scope {
            Some((start, end)) => {
                let lo = start.min(len);
                (lo, end.clamp(lo, len))
            }
            None => (0, len),
        };
        Ok(Some(Self {
            kind,
            lo,
            hi,
            starts_before: if query.scope.is_some() { hi } else { hi + 1 },
            chunk: CHUNK,
        }))
    }

    /// Reading `chunk` bytes at a time, to see the seams in small texts.
    #[cfg(test)]
    pub fn chunked(mut self, chunk: usize) -> Self {
        self.chunk = chunk;
        if let Kind::Regex(pattern) = &mut self.kind {
            pattern.window = chunk;
        }
        self
    }

    /// How many groups a match has, the whole match included.
    pub fn groups(&self) -> usize {
        match &self.kind {
            Kind::Literal { .. } => 1,
            Kind::Regex(pattern) => pattern.groups(),
        }
    }

    /// The first match from `from`, or the last one before it `backward`,
    /// going round the end.
    pub fn find(
        &self,
        source: &dyn Reader,
        from: u64,
        backward: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<FindResult> {
        let (lo, hi, starts_before) = (self.lo, self.hi, self.starts_before);
        let from = from.clamp(lo, hi);
        let pattern = match &self.kind {
            Kind::Literal { needle, matching } => {
                let options = FindOptions {
                    matching: *matching,
                    backward,
                    wrap: true,
                };
                return search::find_within(
                    source,
                    needle,
                    from,
                    &options,
                    (lo, hi),
                    cancel,
                    progress,
                );
            }
            Kind::Regex(pattern) => pattern,
        };
        if backward {
            match pattern.last(source, lo, from, hi, cancel, progress)? {
                FindResult::NotFound => {
                    pattern.last(source, from, starts_before, hi, cancel, progress)
                }
                found => Ok(found),
            }
        } else {
            match self.first(source, from, starts_before, cancel, progress)? {
                FindResult::NotFound => self.first(source, lo, from, cancel, progress),
                found => Ok(found),
            }
        }
    }

    /// The first match a walk from `from` finds, starting before `start_max`.
    fn first(
        &self,
        source: &dyn Reader,
        from: u64,
        start_max: u64,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<FindResult> {
        let mut found = FindResult::NotFound;
        let done = self.each(
            source,
            from,
            start_max,
            false,
            cancel,
            progress,
            &mut |step| match step {
                Step::Match(hit) => {
                    found = FindResult::Found(hit.start, hit.end);
                    ControlFlow::Break(())
                }
                Step::Resume(_) => ControlFlow::Continue(()),
            },
        )?;
        Ok(if done { found } else { FindResult::Cancelled })
    }

    /// Walks through the matches from `resume` that start before
    /// `start_max`, left to right without overlaps. With `text`, hits carry
    /// the text as it is (a literal search folds case) and a regex's
    /// groups. Returns `false` if cancelled.
    #[allow(clippy::too_many_arguments)]
    pub fn each(
        &self,
        source: &dyn Reader,
        resume: u64,
        start_max: u64,
        text: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
        f: &mut dyn FnMut(Step) -> ControlFlow<()>,
    ) -> io::Result<bool> {
        let resume = resume.max(self.lo);
        match &self.kind {
            Kind::Literal { needle, matching } => search::each(
                source, needle, *matching, resume, start_max, self.hi, text, self.chunk, cancel,
                progress, f,
            ),
            Kind::Regex(pattern) => pattern.each(
                source, resume, start_max, self.hi, text, cancel, progress, f,
            ),
        }
    }

    /// Every match, as `each` gives them.
    pub fn each_match(
        &self,
        source: &dyn Reader,
        text: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
        f: &mut dyn FnMut(&Hit) -> ControlFlow<()>,
    ) -> io::Result<bool> {
        self.each(
            source,
            self.lo,
            self.starts_before,
            text,
            cancel,
            progress,
            &mut |step| match step {
                Step::Match(hit) => f(&hit),
                Step::Resume(_) => ControlFlow::Continue(()),
            },
        )
    }

    /// `f` of the match at `[start, end)`, if there is one: a hit with its
    /// text and groups.
    pub fn at<T>(
        &self,
        source: &dyn Reader,
        (start, end): (u64, u64),
        f: impl FnOnce(&Hit) -> T,
    ) -> io::Result<Option<T>> {
        // The walk keeps to the scope, but would give an empty match at its end.
        if start >= self.starts_before {
            return Ok(None);
        }
        let mut f = Some(f);
        let mut out = None;
        let never = AtomicBool::new(false);
        self.each(
            source,
            start,
            start + 1,
            true,
            &never,
            &mut |_| {},
            &mut |step| match step {
                Step::Match(hit) => {
                    if hit.start == start && hit.end == end {
                        out = f.take().map(|f| f(&hit));
                    }
                    ControlFlow::Break(())
                }
                Step::Resume(_) => ControlFlow::Continue(()),
            },
        )?;
        Ok(out)
    }

    /// Counts the matches; `None` if cancelled.
    pub fn count(
        &self,
        source: &dyn Reader,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<Option<Count>> {
        let mut count = Count {
            total: 0,
            marks: Vec::new(),
        };
        let done = self.each(
            source,
            self.lo,
            self.starts_before,
            false,
            cancel,
            progress,
            &mut |step| {
                match step {
                    Step::Resume(at) => count.marks.push((at, count.total)),
                    Step::Match(_) => count.total += 1,
                }
                ControlFlow::Continue(())
            },
        )?;
        Ok(done.then_some(count))
    }

    /// Which of the matches counted `[start, end)` is, from 1.
    pub fn index(
        &self,
        source: &dyn Reader,
        count: &Count,
        (start, end): (u64, u64),
    ) -> io::Result<Option<u64>> {
        let after = count.marks.partition_point(|&(resume, _)| resume <= start);
        let Some(&(resume, before)) = after.checked_sub(1).map(|i| &count.marks[i]) else {
            return Ok(None);
        };
        let mut seen = before;
        let mut index = None;
        let never = AtomicBool::new(false);
        self.each(
            source,
            resume,
            start + 1,
            false,
            &never,
            &mut |_| {},
            &mut |step| {
                if let Step::Match(hit) = step {
                    seen += 1;
                    if hit.start == start {
                        index = (hit.end == end).then_some(seen);
                        return ControlFlow::Break(());
                    }
                }
                ControlFlow::Continue(())
            },
        )?;
        Ok(index)
    }
}

/// What a match is replaced with.
pub(crate) struct Replacement {
    parts: Vec<Part>,
    preserve_case: bool,
    encoding: Encoding,
}

#[derive(Debug, PartialEq)]
enum Part {
    Text(Vec<u8>),
    Group(usize),
}

impl Replacement {
    /// `replacement` as typed. For a regex with `groups` groups, `$1` or
    /// `$&` stands for a group or the whole match, `$$` for `$`, and `\n`
    /// and `\t` for a line break and a tab, as in VS Code. `encode` turns
    /// text into the document's bytes.
    pub fn new(
        replacement: &str,
        groups: Option<usize>,
        preserve_case: bool,
        encoding: Encoding,
        encode: impl Fn(&str) -> Vec<u8>,
    ) -> Self {
        let parts = match groups {
            Some(groups) => template(replacement, groups)
                .into_iter()
                .map(|part| match part {
                    Templated::Text(text) => Part::Text(encode(&text)),
                    Templated::Group(i) => Part::Group(i),
                })
                .collect(),
            None => vec![Part::Text(encode(replacement))],
        };
        Self {
            parts,
            preserve_case,
            encoding,
        }
    }

    /// Whether making one needs the text matched.
    pub fn needs_text(&self) -> bool {
        self.preserve_case || self.parts.iter().any(|p| matches!(p, Part::Group(_)))
    }

    /// The bytes that replace `hit`.
    pub fn expand(&self, hit: &Hit) -> Vec<u8> {
        let mut out = Vec::new();
        for part in &self.parts {
            match part {
                Part::Text(bytes) => out.extend_from_slice(bytes),
                Part::Group(i) => {
                    if let Some(&Some(span)) = hit.groups.get(*i) {
                        out.extend_from_slice(hit.bytes(span));
                    }
                }
            }
        }
        if self.preserve_case {
            let matched = self.encoding.decode_exact(hit.bytes((hit.start, hit.end)));
            if let (Some(matched), Some(text)) = (matched, self.encoding.decode_exact(&out)) {
                let cased = preserve_case(&matched, &text);
                if cased != text {
                    return self.encoding.encode(&cased).into_owned();
                }
            }
        }
        out
    }
}

#[derive(Debug, PartialEq)]
enum Templated {
    Text(String),
    Group(usize),
}

/// A regex replacement's text and groups.
fn template(replacement: &str, groups: usize) -> Vec<Templated> {
    let mut parts = Vec::new();
    let mut text = String::new();
    let mut chars = replacement.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek().copied()) {
            ('\\', Some(next @ ('n' | 't' | '\\'))) => {
                chars.next();
                text.push(match next {
                    'n' => '\n',
                    't' => '\t',
                    _ => '\\',
                });
            }
            ('$', Some('$')) => {
                chars.next();
                text.push('$');
            }
            ('$', Some('&')) => {
                chars.next();
                parts.push(Templated::Text(std::mem::take(&mut text)));
                parts.push(Templated::Group(0));
            }
            ('$', Some(d)) if d.is_ascii_digit() => {
                // Two digits if there are that many groups, as in JavaScript.
                let mut rest = chars.clone();
                rest.next();
                let one = d as usize - '0' as usize;
                let two = rest
                    .peek()
                    .filter(|c| c.is_ascii_digit())
                    .map(|&c| one * 10 + (c as usize - '0' as usize))
                    .filter(|&n| n < groups);
                let Some((group, len)) = two.map(|n| (n, 2)).or((one < groups).then_some((one, 1)))
                else {
                    text.push('$');
                    continue;
                };
                for _ in 0..len {
                    chars.next();
                }
                parts.push(Templated::Text(std::mem::take(&mut text)));
                parts.push(Templated::Group(group));
            }
            _ => text.push(c),
        }
    }
    parts.push(Templated::Text(text));
    parts.retain(|p| *p != Templated::Text(String::new()));
    parts
}

/// The replacement in the case of what it replaces, as VS Code's Preserve
/// Case has it: all capitals, all small, or the first letter's case; and
/// part by part where both are cut alike by `-` or `_`. Without letters to
/// go by, as it is.
pub(crate) fn preserve_case(matched: &str, replacement: &str) -> String {
    for (cut, other) in [('-', '_'), ('_', '-')] {
        if cut_alike(matched, replacement, cut) && !cut_alike(matched, replacement, other) {
            return matched
                .split(cut)
                .zip(replacement.split(cut))
                .map(|(m, r)| preserve_case(m, r))
                .collect::<Vec<_>>()
                .join(&cut.to_string());
        }
    }
    let upper = matched.chars().any(char::is_uppercase);
    let lower = matched.chars().any(char::is_lowercase);
    if upper && !lower {
        return replacement.to_uppercase();
    }
    if lower && !upper {
        return replacement.to_lowercase();
    }
    let first = matched.chars().next();
    let mut rest = replacement.chars();
    match (first, rest.next()) {
        (Some(m), Some(r)) if m.is_uppercase() => r.to_uppercase().chain(rest).collect(),
        (Some(m), Some(r)) if m.is_lowercase() => r.to_lowercase().chain(rest).collect(),
        _ => replacement.to_string(),
    }
}

fn cut_alike(matched: &str, replacement: &str, cut: char) -> bool {
    matched.contains(cut)
        && replacement.contains(cut)
        && matched.split(cut).count() == replacement.split(cut).count()
}

#[cfg(test)]
mod tests;
