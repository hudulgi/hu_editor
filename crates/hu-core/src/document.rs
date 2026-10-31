//! An open file: disk-backed source, background line index, and the
//! viewport queries the UI needs.
//!
//! Every query is addressed by byte offset, so scrolling and jumping never
//! wait for the line index; line numbers simply appear once the index has
//! reached them.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use std::{fmt, thread};

use serde::{Deserialize, Serialize};

use crate::line_index::{self, IndexStatus, LineIndex};
use crate::search::{self, FindOptions, FindResult};
use crate::source::{BLOCK_SIZE, FileSource};
use crate::text;

/// Lines longer than this are broken for display, so a file without line
/// feeds cannot make a single navigation step scan gigabytes.
const MAX_LINE_SCAN: u64 = 1 << 20;
/// At most this many bytes of a line are sent to the view.
const MAX_LINE_DISPLAY: u64 = 16 * 1024;

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

/// A byte range to highlight, e.g. a search match.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Mark {
    pub offset: u64,
    pub len: u64,
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
    /// 0-based line number of `top`, once the line index has reached it.
    pub first_line: Option<u64>,
    pub lines: Vec<ViewLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewLine {
    pub offset: u64,
    pub text: String,
    /// The line was cut at `MAX_LINE_DISPLAY` bytes.
    pub truncated: bool,
    /// Highlighted ranges as UTF-16 indices into `text`.
    pub marks: Vec<(u32, u32)>,
}

#[derive(Debug)]
pub enum ViewError {
    Io(io::Error),
    /// A line number beyond what the background index has reached.
    NotIndexed {
        lines: u64,
    },
}

impl fmt::Display for ViewError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ViewError::Io(e) => e.fmt(f),
            ViewError::NotIndexed { lines } => {
                write!(f, "line index has only reached line {lines} so far")
            }
        }
    }
}

impl std::error::Error for ViewError {}

impl From<io::Error> for ViewError {
    fn from(e: io::Error) -> Self {
        ViewError::Io(e)
    }
}

pub struct Document {
    source: Arc<FileSource>,
    index: Arc<RwLock<LineIndex>>,
    cancel: Arc<AtomicBool>,
}

impl Document {
    /// Opens `path` without reading it; the line index is built on a
    /// background thread.
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let source = Arc::new(FileSource::open(path.as_ref())?);
        let index = Arc::new(RwLock::new(LineIndex::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let (source, index, cancel) = (source.clone(), index.clone(), cancel.clone());
            thread::Builder::new()
                .name("line-index".into())
                .spawn(move || line_index::build(&source, &index, &cancel))?;
        }
        Ok(Self {
            source,
            index,
            cancel,
        })
    }

    pub fn path(&self) -> &Path {
        self.source.path()
    }

    pub fn len(&self) -> u64 {
        self.source.len()
    }

    pub fn is_empty(&self) -> bool {
        self.source.is_empty()
    }

    pub fn changed_on_disk(&self) -> bool {
        self.source.changed_on_disk()
    }

    pub fn index_status(&self) -> IndexStatus {
        self.index.read().unwrap().status(self.len())
    }

    /// Blocks until the background line index is finished (benchmarks, tests).
    pub fn wait_for_index(&self) -> IndexStatus {
        loop {
            let status = self.index_status();
            if status.complete || status.error.is_some() {
                return status;
            }
            thread::sleep(Duration::from_millis(2));
        }
    }

    pub fn view(&self, target: ViewTarget, rows: usize, marks: &[Mark]) -> Result<View, ViewError> {
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
            ViewTarget::Line { line } => {
                self.line_offset(line)?
                    .ok_or_else(|| ViewError::NotIndexed {
                        lines: self.index_status().lines,
                    })?
            }
            ViewTarget::Offset { offset, context } => {
                self.move_lines(self.line_start(offset)?, -i64::from(context))?
            }
        }
        .min(max_top);

