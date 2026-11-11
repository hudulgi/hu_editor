//! A read-only snapshot of a document: its pieces, plus the original file
//! and the added text they point into. Every read the editor does (the
//! viewport, line numbers, navigation, search, save) goes through here, so
//! it always sees the edited text.
//!
//! Queries are addressed by byte offset, so scrolling and jumping never wait
//! for the background line index; line numbers appear once it gets there.

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::decode::{Converter, Decoding, Encoding, column_range, decode_line};
use crate::original::Original;
use crate::pieces::{Added, Pieces, Source};
use crate::problem::Problem;
use crate::search::{self, FindOptions, FindResult, Reader};

/// Lines longer than this are broken for display, so a file without line
/// feeds cannot make a single navigation step scan gigabytes.
const MAX_LINE_SCAN: u64 = 1 << 20;
/// At most this many bytes of a line are sent to the view.
const MAX_LINE_DISPLAY: u64 = 16 * 1024;
const COPY_CHUNK: usize = 8 << 20;
/// A box (column) selection spans at most this many lines.
pub const MAX_BOX_LINES: usize = 1_000_000;

/// Which lines a box selection covers, from its top line.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BoxRows {
    /// Down to the line starting at `bottom`.
    Until { bottom: u64 },
    /// This many lines, or as many as there are.
    Count { count: usize },
}

/// One line of a box selection: the bytes it covers, and the spaces missing
/// up to its left edge when the line is shorter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxLine {
    pub line: u64,
    pub start: u64,
    pub end: u64,
    pub pad: u32,
}

/// Where the viewport should go.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ViewTarget {
    /// `delta` lines from the line containing `anchor`.
    Scroll { anchor: u64, delta: i64 },
    /// Relative position: 0.0 is the top of the file, 1.0 the last page.
    Fraction { fraction: f64 },
    /// 0-based line number; needs the line index to have reached it.
    Line { line: u64 },
    /// The line containing `offset`, shown `context` lines below the top.
    Offset { offset: u64, context: u32 },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// Offset of the first displayed line.
    pub top: u64,
    /// `top` of the last page; the scrollbar position is `top / max_top`.
    pub max_top: u64,
    /// Offset just past the last displayed line.
    pub end: u64,
    /// Document length.
    pub len: u64,
    /// 0-based line number of `top`, once the line index has reached it.
    pub first_line: Option<u64>,
    pub lines: Vec<ViewLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewLine {
    pub offset: u64,
    /// Bytes of content, without the line terminator.
    pub len: u64,
    pub text: String,
    /// Byte offset in the line of each UTF-16 unit of `text`, plus `len`;
    /// `None` for ASCII lines, where the two are the same.
    pub char_starts: Option<Vec<u32>>,
    /// The line was cut at `MAX_LINE_DISPLAY` bytes.
    pub truncated: bool,
}

#[derive(Clone)]
pub struct Text {
    pub(crate) pieces: Pieces,
    pub(crate) original: Original,
    pub(crate) added: Arc<Added>,
    pub(crate) decoding: Decoding,
}

impl Text {
    pub fn len(&self) -> u64 {
        self.pieces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pieces.is_empty()
    }

    pub fn view(&self, target: ViewTarget, rows: usize) -> io::Result<View> {
        let rows = rows.max(1);
        let max_top = self.last_page_top(rows)?;
        let top = match target {
            ViewTarget::Scroll { anchor, delta } => {
                self.move_lines(self.line_start(anchor)?, delta)?
            }
            ViewTarget::Fraction { fraction } if fraction >= 1.0 => max_top,
            ViewTarget::Fraction { fraction } => {
                self.line_start((max_top as f64 * fraction.max(0.0)) as u64)?
            }
            ViewTarget::Line { line } => match self.line_offset(line)? {
                Some(offset) => offset,
                None if self.original.index.read().unwrap().status(0).complete => max_top,
                None => {
                    return Err(Problem::NotIndexed {
                        lines: self.known_newlines()?,
                    }
                    .into());
                }
            },
            ViewTarget::Offset { offset, context } => {
                self.move_lines(self.line_start(offset)?, -i64::from(context))?
            }
        }
        .min(max_top);

        let mut lines = Vec::with_capacity(rows);
        let mut start = top;
        let end = loop {
            let (content_end, next) = self.line_bounds(start)?;
            lines.push(self.view_line(start, content_end)?);
            match next {
                Some(next) if lines.len() < rows => start = next,
                _ => break next.unwrap_or(content_end),
            }
        };
        Ok(View {
            top,
            max_top,
            end,
            len: self.len(),
            first_line: self.line_number(top)?,
            lines,
        })
    }

