//! Two documents compared line by line, for the compare window.
//!
//! Each line is kept as a 64-bit hash of its bytes (without the line break,
//! so CRLF and LF lines are equal): 8 bytes a line a side, the only memory a
//! comparison needs beyond the documents. [`hu_diff`] turns the hashes into
//! hunks. Shown side by side, an equal line takes a row of its own on both
//! sides, and a hunk the rows of its longer side, the shorter one padded.
//!
//! When a document changes (a hunk copied across, or an edit anywhere), only
//! the lines around the change are hashed and compared again: the two
//! snapshots' pieces tell what changed without reading the rest.

use std::io;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};

use hu_diff::Hunk;
use serde::{Deserialize, Serialize};
use xxhash_rust::xxh3::{Xxh3, xxh3_64};

use crate::decode::decode_line;
use crate::document::MAX_COPY;
use crate::problem::Problem;
use crate::search::Reader;
use crate::text::Text;

const CHUNK: usize = 4 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Left,
    Right,
}

impl Side {
    fn index(self) -> usize {
        self as usize
    }

    fn other(self) -> Side {
        match self {
            Side::Left => Side::Right,
            Side::Right => Side::Left,
        }
    }
}

/// Rows of the comparison, from `top`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareView {
    pub top: u64,
    /// Rows in all.
    pub total: u64,
    pub hunks: usize,
    /// The rows of all the hunks, by kind.
    pub lines: HunkLines,
    pub rows: Vec<CompareRow>,
}

/// Rows of hunks by kind: a line on each side that differ, a line only on
/// the left, a line only on the right. A hunk pairs its lines from the top,
/// the rest of its longer side being on that side only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkLines {
    pub changed: u64,
    pub only_left: u64,
    pub only_right: u64,
}

impl HunkLines {
    fn of(h: &Hunk) -> Self {
        let (a, b) = (h.a_len() as u64, h.b_len() as u64);
        let changed = a.min(b);
        HunkLines {
            changed,
            only_left: a - changed,
            only_right: b - changed,
        }
    }
}

/// A line on each side, or on one side only, in a hunk or not.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    pub hunk: Option<usize>,
    pub left: Option<CompareLine>,
    pub right: Option<CompareLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareLine {
    /// 0-based.
    pub line: u64,
    pub text: String,
    pub truncated: bool,
    /// What changed from the line across, in UTF-16 units of `text`.
    pub marks: Vec<[u32; 2]>,
}

/// The rows a hunk takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkRows {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub lines: HunkLines,
}

/// How a stretch of rows looks in the overview: nothing, lines changed,
/// lines only on the left, lines only on the right (as the rows themselves
/// show: a hunk is all of them that it has).
pub const OVERVIEW_CHANGED: u8 = 1;
pub const OVERVIEW_LEFT: u8 = 2;
pub const OVERVIEW_RIGHT: u8 = 3;

/// Replace `[start, end)` of the side copied to with `text`: lines, with
/// line breaks as `\n`, which the document writes its own way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    pub start: u64,
    pub end: u64,
    pub text: String,
}

pub struct Comparison {
    texts: [Text; 2],
    hashes: [Vec<u64>; 2],
    hunks: Vec<Hunk>,
    /// The row each hunk starts at.
    starts: Vec<u64>,
}

/// Where a row is: lines on both sides outside a hunk, or a row of a hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Place {
    Equal { left: u64, right: u64 },
    Hunk { index: usize, row: u64 },
}