        let mut lines = Vec::with_capacity(rows);
        let mut start = top;
        let end = loop {
            let (content_end, next) = self.line_bounds(start)?;
            lines.push(self.view_line(start, content_end, marks)?);
            match next {
                Some(next) if lines.len() < rows => start = next,
                _ => break next.unwrap_or(content_end),
            }
        };
        Ok(View {
            top,
            max_top,
            end,
            first_line: self.line_number(top)?,
            lines,
        })
    }

    pub fn find(
        &self,
        needle: &[u8],
        from: u64,
        options: &FindOptions,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<FindResult> {
        search::find(&self.source, needle, from, options, cancel, progress)
    }

    /// 0-based line number of the line containing `offset`, once the index
    /// has reached it.
    pub fn line_number(&self, offset: u64) -> io::Result<Option<u64>> {
        let Some((line, checkpoint)) = self.index.read().unwrap().checkpoint_for_offset(offset)
        else {
            return Ok(None);
        };
        Ok(Some(line + self.count_newlines(checkpoint, offset)?))
    }

    /// Start offset of 0-based line `line`, once the index has reached it.
    pub fn line_offset(&self, line: u64) -> io::Result<Option<u64>> {
        let Some((checkpoint, skip)) = self.index.read().unwrap().checkpoint_for_line(line) else {
            return Ok(None);
        };
        if skip == 0 {
            return Ok(Some(checkpoint));
        }
        self.after_nth_newline(checkpoint, skip)
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
    /// or at the end of the file), and where the next line starts.
    fn line_bounds(&self, start: u64) -> io::Result<(u64, Option<u64>)> {
        let len = self.len();
        let limit = (start + MAX_LINE_SCAN).min(len);
        Ok(match self.find_newline(start, limit)? {
            Some(lf) => (lf, Some(lf + 1)),
            None if limit < len => (limit, Some(limit)),
            None => (len, None),
        })
    }

    fn view_line(&self, start: u64, content_end: u64, marks: &[Mark]) -> io::Result<ViewLine> {
        let truncated = content_end - start > MAX_LINE_DISPLAY;
        let mut bytes = self
            .source
            .read_range(start, content_end.min(start + MAX_LINE_DISPLAY))?;
        if !truncated && bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        let line = text::Line::new(&bytes);
        let shown_end = start + bytes.len() as u64;
        let marks = marks
            .iter()
            .filter_map(|mark| {
                let a = mark.offset.max(start);
                let b = (mark.offset + mark.len).min(shown_end);
                (a < b).then(|| {
                    (
                        line.utf16_index((a - start) as usize),
                        line.utf16_index((b - start) as usize),
                    )
                })
            })
            .collect();
        Ok(ViewLine {
            offset: start,
            text: line.text(),
            truncated,
            marks,
        })
    }

    /// Feeds consecutive cached slices covering `[from, to)` to `f` until it
    /// returns `Some`.
    fn scan_forward<T>(
        &self,
        from: u64,
        to: u64,
        mut f: impl FnMut(u64, &[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let mut pos = from;
        while pos < to {
            let index = pos / BLOCK_SIZE as u64;
            let block = self.source.block(index)?;
            let base = index * BLOCK_SIZE as u64;
            let lo = (pos - base) as usize;
            let hi = ((to - base) as usize).min(block.len());
            if lo >= hi {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if let Some(found) = f(pos, &block[lo..hi]) {
                return Ok(Some(found));
            }
            pos = base + hi as u64;
        }
        Ok(None)
    }

    /// First line feed in `[from, to)`.
    fn find_newline(&self, from: u64, to: u64) -> io::Result<Option<u64>> {
        self.scan_forward(from, to, |pos, bytes| {
            memchr::memchr(b'\n', bytes).map(|i| pos + i as u64)
        })
    }

    /// Last line feed in `[from, to)`.
    fn rfind_newline(&self, from: u64, to: u64) -> io::Result<Option<u64>> {
        let mut end = to;
        while end > from {
            let index = (end - 1) / BLOCK_SIZE as u64;
            let block = self.source.block(index)?;
            let base = index * BLOCK_SIZE as u64;
            let lo = from.saturating_sub(base) as usize;
            let hi = (end - base) as usize;
            if hi > block.len() {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if let Some(i) = memchr::memrchr(b'\n', &block[lo..hi]) {
                return Ok(Some(base + (lo + i) as u64));
            }
            end = base.max(from);
        }
        Ok(None)
    }

    fn count_newlines(&self, from: u64, to: u64) -> io::Result<u64> {
        let mut count = 0;
        self.scan_forward(from, to, |_, bytes| {
            count += memchr::memchr_iter(b'\n', bytes).count() as u64;
            None::<()>
        })?;
        Ok(count)
    }

    /// Offset just past the `n`-th line feed at or after `from`.
    fn after_nth_newline(&self, from: u64, n: u64) -> io::Result<Option<u64>> {
        let mut left = n;
        self.scan_forward(from, self.len(), |pos, bytes| {
            for i in memchr::memchr_iter(b'\n', bytes) {
                left -= 1;
                if left == 0 {
                    return Some(pos + i as u64 + 1);
                }
            }
            None
        })
    }
}

impl Drop for Document {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn open(content: &[u8]) -> (tempfile::NamedTempFile, Document) {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(content).unwrap();
        file.flush().unwrap();
        let doc = Document::open(file.path()).unwrap();
        doc.wait_for_index();
        (file, doc)
    }

    fn texts(view: &View) -> Vec<&str> {
        view.lines.iter().map(|l| l.text.as_str()).collect()
    }

    /// Deck-like lines of varying length, some CRLF, some with Korean comments.
    fn sample(lines: usize) -> Vec<u8> {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut out = Vec::new();
        for i in 0..lines {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            match state % 10 {
                0 => out.extend_from_slice("** 한글 주석 comment".as_bytes()),
                1 => out.extend_from_slice(b"*Element, type=C3D8R, elset=E"),
                _ => {}
            }
            out.extend(std::iter::repeat_n(
                b'0' + (i % 10) as u8,
                (state % 120) as usize,
            ));
            out.extend_from_slice(if state.is_multiple_of(7) {
                b"\r\n"
            } else {
                b"\n"
            });
        }
        out
    }

    fn line_starts(content: &[u8]) -> Vec<u64> {
        let mut starts = vec![0];
        starts.extend(memchr::memchr_iter(b'\n', content).map(|i| i as u64 + 1));
        starts
    }

    #[test]
    fn line_numbers_match_naive_scan() {
        let content = sample(5000);
        assert!(
            content.len() > BLOCK_SIZE,
            "should span several cache blocks"
        );
        let (_file, doc) = open(&content);
        let starts = line_starts(&content);

        assert_eq!(doc.index_status().lines, starts.len() as u64);
        for (line, &start) in starts.iter().enumerate() {
            assert_eq!(
                doc.line_offset(line as u64).unwrap(),
                Some(start),
                "line {line}"
            );
            assert_eq!(
                doc.line_number(start).unwrap(),
                Some(line as u64),
                "offset {start}"
            );
        }
        for (line, pair) in starts.windows(2).enumerate() {
            let mid = (pair[0] + pair[1]) / 2;
            assert_eq!(doc.line_number(mid).unwrap(), Some(line as u64));
            assert_eq!(doc.line_start(mid).unwrap(), pair[0]);
        }
        assert_eq!(doc.line_offset(starts.len() as u64).unwrap(), None);
    }

    #[test]
    fn crlf_and_no_trailing_newline() {
        let (_file, doc) = open(b"*Heading\r\n** comment\r\n*Node\r\n1, 0., 0., 0.");
        let view = doc
            .view(ViewTarget::Fraction { fraction: 0.0 }, 10, &[])
            .unwrap();
        assert_eq!(
            texts(&view),
            ["*Heading", "** comment", "*Node", "1, 0., 0., 0."]
        );
        assert_eq!((view.top, view.max_top, view.first_line), (0, 0, Some(0)));
        assert_eq!(view.end, doc.len());
        assert_eq!(doc.index_status().lines, 4);
    }

    #[test]
    fn trailing_newline_gives_empty_last_line() {
        let (_file, doc) = open(b"a\nb\n");
        let view = doc
            .view(ViewTarget::Fraction { fraction: 0.0 }, 10, &[])
            .unwrap();
        assert_eq!(texts(&view), ["a", "b", ""]);
        assert_eq!(doc.index_status().lines, 3);
    }

    #[test]
    fn empty_file() {
        let (_file, doc) = open(b"");
        let view = doc
            .view(ViewTarget::Fraction { fraction: 0.5 }, 10, &[])
            .unwrap();
        assert_eq!(texts(&view), [""]);
        let status = doc.index_status();
        assert!(status.complete);
        assert_eq!(status.lines, 1);
    }

    #[test]
    fn scrolling_and_jumps() {
        let content: Vec<String> = (0..100).map(|i| format!("line {i}")).collect();
        let (_file, doc) = open(content.join("\n").as_bytes());
        let first = |target| doc.view(target, 10, &[]).unwrap().first_line.unwrap();

        assert_eq!(
            first(ViewTarget::Scroll {
                anchor: 0,
                delta: 5
            }),
            5
        );
        assert_eq!(
            first(ViewTarget::Scroll {
                anchor: 0,
                delta: 1000
            }),
            90,
            "clamped to last page"
        );
        let last_top = doc.last_page_top(10).unwrap();
        assert_eq!(
            first(ViewTarget::Scroll {
                anchor: last_top,
                delta: -1000
            }),
            0
        );
        assert_eq!(first(ViewTarget::Fraction { fraction: 1.0 }), 90);
        assert!((40..50).contains(&first(ViewTarget::Fraction { fraction: 0.5 })));
        assert_eq!(first(ViewTarget::Line { line: 42 }), 42);
        assert_eq!(first(ViewTarget::Line { line: 99 }), 90);
        let line_50 = doc.line_offset(50).unwrap().unwrap();
        assert_eq!(
            first(ViewTarget::Offset {
                offset: line_50 + 3,
                context: 3
            }),
            47
        );

        let view = doc.view(ViewTarget::Line { line: 42 }, 10, &[]).unwrap();
        assert_eq!(view.lines.len(), 10);
        assert_eq!(view.lines[0].text, "line 42");
        assert_eq!(view.end, doc.line_offset(52).unwrap().unwrap());
    }

    #[test]
    fn marks_are_utf16_indices() {
        let content = "** 한글 주석 STEEL\n*Material, name=STEEL\n";
        let (_file, doc) = open(content.as_bytes());
        let offset = content.find("STEEL").unwrap() as u64;
        let view = doc
            .view(
                ViewTarget::Fraction { fraction: 0.0 },
                10,
                &[Mark { offset, len: 5 }],
            )
            .unwrap();
        let (a, b) = view.lines[0].marks[0];
        let utf16: Vec<u16> = view.lines[0].text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&utf16[a as usize..b as usize]).unwrap(),
            "STEEL"
        );
        assert!(view.lines[1].marks.is_empty());
    }

    #[test]
    fn cp949_lines_are_decoded() {
        let (bytes, _, _) = encoding_rs::EUC_KR.encode("** 강철 재료\n*Material, name=STEEL");
        let (_file, doc) = open(&bytes);
        let view = doc
            .view(ViewTarget::Fraction { fraction: 0.0 }, 10, &[])
            .unwrap();
        assert_eq!(texts(&view), ["** 강철 재료", "*Material, name=STEEL"]);
    }

    #[test]
    fn very_long_lines_are_broken() {
        let (_file, doc) = open(&vec![b'x'; 2 * MAX_LINE_SCAN as usize + 10]);
        let view = doc
            .view(ViewTarget::Fraction { fraction: 0.0 }, 5, &[])
            .unwrap();
        assert_eq!(view.lines.len(), 3);
        assert!(view.lines[0].truncated);
        assert_eq!(view.lines[0].text.len(), MAX_LINE_DISPLAY as usize);
        assert_eq!(view.lines[2].text.len(), 10);
    }
}