    fn view_line(&self, start: u64, content_end: u64) -> io::Result<ViewLine> {
        Ok(self.view_line_and_bytes(start, content_end)?.0)
    }

    /// A line for the view, and the bytes it shows.
    pub(crate) fn view_line_and_bytes(
        &self,
        start: u64,
        content_end: u64,
    ) -> io::Result<(ViewLine, Vec<u8>)> {
        let truncated = content_end - start > MAX_LINE_DISPLAY;
        let mut bytes = self.read_range(start, content_end.min(start + MAX_LINE_DISPLAY))?;
        let mut len = content_end - start;
        if !truncated && bytes.last() == Some(&b'\r') {
            bytes.pop();
            len -= 1;
        }
        let decoded = decode_line(&bytes, self.decoding);
        let line = ViewLine {
            offset: start,
            len,
            text: decoded.text,
            char_starts: decoded.starts,
            truncated,
        };
        Ok((line, bytes))
    }

    /// The bytes `self` and `other`, two snapshots of one document, have in
    /// common at the start and at the end, from their pieces alone: what
    /// lies where it was. Text deleted and typed again counts as changed.
    pub(crate) fn common_ends(&self, other: &Text) -> (u64, u64) {
        let same = |a: &crate::pieces::Piece, b: &crate::pieces::Piece| a.source == b.source;
        let (pa, pb) = (self.pieces.pieces(), other.pieces.pieces());
        // From the start: (piece, bytes into it) on each side.
        let (mut i, mut j, mut ia, mut jb, mut head) = (0, 0, 0, 0, 0);
        while i < pa.len() && j < pb.len() {
            let (a, b) = (&pa[i], &pb[j]);
            if !same(a, b) || a.start + ia != b.start + jb {
                break;
            }
            let step = (a.len - ia).min(b.len - jb);
            head += step;
            ia += step;
            jb += step;
            if ia == a.len {
                (i, ia) = (i + 1, 0);
            }
            if jb == b.len {
                (j, jb) = (j + 1, 0);
            }
        }
        // From the end, not into the head: (pieces left, bytes left of the last).
        let room = self.len().min(other.len()) - head;
        let (mut i, mut j) = (pa.len(), pb.len());
        let (mut ia, mut jb, mut tail) = (0, 0, 0);
        while i > 0 && j > 0 && tail < room {
            let (a, b) = (&pa[i - 1], &pb[j - 1]);
            if !same(a, b) || a.end() - ia != b.end() - jb {
                break;
            }
            let step = (a.len - ia).min(b.len - jb).min(room - tail);
            tail += step;
            ia += step;
            jb += step;
            if ia == a.len {
                (i, ia) = (i - 1, 0);
            }
            if jb == b.len {
                (j, jb) = (j - 1, 0);
            }
        }
        (head, tail)
    }

    /// 0-based line number of the line containing `offset`, once known.
    pub fn line_number(&self, offset: u64) -> io::Result<Option<u64>> {
        let i = self.pieces.index_of(offset);
        let mut line = 0;
        for piece in &self.pieces.pieces()[..i] {
            let Some(n) = piece.newlines else {
                return Ok(None);
            };
            line += n;
        }
        let Some(piece) = self.pieces.pieces().get(i) else {
            return Ok(Some(line));
        };
        let into = offset - self.pieces.starts()[i];
        let partial = match piece.source {
            Source::Original => self.original.newlines_in(piece.start, piece.start + into)?,
            Source::Added => Some(self.added.newlines(piece.start, piece.start + into)),
        };
        Ok(partial.map(|p| line + p))
    }

    /// Start offset of 0-based line `line`; `None` if the line is beyond
    /// what is known (or beyond the end).
    pub fn line_offset(&self, line: u64) -> io::Result<Option<u64>> {
        if line == 0 {
            return Ok(Some(0));
        }
        // Line `n` starts right after the `n`-th line feed.
        let mut before = 0;
        for (piece, &start) in self.pieces.pieces().iter().zip(self.pieces.starts()) {
            let Some(n) = piece.newlines else {
                return Ok(None);
            };
            if before + n >= line {
                let k = line - before;
                let found = match piece.source {
                    Source::Original => match self.original.newlines_before(piece.start)? {
                        Some(base) => self.original.after_newline(base + k)?,
                        None => None,
                    },
                    Source::Added => self.added.read(piece.start, piece.end(), |bytes| {
                        memchr::memchr_iter(b'\n', bytes)
                            .nth(k as usize - 1)
                            .map(|i| piece.start + i as u64 + 1)
                    }),
                };
                return Ok(found.map(|end| start + (end - piece.start)));
            }
            before += n;
        }
        Ok(None)
    }