impl Comparison {
    /// Compares `left` and `right`, whose line numbers must be known (their
    /// line index complete), reporting the bytes read. `None` once cancelled.
    pub fn new(
        left: Text,
        right: Text,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<Option<Self>> {
        let mut read = 0;
        let mut hash = |text: &Text| {
            let done = read;
            let hashes = hash_lines(text, 0, u64::MAX, CHUNK, cancel, &mut |n| {
                progress(done + n)
            });
            read += text.len();
            hashes
        };
        let Some(left_hashes) = hash(&left)? else {
            return Ok(None);
        };
        let Some(right_hashes) = hash(&right)? else {
            return Ok(None);
        };
        let limit = u32::MAX as usize - 1;
        if left_hashes.len() > limit || right_hashes.len() > limit {
            return Err(Problem::TooManyLines { limit }.into());
        }
        let Some(hunks) = hu_diff::diff(&left_hashes, &right_hashes, cancel) else {
            return Ok(None);
        };
        let mut comparison = Comparison {
            texts: [left, right],
            hashes: [left_hashes, right_hashes],
            hunks,
            starts: Vec::new(),
        };
        comparison.place_hunks(0);
        Ok(Some(comparison))
    }

    pub fn rows(&self) -> u64 {
        match (self.hunks.last(), self.starts.last()) {
            (Some(h), Some(&start)) => {
                start + rows_of(h) + (self.lines(Side::Left) - h.a_end as u64)
            }
            _ => self.lines(Side::Left),
        }
    }

    pub fn hunk_count(&self) -> usize {
        self.hunks.len()
    }

    pub fn lines(&self, side: Side) -> u64 {
        self.hashes[side.index()].len() as u64
    }

    pub fn hunk_rows(&self, index: usize) -> Option<HunkRows> {
        let h = self.hunks.get(index)?;
        let start = self.starts[index];
        Some(HunkRows {
            index,
            start,
            end: start + rows_of(h),
            lines: HunkLines::of(h),
        })
    }

    /// The first hunk starting after `row`, or with `forward` false the last
    /// one starting before it.
    pub fn hunk_from(&self, row: u64, forward: bool) -> Option<HunkRows> {
        let after = self.starts.partition_point(|&s| s <= row);
        let index = if forward {
            after
        } else {
            self.starts.partition_point(|&s| s < row).checked_sub(1)?
        };
        self.hunk_rows(index)
    }

    /// The hunk nearest `row`, if it is within `reach` rows of it: for a click
    /// on the overview, where a hunk of one row in millions is a line.
    pub fn hunk_near(&self, row: u64, reach: u64) -> Option<HunkRows> {
        let after = self.starts.partition_point(|&s| s <= row);
        let distance = |h: &HunkRows| {
            if row < h.start {
                h.start - row
            } else {
                (row + 1).saturating_sub(h.end)
            }
        };
        // Only the one starting at or before it and the one after can be nearest.
        [after.checked_sub(1), Some(after)]
            .into_iter()
            .flatten()
            .filter_map(|index| self.hunk_rows(index))
            .min_by_key(distance)
            .filter(|h| distance(h) <= reach)
    }

    /// The hunk that `row` is in.
    pub fn hunk_at(&self, row: u64) -> Option<usize> {
        match self.place(row) {
            Place::Hunk { index, .. } => Some(index),
            Place::Equal { .. } => None,
        }
    }

    /// Rows `top..top + count`, as many as there are.
    pub fn view(&self, top: u64, count: usize) -> io::Result<CompareView> {
        let total = self.rows();
        let top = top.min(total.saturating_sub(1));
        let end = (top + count as u64).min(total);
        let places: Vec<RowLines> = (top..end)
            .map(|row| match self.place(row) {
                Place::Equal { left, right } => (None, Some(left), Some(right)),
                Place::Hunk { index, row } => {
                    let h = &self.hunks[index];
                    let line =
                        |start: usize, len: usize| (row < len as u64).then_some(start as u64 + row);
                    (
                        Some(index),
                        line(h.a_start, h.a_len()),
                        line(h.b_start, h.b_len()),
                    )
                }
            })
            .collect();
        let read = |side: Side, pick: fn(&RowLines) -> Option<u64>| {
            let lines: Vec<u64> = places.iter().filter_map(pick).collect();
            read_lines(&self.texts[side.index()], &lines, self.lines(side))
        };
        let mut left_lines = read(Side::Left, |p| p.1)?.into_iter();
        let mut right_lines = read(Side::Right, |p| p.2)?.into_iter();
        let mut rows = Vec::with_capacity(places.len());
        for &(hunk, l, r) in &places {
            let mut left = l.map(|line| (line, left_lines.next().expect("read")));
            let mut right = r.map(|line| (line, right_lines.next().expect("read")));
            let mut marks = (Vec::new(), Vec::new());
            if let (Some(_), Some((_, a)), Some((_, b))) = (hunk, &left, &right) {
                let (ma, mb) = hu_diff::inline(&a.1, &b.1);
                marks = (units(&ma, a), units(&mb, b));
            }
            let line = |side: Option<(u64, ReadLine)>, marks: Vec<[u32; 2]>| {
                side.map(|(line, (view, _))| CompareLine {
                    line,
                    text: view.text,
                    truncated: view.truncated,
                    marks,
                })
            };
            rows.push(CompareRow {
                hunk,
                left: line(left.take(), marks.0),
                right: line(right.take(), marks.1),
            });
        }
        let mut lines = HunkLines::default();
        for one in self.hunks.iter().map(HunkLines::of) {
            lines.changed += one.changed;
            lines.only_left += one.only_left;
            lines.only_right += one.only_right;
        }
        Ok(CompareView {
            top,
            total,
            hunks: self.hunks.len(),
            lines,
            rows,
        })
    }

    /// The kind of rows in each of `buckets` equal stretches of all the rows:
    /// 0 or an `OVERVIEW_` value, `OVERVIEW_CHANGED` where kinds mix.
    pub fn overview(&self, buckets: usize) -> Vec<u8> {
        let mut out = vec![0; buckets];
        if buckets == 0 {
            return out;
        }
        let total = self.rows().max(1) as u128;
        // The buckets that rows `start..end` cover, each at least partly.
        let covered = |start: u64, end: u64| {
            let first = (start as u128 * buckets as u128 / total) as usize;
            let past = (end as u128 * buckets as u128).div_ceil(total) as usize;
            first.min(buckets - 1)..past.clamp(first + 1, buckets)
        };
        for (h, &start) in self.hunks.iter().zip(&self.starts) {
            // As its rows show: the lines paired from the top changed, the rest on one side only.
            let lines = HunkLines::of(h);
            let alone = if lines.only_left > 0 {
                OVERVIEW_LEFT
            } else {
                OVERVIEW_RIGHT
            };
            let paired = start + lines.changed;
            for (from, to, kind) in [
                (start, paired, OVERVIEW_CHANGED),
                (paired, start + rows_of(h), alone),
            ] {
                if from == to {
                    continue;
                }
                for one in &mut out[covered(from, to)] {
                    *one = if *one == 0 || *one == kind {
                        kind
                    } else {
                        OVERVIEW_CHANGED
                    };
                }
            }
        }
        out
    }

    /// The edit that makes the lines of hunk `index` on side `to` what they
    /// are on the other side.
    pub fn merge(&self, index: usize, to: Side) -> io::Result<Merge> {
        let h = self
            .hunks
            .get(index)
            .ok_or_else(|| io::Error::other("no such hunk"))?;
        let (from_range, to_range) = match to {
            Side::Right => (h.a_start..h.a_end, h.b_start..h.b_end),
            Side::Left => (h.b_start..h.b_end, h.a_start..h.a_end),
        };
        let text = self.copy_lines(to.other(), from_range.clone())?;
        let (t, count) = (to, self.lines(to));
        let (start, end) = (to_range.start as u64, to_range.end as u64);
        Ok(match (from_range.is_empty(), to_range.is_empty()) {
            (false, false) => Merge {
                start: self.line_start(t, start)?,
                end: self.content_end(t, end - 1)?,
                text,
            },
            (false, true) if start < count => {
                let at = self.line_start(t, start)?;
                Merge {
                    start: at,
                    end: at,
                    text: text + "\n",
                }
            }
            (false, true) => {
                let at = self.texts[t.index()].len();
                Merge {
                    start: at,
                    end: at,
                    text: format!("\n{text}"),
                }
            }
            (true, _) if end < count => Merge {
                start: self.line_start(t, start)?,
                end: self.line_start(t, end)?,
                text,
            },
            (true, _) if start > 0 => Merge {
                start: self.content_end(t, start - 1)?,
                end: self.texts[t.index()].len(),
                text,
            },
            (true, _) => Merge {
                start: 0,
                end: self.texts[t.index()].len(),
                text,
            },
        })
    }

    /// Takes `text`, the document on `side` as it is now, comparing again
    /// what changed since the last one.
    pub fn sync(&mut self, side: Side, text: Text) -> io::Result<()> {
        let s = side.index();
        let old = std::mem::replace(&mut self.texts[s], text);
        let new = &self.texts[s];
        let (head, tail) = old.common_ends(new);
        if head == old.len() && head == new.len() {
            return Ok(());
        }
        let line = |text: &Text, offset: u64| -> io::Result<u64> {
            text.line_number(offset)?.ok_or_else(|| not_indexed(text))
        };
        let first = line(new, head)?;
        let old_last = line(&old, old.len() - tail)?;
        let new_last = line(new, new.len() - tail)?;
        let start = new.line_offset(first)?.ok_or_else(|| not_indexed(new))?;
        let never = AtomicBool::new(false);
        let fresh = hash_lines(new, start, new_last - first + 1, CHUNK, &never, &mut |_| {})?
            .expect("not cancelled");
        self.hashes[s].splice(first as usize..=old_last as usize, fresh);
        self.compare_again(
            side,
            first as usize,
            old_last as usize + 1,
            new_last as i64 - old_last as i64,
        );
        Ok(())
    }

    /// Lines `start..end` of `side` (before the change) changed into
    /// `start..end + delta`: compares them, with the hunks they touch,
    /// against what they lined up with.
    fn compare_again(&mut self, side: Side, start: usize, end: usize, delta: i64) {
        let own = |h: &Hunk| match side {
            Side::Left => (h.a_start, h.a_end),
            Side::Right => (h.b_start, h.b_end),
        };
        let across = |h: &Hunk| match side {
            Side::Left => (h.b_start, h.b_end),
            Side::Right => (h.a_start, h.a_end),
        };
        let first = self.hunks.partition_point(|h| own(h).1 < start);
        let last = self.hunks.partition_point(|h| own(h).0 <= end);
        let mut start = start;
        let mut end = end;
        if first < last {
            start = start.min(own(&self.hunks[first]).0);
            end = end.max(own(&self.hunks[last - 1]).1);
        }
        // Where the stretch starts and ends across: equal lines line up.
        let lined_up =
            |at: usize, before: usize| match before.checked_sub(1).map(|i| &self.hunks[i]) {
                Some(h) => across(h).1 + (at - own(h).1),
                None => at,
            };
        let (across_start, across_end) = (lined_up(start, first), lined_up(end, last));
        let new_end = (end as i64 + delta) as usize;
        let (s, o) = (side.index(), side.other().index());
        let (own_lines, across_lines) = (
            &self.hashes[s][start..new_end],
            &self.hashes[o][across_start..across_end],
        );
        let found = match side {
            Side::Left => hu_diff::diff(own_lines, across_lines, &AtomicBool::new(false)),
            Side::Right => hu_diff::diff(across_lines, own_lines, &AtomicBool::new(false)),
        };
        let (a_at, b_at) = match side {
            Side::Left => (start, across_start),
            Side::Right => (across_start, start),
        };
        let found: Vec<Hunk> = found
            .expect("not cancelled")
            .into_iter()
            .map(|h| Hunk {
                a_start: h.a_start + a_at,
                a_end: h.a_end + a_at,
                b_start: h.b_start + b_at,
                b_end: h.b_end + b_at,
            })
            .collect();
        let added = found.len();
        self.hunks.splice(first..last, found);
        let shift = |at: &mut usize| *at = (*at as i64 + delta) as usize;
        for h in &mut self.hunks[first + added..] {
            match side {
                Side::Left => (shift(&mut h.a_start), shift(&mut h.a_end)),
                Side::Right => (shift(&mut h.b_start), shift(&mut h.b_end)),
            };
        }
        self.place_hunks(first);
    }

    /// Finds the row each hunk from `from` on starts at.
    fn place_hunks(&mut self, from: usize) {
        self.starts.truncate(from);
        let mut extra = match from.checked_sub(1) {
            Some(i) => self.starts[i] + rows_of(&self.hunks[i]) - self.hunks[i].a_end as u64,
            None => 0,
        };
        for h in &self.hunks[from..] {
            self.starts.push(h.a_start as u64 + extra);
            extra += rows_of(h) - h.a_len() as u64;
        }
    }

    fn place(&self, row: u64) -> Place {
        let after = self.starts.partition_point(|&s| s <= row);
        let Some(index) = after.checked_sub(1) else {
            return Place::Equal {
                left: row,
                right: row,
            };
        };
        let (h, start) = (&self.hunks[index], self.starts[index]);
        if row < start + rows_of(h) {
            return Place::Hunk {
                index,
                row: row - start,
            };
        }
        let past = row - start - rows_of(h);
        Place::Equal {
            left: h.a_end as u64 + past,
            right: h.b_end as u64 + past,
        }
    }

    fn line_start(&self, side: Side, line: u64) -> io::Result<u64> {
        let text = &self.texts[side.index()];
        text.line_offset(line)?.ok_or_else(|| not_indexed(text))
    }

    /// Where the content of `line` ends, before its line break.
    fn content_end(&self, side: Side, line: u64) -> io::Result<u64> {
        let text = &self.texts[side.index()];
        if line + 1 >= self.lines(side) {
            return Ok(text.len());
        }
        let next = self.line_start(side, line + 1)?;
        let cr = next >= 2 && text.read_range(next - 2, next - 1)? == b"\r";
        Ok(next - 1 - cr as u64)
    }

    /// Lines `range` of `side`, decoded, joined by `\n`.
    fn copy_lines(&self, side: Side, range: Range<usize>) -> io::Result<String> {
        if range.is_empty() {
            return Ok(String::new());
        }
        let text = &self.texts[side.index()];
        let start = self.line_start(side, range.start as u64)?;
        let end = self.content_end(side, range.end as u64 - 1)?;
        if end - start > MAX_COPY {
            return Err(Problem::TooLargeToCopy {
                size_mb: (end - start) >> 20,
                limit_mb: MAX_COPY >> 20,
            }
            .into());
        }
        let bytes = text.read_range(start, end)?;
        let lines: Vec<String> = bytes
            .split(|&b| b == b'\n')
            .map(|line| decode_line(line.strip_suffix(b"\r").unwrap_or(line), text.decoding).text)
            .collect();
        Ok(lines.join("\n"))
    }
}

fn rows_of(h: &Hunk) -> u64 {
    h.a_len().max(h.b_len()) as u64
}

fn not_indexed(text: &Text) -> io::Error {
    Problem::NotIndexed {
        lines: text.known_newlines().unwrap_or(0),
    }
    .into()
}

type ReadLine = (crate::text::ViewLine, Vec<u8>);

/// A row's hunk, if any, and its line on each side, if any.
type RowLines = (Option<usize>, Option<u64>, Option<u64>);

/// Lines `lines` (in order, mostly one after another) of a text with
/// `count` lines, read for the view.
fn read_lines(text: &Text, lines: &[u64], count: u64) -> io::Result<Vec<ReadLine>> {
    let mut out = Vec::with_capacity(lines.len());
    // The line read last and where the one after it starts.
    let mut next: Option<(u64, u64)> = None;
    for &line in lines {
        let start = match next {
            Some((after, at)) if after + 1 == line => at,
            _ => text.line_offset(line)?.ok_or_else(|| not_indexed(text))?,
        };
        let (content_end, following) = text.line_bounds(start)?;
        let at = match following {
            // A line too long to scan is broken there: its own end is in the index.
            Some(at) if at == content_end && line + 1 < count => text
                .line_offset(line + 1)?
                .ok_or_else(|| not_indexed(text))?,
            Some(at) => at,
            None => text.len(),
        };
        out.push(text.view_line_and_bytes(start, content_end)?);
        next = Some((line, at));
    }
    Ok(out)
}

/// Byte ranges of a line read as UTF-16 ranges of its text.
fn units(ranges: &[Range<usize>], line: &ReadLine) -> Vec<[u32; 2]> {
    let (view, bytes) = line;
    let unit = |byte: usize| -> u32 {
        match &view.char_starts {
            None => byte.min(bytes.len()) as u32,
            Some(starts) => starts
                .partition_point(|&s| (s as usize) < byte)
                .min(starts.len() - 1) as u32,
        }
    };
    ranges
        .iter()
        .map(|r| [unit(r.start), unit(r.end)])
        .collect()
}

/// The hash of each line from `start` (a line start) on, at most `limit` of
/// them, reading `chunk` bytes at a time and reporting the bytes read. The
/// last line of a text counts even when empty, after a final line break.
/// `None` once cancelled.
fn hash_lines(
    text: &Text,
    start: u64,
    limit: u64,
    chunk: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> io::Result<Option<Vec<u64>>> {
    let len = text.len();
    let mut out = Vec::new();
    let mut buf = vec![0; chunk.min((len - start) as usize).max(1)];
    // A line begun in an earlier chunk, hashed so far but for a `\r` that
    // may be its break's.
    let mut hasher = Xxh3::new();
    let (mut begun, mut cr) = (false, false);
    let mut pos = start;
    while pos < len && (out.len() as u64) < limit {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let n = buf.len().min((len - pos) as usize);
        text.read_at(pos, &mut buf[..n])?;
        let bytes = &buf[..n];
        let mut from = 0;
        for lf in memchr::memchr_iter(b'\n', bytes) {
            let line = &bytes[from..lf];
            let hash = if begun {
                if cr && !line.is_empty() {
                    hasher.update(b"\r");
                }
                hasher.update(line.strip_suffix(b"\r").unwrap_or(line));
                begun = false;
                hasher.digest()
            } else {
                xxh3_64(line.strip_suffix(b"\r").unwrap_or(line))
            };
            out.push(hash);
            from = lf + 1;
            if out.len() as u64 == limit {
                return Ok(Some(out));
            }
        }
        let rest = &bytes[from..];
        if !rest.is_empty() {
            if !begun {
                hasher.reset();
                (begun, cr) = (true, false);
            }
            if cr {
                hasher.update(b"\r");
            }
            cr = rest.ends_with(b"\r");
            hasher.update(rest.strip_suffix(b"\r").unwrap_or(rest));
        }
        pos += n as u64;
        progress(pos - start);
    }
    if (out.len() as u64) < limit {
        // The last line, without a break: what is begun, or empty.
        out.push(if begun { hasher.digest() } else { xxh3_64(b"") });
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests;