    /// Line feeds whose position is known so far: all of them once the
    /// line index is complete.
    pub fn known_newlines(&self) -> io::Result<u64> {
        let mut total = 0;
        for piece in self.pieces.pieces() {
            match piece.newlines {
                Some(n) => total += n,
                None => {
                    let scanned = self.original.scanned();
                    if piece.source == Source::Original && scanned > piece.start {
                        let end = scanned.min(piece.end());
                        total += self.original.newlines_in(piece.start, end)?.unwrap_or(0);
                    }
                    break;
                }
            }
        }
        Ok(total)
    }

    pub fn all_newlines_known(&self) -> bool {
        !self.pieces.has_unknown_newlines()
    }

    /// Start of the line containing `offset`.
    pub fn line_start(&self, offset: u64) -> io::Result<u64> {
        let offset = offset.min(self.len());
        let floor = offset.saturating_sub(MAX_LINE_SCAN);
        Ok(match self.rfind_newline(floor, offset)? {
            Some(lf) => lf + 1,
            None => floor,
        })
    }

    /// Moves `delta` lines from the line starting at `start`, stopping at the
    /// first and last line.
    pub fn move_lines(&self, mut start: u64, delta: i64) -> io::Result<u64> {
        for _ in 0..delta.unsigned_abs() {
            let next = if delta > 0 {
                self.line_bounds(start)?.1
            } else if start > 0 {
                Some(self.line_start(start - 1)?)
            } else {
                None
            };
            match next {
                Some(next) => start = next,
                None => break,
            }
        }
        Ok(start)
    }

    /// `top` of the last full page of `rows` lines.
    pub fn last_page_top(&self, rows: usize) -> io::Result<u64> {
        let last = self.line_start(self.len())?;
        self.move_lines(last, -(rows.saturating_sub(1) as i64))
    }

    /// End of the content of the line starting at `start` (at its line feed,
    /// or at the end of the text), and where the next line starts.
    pub fn line_bounds(&self, start: u64) -> io::Result<(u64, Option<u64>)> {
        let len = self.len();
        let limit = (start + MAX_LINE_SCAN).min(len);
        Ok(match self.find_newline(start, limit)? {
            Some(lf) => (lf, Some(lf + 1)),
            None if limit < len => (limit, Some(limit)),
            None => (len, None),
        })
    }

    /// The lines of a box selection from the line containing `top`, between
    /// display columns `left` and `right`.
    pub fn box_lines(
        &self,
        top: u64,
        rows: BoxRows,
        left: u32,
        right: u32,
    ) -> io::Result<Vec<BoxLine>> {
        let mut out = Vec::new();
        let mut line = self.line_start(top)?;
        loop {
            let (content_end, next) = self.line_bounds(line)?;
            let mut bytes = self.read_range(line, content_end)?;
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            let (start, end, pad) = column_range(&bytes, left, right, self.decoding);
            out.push(BoxLine {
                line,
                start: line + start as u64,
                end: line + end as u64,
                pad,
            });
            let done = match rows {
                BoxRows::Until { bottom } => line >= bottom,
                BoxRows::Count { count } => out.len() >= count,
            };
            match next {
                Some(next) if !done => line = next,
                _ => return Ok(out),
            }
            if out.len() >= MAX_BOX_LINES {
                return Err(Problem::BoxTooTall {
                    limit: MAX_BOX_LINES,
                }
                .into());
            }
        }
    }

    pub fn read_range(&self, start: u64, end: u64) -> io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        self.scan(start, end, |_, bytes| {
            out.extend_from_slice(bytes);
            None::<()>
        })?;
        Ok(out)
    }

    pub fn find(
        &self,
        needle: &[u8],
        from: u64,
        options: &FindOptions,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<FindResult> {
        search::find(self, needle, from, options, cancel, progress)
    }

    /// Writes the whole text to `out`, reporting bytes written. Returns
    /// `false` if cancelled.
    pub fn write_to(
        &self,
        out: &mut impl Write,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<bool> {
        let mut buf = vec![0; COPY_CHUNK];
        let mut written = 0;
        for piece in self.pieces.pieces() {
            let mut pos = piece.start;
            while pos < piece.end() {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(false);
                }
                let n = (piece.end() - pos).min(COPY_CHUNK as u64) as usize;
                match piece.source {
                    Source::Original => {
                        self.original.source.read_uncached(pos, &mut buf[..n])?;
                        out.write_all(&buf[..n])?;
                    }
                    Source::Added => self
                        .added
                        .read(pos, pos + n as u64, |bytes| out.write_all(bytes))?,
                }
                pos += n as u64;
                written += n as u64;
                progress(written);
            }
        }
        Ok(true)
    }

    /// Writes the whole text to `out` converted between encodings, reporting
    /// bytes read. Returns `false` if cancelled.
    pub fn write_converted(
        &self,
        from: Encoding,
        to: Encoding,
        out: &mut impl Write,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<bool> {
        let mut converter = Converter::new(from, to);
        let mut buf = vec![0; COPY_CHUNK];
        let len = self.len();
        let mut pos = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let n = (len - pos).min(COPY_CHUNK as u64) as usize;
            self.read_at(pos, &mut buf[..n])?;
            pos += n as u64;
            converter.write(&buf[..n], pos == len, out)?;
            progress(pos);
            if pos == len {
                return Ok(true);
            }
        }
    }

    /// Feeds consecutive slices covering `[from, to)` to `f`, with the offset
    /// of each, until it returns `Some`.
    fn scan<T>(
        &self,
        from: u64,
        to: u64,
        mut f: impl FnMut(u64, &[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let to = to.min(self.len());
        let (pieces, starts) = (self.pieces.pieces(), self.pieces.starts());
        let mut i = self.pieces.index_of(from);
        let mut pos = from;
        while pos < to {
            let (piece, base) = (pieces[i], starts[i]);
            let a = piece.start + (pos - base);
            let b = piece.start + (to.min(base + piece.len) - base);
            let found = match piece.source {
                Source::Original => self
                    .original
                    .source
                    .scan(a, b, |o, s| f(base + (o - piece.start), s))?,
                Source::Added => self.added.read(a, b, |s| f(pos, s)),
            };
            if found.is_some() {
                return Ok(found);
            }
            pos = base + piece.len;
            i += 1;
        }
        Ok(None)
    }

    /// Like [`scan`](Self::scan), from the end of the range backward.
    fn scan_rev<T>(
        &self,
        from: u64,
        to: u64,
        mut f: impl FnMut(u64, &[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let to = to.min(self.len());
        if to <= from {
            return Ok(None);
        }
        let (pieces, starts) = (self.pieces.pieces(), self.pieces.starts());
        let mut i = self.pieces.index_of(to - 1);
        let mut end = to;
        loop {
            let (piece, base) = (pieces[i], starts[i]);
            let lo = from.max(base);
            let a = piece.start + (lo - base);
            let b = piece.start + (end - base);
            let found = match piece.source {
                Source::Original => self
                    .original
                    .source
                    .scan_rev(a, b, |o, s| f(base + (o - piece.start), s))?,
                Source::Added => self.added.read(a, b, |s| f(lo, s)),
            };
            if found.is_some() {
                return Ok(found);
            }
            if lo == from {
                return Ok(None);
            }
            end = base;
            i -= 1;
        }
    }

    /// First line feed in `[from, to)`.
    fn find_newline(&self, from: u64, to: u64) -> io::Result<Option<u64>> {
        self.scan(from, to, |pos, bytes| {
            memchr::memchr(b'\n', bytes).map(|i| pos + i as u64)
        })
    }

    /// Last line feed in `[from, to)`.
    fn rfind_newline(&self, from: u64, to: u64) -> io::Result<Option<u64>> {
        self.scan_rev(from, to, |pos, bytes| {
            memchr::memrchr(b'\n', bytes).map(|i| pos + i as u64)
        })
    }
}

impl Reader for Text {
    fn len(&self) -> u64 {
        self.pieces.len()
    }

    /// Reads past the block cache: used for long sequential scans.
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        let (pieces, starts) = (self.pieces.pieces(), self.pieces.starts());
        let mut i = self.pieces.index_of(offset);
        let mut pos = offset;
        let mut filled = 0;
        while filled < buf.len() {
            let Some(&piece) = pieces.get(i) else {
                return Err(io::ErrorKind::UnexpectedEof.into());
            };
            let a = piece.start + (pos - starts[i]);
            let n = ((piece.end() - a) as usize).min(buf.len() - filled);
            let dest = &mut buf[filled..filled + n];
            match piece.source {
                Source::Original => self.original.source.read_uncached(a, dest)?,
                Source::Added => self
                    .added
                    .read(a, a + n as u64, |s| dest.copy_from_slice(s)),
            }
            filled += n;
            pos += n as u64;
            i += 1;
        }
        Ok(())
    }
}
