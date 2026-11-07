//! An open file: the original on disk, the background line index, the piece
//! table of edits and their history.
//!
//! Reads go through a [`Text`] snapshot, which is cheap to take and stays
//! valid while editing goes on, so a long search or save never blocks typing.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::decode::{Decoding, Encoding};
use crate::dialect::{self, Dialect};
use crate::history::{EditKind, History};
use crate::line_index::{self, IndexStatus, LineIndex};
use crate::original::Original;
use crate::pieces::{Added, Piece, Pieces, Source, total_len};
use crate::problem::Problem;
use crate::query::{Count, MatchCount, Matcher, Query, Replacement};
use crate::search::{FindResult, Step};
use crate::source::FileSource;
use crate::text::{BoxRows, MAX_BOX_LINES, Text, View, ViewTarget};

/// Larger selections are not copied to the clipboard.
pub const MAX_COPY: u64 = 256 << 20;
/// Replace All stops at this many matches.
pub const MAX_REPLACE: usize = 2_000_000;
/// The matches marked on screen stop at this many.
pub const MAX_MARKS: usize = 10_000;
const SNIFF_LEN: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Eol {
    Lf,
    Crlf,
}

impl Eol {
    fn detect(sample: &[u8]) -> Self {
        match memchr::memchr(b'\n', sample) {
            Some(i) if i > 0 && sample[i - 1] == b'\r' => Eol::Crlf,
            Some(_) => Eol::Lf,
            None => Eol::platform(),
        }
    }

    /// The platform's line break.
    pub fn platform() -> Self {
        if cfg!(windows) { Eol::Crlf } else { Eol::Lf }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocState {
    pub len: u64,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Bumped by every change to the text.
    pub version: u64,
}

/// `[start, start + old_len)` became `[start, start + new_len)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub start: u64,
    pub old_len: u64,
    pub new_len: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub change: Change,
    /// Selection afterwards.
    pub anchor: u64,
    pub caret: u64,
    pub state: DocState,
}

struct State {
    pieces: Pieces,
    history: History,
    /// Bumped by every change to the text.
    version: u64,
}

impl State {
    fn doc_state(&self) -> DocState {
        DocState {
            len: self.pieces.len(),
            dirty: self.history.is_dirty(),
            can_undo: !self.history.undo.is_empty(),
            can_redo: !self.history.redo.is_empty(),
            version: self.version,
        }
    }
}

/// How the text is read.
#[derive(Debug, Clone, Copy)]
struct Reading {
    encoding: Encoding,
    /// The user chose it, rather than it being detected.
    chosen: bool,
    /// For lines that are not UTF-8 while not chosen.
    fallback: Encoding,
}

impl Reading {
    fn decoding(self) -> Decoding {
        if self.chosen {
            Decoding::Chosen(self.encoding)
        } else {
            Decoding::Auto(self.fallback)
        }
    }
}

/// Size and modification time of the file as last opened or saved here.
type Stamp = (u64, Option<SystemTime>);

pub struct Document {
    original: Original,
    added: Arc<Added>,
    state: RwLock<State>,
    reading: RwLock<Reading>,
    eol: Eol,
    /// Where it saves: the file it was opened from or last saved as; `None`
    /// for a new document.
    path: RwLock<Option<PathBuf>>,
    disk: Mutex<Stamp>,
    cancel: Arc<AtomicBool>,
    /// The last count of matches, for the text it was made of.
    counted: Mutex<Option<Counted>>,
}

struct Counted {
    query: Query,
    encoding: Encoding,
    version: u64,
    count: Arc<Count>,
}

impl Document {
    /// Opens `path` without reading it; the line index is built on a
    /// background thread.
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::open_as(path, None, Encoding::Cp949)
    }

    /// Opens `path` to read in `chosen`; without one, in the encoding
    /// detected, with `fallback` for what is not UTF-8.
    pub fn open_as(
        path: impl AsRef<Path>,
        chosen: Option<Encoding>,
        fallback: Encoding,
    ) -> io::Result<Self> {
        let path = path.as_ref();
        Self::from_source(
            FileSource::open(path)?,
            Some(path.to_path_buf()),
            chosen,
            fallback,
        )
    }

    /// A new, empty document with no file yet.
    pub fn untitled(encoding: Encoding, eol: Eol) -> Self {
        let mut doc = Self::from_source(FileSource::empty(), None, Some(encoding), Encoding::Cp949)
            .expect("an empty source has nothing to read");
        doc.eol = eol;
        doc
    }

    fn from_source(
        source: FileSource,
        path: Option<PathBuf>,
        chosen: Option<Encoding>,
        fallback: Encoding,
    ) -> io::Result<Self> {
        let source = Arc::new(source);
        let index = Arc::new(RwLock::new(LineIndex::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let (source, index, cancel) = (source.clone(), index.clone(), cancel.clone());
            thread::Builder::new()
                .name("line-index".into())
                .spawn(move || line_index::build(&source, &index, &cancel))?;
        }

        let mut sample = vec![0; SNIFF_LEN.min(source.len() as usize)];
        source.read_uncached(0, &mut sample)?;
        let whole = Piece {
            source: Source::Original,
            start: 0,
            len: source.len(),
            newlines: None,
        };
        Ok(Self {
            disk: Mutex::new((source.len(), source.modified())),
            original: Original { source, index },
            added: Arc::default(),
            state: RwLock::new(State {
                pieces: Pieces::new(whole),
                history: History::default(),
                version: 0,
            }),
            reading: RwLock::new(Reading {
                encoding: chosen.unwrap_or_else(|| Encoding::detect(&sample, fallback)),
                chosen: chosen.is_some(),
                fallback,
            }),
            eol: Eol::detect(&sample),
            path: RwLock::new(path),
            cancel,
            counted: Mutex::default(),
        })
    }

    /// Where it saves; `None` for a new document.
    pub fn path(&self) -> Option<PathBuf> {
        self.path.read().unwrap().clone()
    }

    /// The file was renamed or moved: it is at `path` now, and saves there.
    pub fn moved_to(&self, path: PathBuf) {
        *self.path.write().unwrap() = Some(path);
    }

    pub fn len(&self) -> u64 {
        self.state.read().unwrap().pieces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn encoding(&self) -> Encoding {
        self.reading.read().unwrap().encoding
    }

    /// Reads the same bytes in `chosen`, or back in the encoding detected,
    /// with `fallback` for what is not UTF-8. The file does not change.
    /// Refused with unsaved changes when the encoding would change: they are
    /// in the current one, and saving would mix the two.
    pub fn set_encoding(
        &self,
        chosen: Option<Encoding>,
        fallback: Encoding,
    ) -> io::Result<Encoding> {
        let encoding = match chosen {
            Some(encoding) => encoding,
            None => {
                let text = self.text();
                let sample = text.read_range(0, text.len().min(SNIFF_LEN as u64))?;
                Encoding::detect(&sample, fallback)
            }
        };
        if encoding != self.encoding() && self.state().dirty {
            return Err(Problem::UnsavedChanges.into());
        }
        *self.reading.write().unwrap() = Reading {
            encoding,
            chosen: chosen.is_some(),
            fallback,
        };
        Ok(encoding)
    }

    pub fn eol(&self) -> Eol {
        self.eol
    }

    pub fn state(&self) -> DocState {
        self.state.read().unwrap().doc_state()
    }

    /// A snapshot of the current text.
    pub fn text(&self) -> Text {
        self.snapshot().0
    }

    /// The text, the id of its state in the history, and its version.
    fn snapshot(&self) -> (Text, u64, u64) {
        // Fill in line counts the background index has made available.
        if self.state.read().unwrap().pieces.has_unknown_newlines() {
            self.state
                .write()
                .unwrap()
                .pieces
                .settle(&|p| self.newlines(p));
        }
        let decoding = self.reading.read().unwrap().decoding();
        let state = self.state.read().unwrap();
        let text = Text {
            pieces: state.pieces.clone(),
            original: self.original.clone(),
            added: self.added.clone(),
            decoding,
        };
        (text, state.history.current(), state.version)
    }

    pub fn view(&self, target: ViewTarget, rows: usize) -> io::Result<View> {
        self.text().view(target, rows)
    }

    pub fn index_status(&self) -> IndexStatus {
        let text = self.text();
        let original = self
            .original
            .index
            .read()
            .unwrap()
            .status(self.original.source.len());
        let complete = original.complete && text.all_newlines_known();
        let known = text.known_newlines().unwrap_or(0);
        IndexStatus {
            lines: if complete { known + 1 } else { known },
            complete,
            ..original
        }
    }

    /// Replaces `[start, end)` with `text`, whose line breaks become the
    /// file's. `before` is the selection before the edit, restored by undo.
    pub fn edit(
        &self,
        start: u64,
        end: u64,
        text: &str,
        kind: EditKind,
        before: (u64, u64),
    ) -> EditResult {
        let bytes = self.encode(text);
        let count = |p: &Piece| self.newlines(p);
        let mut state = self.state.write().unwrap();
        let len = state.pieces.len();
        let start = start.min(len);
        let end = end.clamp(start, len);
        let replaced = state.pieces.splice(start, end, &[], &count);
        if let Some(piece) = self.added_piece(&bytes) {
            state.pieces.insert_added(start, piece, &count);
        }
        let new_len = bytes.len() as u64;
        state.history.record(start, new_len, replaced, kind, before);
        state.version += 1;
        let caret = start + new_len;
        EditResult {
            change: Change {
                start,
                old_len: end - start,
                new_len,
            },
            anchor: caret,
            caret,
            state: state.doc_state(),
        }
    }

    /// Undoes the last change, restoring the selection from before it.
    pub fn undo(&self) -> Option<EditResult> {
        let count = |p: &Piece| self.newlines(p);
        let mut state = self.state.write().unwrap();
        let change = state.history.undo.pop()?;
        let (start, end) = (change.offset, change.offset + change.len);
        let restored = total_len(&change.replaced);
        let removed = state.pieces.splice(start, end, &change.replaced, &count);
        state.history.push_redo(&change, restored, removed);
        state.version += 1;
        Some(EditResult {
            change: Change {
                start,
                old_len: change.len,
                new_len: restored,
            },
            anchor: change.before.0,
            caret: change.before.1,
            state: state.doc_state(),
        })
    }

    pub fn redo(&self) -> Option<EditResult> {
        let count = |p: &Piece| self.newlines(p);
        let mut state = self.state.write().unwrap();
        let change = state.history.redo.pop()?;
        let (start, end) = (change.offset, change.offset + change.len);
        let new_len = total_len(&change.replaced);
        let removed = state.pieces.splice(start, end, &change.replaced, &count);
        state.history.push_undo(&change, new_len, removed);
        state.version += 1;
        let caret = start + new_len;
        Some(EditResult {
            change: Change {
                start,
                old_len: change.len,
                new_len,
            },
            anchor: caret,
            caret,
            state: state.doc_state(),
        })
    }

    /// Replaces the columns `[left, right)` of a box selection's lines with
    /// `texts`: one text for every line, or one per line (lines without one
    /// stay as they are). A line too short to reach `left` is padded with
    /// spaces before text goes in. One undo step. Also returns where the
    /// box's last line starts afterwards.
    #[allow(clippy::too_many_arguments)]
    pub fn edit_box(
        &self,
        top: u64,
        rows: BoxRows,
        left: u32,
        right: u32,
        texts: &[String],
        kind: EditKind,
        before: (u64, u64),
    ) -> io::Result<Option<(EditResult, u64)>> {
        let texts: Vec<Vec<u8>> = texts.iter().map(|t| self.encode(t)).collect();
        for _ in 0..3 {
            let (text, _, version) = self.snapshot();
            let mut edits = Vec::new();
            let mut shift = 0i64;
            let mut last = top;
            for (i, line) in text
                .box_lines(top, rows, left, right)?
                .into_iter()
                .enumerate()
            {
                last = line.line.saturating_add_signed(shift);
                let Some(insert) = (if texts.len() == 1 {
                    texts.first()
                } else {
                    texts.get(i)
                }) else {
                    continue;
                };
                let mut bytes = Vec::new();
                if !insert.is_empty() {
                    bytes.resize(line.pad as usize, b' ');
                    bytes.extend_from_slice(insert);
                }
                if line.start == line.end && bytes.is_empty() {
                    continue;
                }
                shift += bytes.len() as i64 - (line.end - line.start) as i64;
                edits.push((line.start, line.end, self.added_piece(&bytes)));
            }
            let mut state = self.state.write().unwrap();
            if state.version == version {
                return Ok(self
                    .apply(&mut state, &edits, kind, before)
                    .map(|r| (r, last)));
            }
        }
        Err(Problem::KeptChanging.into())
    }

    /// A box selection's lines joined with the file's line break, for the
    /// clipboard.
    pub fn box_text(&self, top: u64, bottom: u64, left: u32, right: u32) -> io::Result<String> {
        let text = self.text();
        let lines = text.box_lines(top, BoxRows::Until { bottom }, left, right)?;
        let size: u64 = lines.iter().map(|l| l.end - l.start).sum();
        if size > MAX_COPY {
            return Err(Problem::TooLargeToCopy {
                size_mb: size >> 20,
                limit_mb: MAX_COPY >> 20,
            }
            .into());
        }
        let parts = lines
            .iter()
            .map(|l| {
                Ok(self
                    .encoding()
                    .decode(&text.read_range(l.start, l.end)?)
                    .into_owned())
            })
            .collect::<io::Result<Vec<_>>>()?;
        Ok(parts.join(match self.eol {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
        }))
    }

    /// The next match after the selection, or the one before it `backward`,
    /// going round the end (of the scope, for Find in Selection). A
    /// selection that is a match is gone past: forward, the search starts
    /// just after its start, so that a match overlapping it is found too.
    pub fn find(
        &self,
        query: &Query,
        (anchor, caret): (u64, u64),
        backward: bool,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<FindResult> {
        let text = self.text();
        let Some(matcher) = Matcher::new(query, self.encoding(), text.len())? else {
            return Ok(FindResult::NotFound);
        };
        let (start, end) = (anchor.min(caret), anchor.max(caret));
        let from = if backward {
            start
        } else if matcher.at(&text, (start, end), |_| ())?.is_some() {
            start + 1
        } else {
            caret
        };
        matcher.find(&text, from, backward, cancel, progress)
    }

    /// How many matches there are, and which one the selection is; `None`
    /// if cancelled. The count is kept until the text or the query changes,
    /// so asking again as the selection moves costs little.
    pub fn count(
        &self,
        query: &Query,
        (anchor, caret): (u64, u64),
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<Option<MatchCount>> {
        let (text, _, version) = self.snapshot();
        let encoding = self.encoding();
        let Some(matcher) = Matcher::new(query, encoding, text.len())? else {
            return Ok(Some(MatchCount {
                total: 0,
                index: None,
            }));
        };
        let kept = self.counted.lock().unwrap().as_ref().and_then(|c| {
            (c.version == version && c.encoding == encoding && c.query == *query)
                .then(|| c.count.clone())
        });
        let count = match kept {
            Some(count) => count,
            None => {
                let Some(count) = matcher.count(&text, cancel, progress)? else {
                    return Ok(None);
                };
                let count = Arc::new(count);
                *self.counted.lock().unwrap() = Some(Counted {
                    query: query.clone(),
                    encoding,
                    version,
                    count: count.clone(),
                });
                count
            }
        };
        let index = matcher.index(&text, &count, (anchor.min(caret), anchor.max(caret)))?;
        Ok(Some(MatchCount {
            total: count.total,
            index,
        }))
    }

    /// Where the matches starting in `[from, to)` are, for the screen: no
    /// more than [`MAX_MARKS`].
    pub fn matches_in(&self, query: &Query, from: u64, to: u64) -> io::Result<Vec<(u64, u64)>> {
        let text = self.text();
        let mut found = Vec::new();
        let Some(matcher) = Matcher::new(query, self.encoding(), text.len())? else {
            return Ok(found);
        };
        let never = AtomicBool::new(false);
        matcher.each(&text, from, to, false, &never, &mut |_| {}, &mut |step| {
            if let Step::Match(hit) = step {
                found.push((hit.start, hit.end));
                if found.len() == MAX_MARKS {
                    return ControlFlow::Break(());
                }
            }
            ControlFlow::Continue(())
        })?;
        Ok(found)
    }

    /// What the selection would be replaced with, if it is a match.
    pub fn replacement_for(
        &self,
        query: &Query,
        replacement: &str,
        preserve_case: bool,
        (anchor, caret): (u64, u64),
    ) -> io::Result<Option<String>> {
        let text = self.text();
        let Some(matcher) = Matcher::new(query, self.encoding(), text.len())? else {
            return Ok(None);
        };
        let replacement = self.replacement(replacement, query, &matcher, preserve_case);
        let bytes = matcher.at(&text, (anchor.min(caret), anchor.max(caret)), |hit| {
            replacement.expand(hit)
        })?;
        Ok(bytes.map(|b| self.encoding().decode(&b).into_owned()))
    }

    /// Replaces every match with `replacement` as one undo step. Returns how
    /// many were replaced, or `None` if cancelled. Replacements that come
    /// out the same point at one copy of the text, so even a million of
    /// them cost only their pieces.
    pub fn replace_all(
        &self,
        query: &Query,
        replacement: &str,
        preserve_case: bool,
        before: (u64, u64),
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<Option<(usize, Option<EditResult>)>> {
        for _ in 0..3 {
            let (text, _, version) = self.snapshot();
            let Some(matcher) = Matcher::new(query, self.encoding(), text.len())? else {
                return Ok(Some((0, None)));
            };
            let replacement = self.replacement(replacement, query, &matcher, preserve_case);
            let mut edits = Vec::new();
            let mut pieces = HashMap::new();
            let mut too_many = false;
            let done = matcher.each_match(
                &text,
                replacement.needs_text(),
                cancel,
                progress,
                &mut |hit| {
                    if edits.len() == MAX_REPLACE {
                        too_many = true;
                        return ControlFlow::Break(());
                    }
                    let bytes = replacement.expand(hit);
                    let piece = *pieces
                        .entry(bytes)
                        .or_insert_with_key(|bytes: &Vec<u8>| self.added_piece(bytes));
                    edits.push((hit.start, hit.end, piece));
                    ControlFlow::Continue(())
                },
            )?;
            if too_many {
                return Err(Problem::TooManyMatches { limit: MAX_REPLACE }.into());
            }
            if !done {
                return Ok(None);
            }
            let mut state = self.state.write().unwrap();
            if state.version == version {
                let result = self.apply(&mut state, &edits, EditKind::Other, before);
                return Ok(Some((edits.len(), result)));
            }
        }
        Err(Problem::KeptChanging.into())
    }

    /// Toggle Line Comment, as VS Code does it: the lines the selection
    /// touches get `marker` and a space, at the smallest indent of those that
    /// are not blank or, `at_start`, at their start, as a deck wants it; or,
    /// if all of those start with `marker` already, lose it and a space after
    /// it. A selection ending at the start of a line leaves that line out.
    /// One undo step, and the selection stays on its text.
    pub fn toggle_line_comment(
        &self,
        marker: &str,
        at_start: bool,
        before: (u64, u64),
    ) -> io::Result<Option<EditResult>> {
        let marker = self.encoding().encode(marker).into_owned();
        let mut insert = marker.clone();
        insert.push(b' ');
        for _ in 0..3 {
            let (text, _, version) = self.snapshot();
            let (start, end) = (before.0.min(before.1), before.0.max(before.1));
            let first = text.line_start(start)?;
            let last = if end > start && end > first && text.line_start(end)? == end {
                end - 1
            } else {
                end
            };
            let mut lines = Vec::new();
            let mut at = first;
            loop {
                let (content_end, next) = text.line_bounds(at)?;
                lines.push((at, content_end));
                if lines.len() > MAX_BOX_LINES {
                    return Err(Problem::TooManyLines {
                        limit: MAX_BOX_LINES,
                    }
                    .into());
                }
                match next {
                    Some(next) if next <= last => at = next,
                    _ => break,
                }
            }
            let span = text.read_range(first, lines[lines.len() - 1].1)?;
            let content = |&(a, b): &(u64, u64)| &span[(a - first) as usize..(b - first) as usize];
            let lead = |line: &[u8]| {
                if at_start {
                    0
                } else {
                    line.iter()
                        .take_while(|&&b| b == b' ' || b == b'\t')
                        .count()
                }
            };
            let blank = |line: &[u8]| line.iter().all(|b| b" \t\r".contains(b));
            let filled: Vec<_> = lines
                .iter()
                .filter(|l| !blank(content(l)))
                .copied()
                .collect();
            let targets = if filled.is_empty() {
                lines.clone()
            } else {
                filled
            };
            let commented = targets.iter().all(|l| {
                let line = content(l);
                line[lead(line)..].starts_with(&marker)
            });
            let mut edits = Vec::with_capacity(targets.len());
            if commented {
                for l in &targets {
                    let line = content(l);
                    let at = lead(line);
                    let n = marker.len() + usize::from(line.get(at + marker.len()) == Some(&b' '));
                    let from = l.0 + at as u64;
                    edits.push((from, from + n as u64, None));
                }
            } else {
                let column = targets.iter().map(|l| lead(content(l))).min().unwrap_or(0);
                let piece = self.added_piece(&insert);
                for l in &targets {
                    edits.push((
                        l.0 + column.min(content(l).len()) as u64,
                        l.0 + column.min(content(l).len()) as u64,
                        piece,
                    ));
                }
            }
            let mut state = self.state.write().unwrap();
            if state.version == version {
                return Ok(self
                    .apply(&mut state, &edits, EditKind::Other, before)
                    .map(|result| keep_selection(result, &edits, before, false)));
            }
        }
        Err(Problem::KeptChanging.into())
    }

    /// Toggle Block Comment, as VS Code does it: the selection goes between
    /// `open` and `close` with a space inside each, or comes out of them if it
    /// is between them already; without a selection, the caret goes between
    /// them. The selection stays on its text.
    pub fn toggle_block_comment(
        &self,
        open: &str,
        close: &str,
        before: (u64, u64),
    ) -> io::Result<Option<EditResult>> {
        let (open, close) = (
            self.encoding().encode(open).into_owned(),
            self.encoding().encode(close).into_owned(),
        );
        for _ in 0..3 {
            let (text, _, version) = self.snapshot();
            let (start, end) = (before.0.min(before.1), before.0.max(before.1));
            let edge = (open.len() + close.len() + 2) as u64;
            let head = text.read_range(start, (start + edge).min(end))?;
            let tail = text.read_range(end.saturating_sub(edge).max(start), end)?;
            let space = |b: &u8| b" \t".contains(b);
            let lead = head.iter().take_while(|b| space(b)).count();
            let trail = tail.iter().rev().take_while(|b| space(b)).count();
            let wrapped = end - start >= (lead + open.len() + close.len() + trail) as u64
                && head[lead..].starts_with(&open)
                && tail[..tail.len() - trail].ends_with(&close);
            // Or the markers are just outside it, as Toggle Block Comment left them.
            let outside = text.read_range(start.saturating_sub(open.len() as u64 + 1), start)?;
            let after = text.read_range(end, (end + close.len() as u64 + 1).min(text.len()))?;
            let opened = outside
                .strip_suffix(b" ")
                .unwrap_or(&outside)
                .ends_with(&open);
            let closed = after
                .strip_prefix(b" ")
                .unwrap_or(&after)
                .starts_with(&close);
            let mut edits = Vec::new();
            let mut caret = None;
            if start != end && !wrapped && opened && closed {
                let n = open.len() + usize::from(outside.ends_with(b" "));
                let m = close.len() + usize::from(after.starts_with(b" "));
                edits.push((start - n as u64, start, None));
                edits.push((end, end + m as u64, None));
            } else if start == end {
                let mut both = open.clone();
                both.extend_from_slice(b"  ");
                both.extend_from_slice(&close);
                edits.push((start, start, self.added_piece(&both)));
                caret = Some(start + open.len() as u64 + 1);
            } else if wrapped {
                let a = start + lead as u64;
                let n = open.len() + usize::from(head.get(lead + open.len()) == Some(&b' '));
                let b = end - trail as u64;
                let inner = &tail[..tail.len() - trail - close.len()];
                let m = close.len() + usize::from(inner.last() == Some(&b' '));
                edits.push((a, a + n as u64, None));
                edits.push((b - m as u64, b, None));
            } else {
                let mut opening = open.clone();
                opening.push(b' ');
                let mut closing = vec![b' '];
                closing.extend_from_slice(&close);
                edits.push((start, start, self.added_piece(&opening)));
                edits.push((end, end, self.added_piece(&closing)));
            }
            let mut state = self.state.write().unwrap();
            if state.version == version {
                return Ok(self
                    .apply(&mut state, &edits, EditKind::Other, before)
                    .map(|result| match caret {
                        Some(caret) => EditResult {
                            anchor: caret,
                            caret,
                            ..result
                        },
                        None => keep_selection(result, &edits, before, true),
                    }));
            }
        }
        Err(Problem::KeptChanging.into())
    }

    fn replacement(
        &self,
        replacement: &str,
        query: &Query,
        matcher: &Matcher,
        preserve_case: bool,
    ) -> Replacement {
        let groups = query.regex.then(|| matcher.groups());
        Replacement::new(
            replacement,
            groups,
            preserve_case,
            self.encoding(),
            |text| self.encode(text),
        )
    }

    /// Applies sorted, non-overlapping edits `(start, end, new text)` in one
    /// pass, as one change. `None` without edits.
    fn apply(
        &self,
        state: &mut State,
        edits: &[(u64, u64, Option<Piece>)],
        kind: EditKind,
        before: (u64, u64),
    ) -> Option<EditResult> {
        let (start, end) = (edits.first()?.0, edits.last()?.1);
        let count = |p: &Piece| self.newlines(p);
        let replaced = state.pieces.range(start, end, &count);
        let mut pieces = Vec::with_capacity(edits.len() * 2);
        let mut pos = start;
        for &(from, to, piece) in edits {
            pieces.extend(state.pieces.range(pos, from, &count));
            pieces.extend(piece);
            pos = to;
        }
        let new_len = total_len(&pieces);
        state.pieces.splice(start, end, &pieces, &count);
        state.history.record(start, new_len, replaced, kind, before);
        state.version += 1;
        let caret = start + new_len;
        Some(EditResult {
            change: Change {
                start,
                old_len: end - start,
                new_len,
            },
            anchor: caret,
            caret,
            state: state.doc_state(),
        })
    }

    /// Appends `bytes` to the added text, as a piece.
    fn added_piece(&self, bytes: &[u8]) -> Option<Piece> {
        (!bytes.is_empty()).then(|| Piece {
            source: Source::Added,
            start: self.added.append(bytes),
            len: bytes.len() as u64,
            newlines: Some(memchr::memchr_iter(b'\n', bytes).count() as u64),
        })
    }

    /// Which solver the start of the current text looks written for.
    pub fn dialect(&self) -> io::Result<Option<Dialect>> {
        let text = self.text();
        let sample = text.read_range(0, text.len().min(SNIFF_LEN as u64))?;
        Ok(dialect::detect(&sample))
    }

    /// `[start, end)` decoded, for the clipboard.
    pub fn copy_text(&self, start: u64, end: u64) -> io::Result<String> {
        let len = end.saturating_sub(start);
        if len > MAX_COPY {
            return Err(Problem::TooLargeToCopy {
                size_mb: len >> 20,
                limit_mb: MAX_COPY >> 20,
            }
            .into());
        }
        let bytes = self.text().read_range(start, end)?;
        Ok(self.encoding().decode(&bytes).into_owned())
    }

    /// Saves to the file it was opened from or last saved as. A new
    /// document has none: use [`save_as`](Self::save_as).
    pub fn save(&self, cancel: &AtomicBool, progress: &mut dyn FnMut(u64)) -> io::Result<bool> {
        let path = self.path().ok_or(Problem::NeedsFileName)?;
        self.save_as(&path, cancel, progress)
    }

    /// Saves to `path`, which becomes where the document saves from now on.
    /// The text goes to a temporary file next to it, which then replaces
    /// any file there, so a failed save leaves that file intact. Editing can
    /// go on meanwhile; the document stays dirty if it changed. Returns
    /// `false` if cancelled.
    pub fn save_as(
        &self,
        path: &Path,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<bool> {
        let (text, id, _) = self.snapshot();
        if !write_file(path, |out| text.write_to(out, cancel, progress))? {
            return Ok(false);
        }
        self.state.write().unwrap().history.mark_saved(id);
        let meta = fs::metadata(path)?;
        *self.disk.lock().unwrap() = (meta.len(), meta.modified().ok());
        *self.path.write().unwrap() = Some(path.to_path_buf());
        Ok(true)
    }

    /// Writes the text to `path` converted to the encoding `to`, leaving any
    /// file there intact if a byte is malformed or a character does not
    /// exist in `to`. The file's bytes then no longer match this document's
    /// offsets: open it again to go on. Returns `false` if cancelled.
    pub fn save_converted(
        &self,
        path: &Path,
        to: Encoding,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<bool> {
        let (text, ..) = self.snapshot();
        let from = self.encoding();
        write_file(path, |out| {
            text.write_converted(from, to, out, cancel, progress)
        })
    }

    /// Whether the file on disk changed since it was opened or saved here.
    pub fn changed_on_disk(&self) -> bool {
        let Some(path) = self.path() else {
            return false;
        };
        match fs::metadata(path) {
            Ok(meta) => (meta.len(), meta.modified().ok()) != *self.disk.lock().unwrap(),
            Err(_) => true,
        }
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

    fn encode(&self, text: &str) -> Vec<u8> {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let text = match self.eol {
            Eol::Lf => text,
            Eol::Crlf => text.replace('\n', "\r\n"),
        };
        self.encoding().encode(&text).into_owned()
    }

    fn newlines(&self, piece: &Piece) -> Option<u64> {
        match piece.source {
            Source::Original => self
                .original
                .newlines_in(piece.start, piece.end())
                .ok()
                .flatten(),
            Source::Added => Some(self.added.newlines(piece.start, piece.end())),
        }
    }
}

impl Drop for Document {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// The selection `before` moved past `edits`, sorted and apart: a place
/// inside a removal goes to its start. Text put in at the selection's start
/// goes inside it, unless `around` (a block comment's opening goes before
/// the text, its closing after it); an empty selection moves past it.
fn keep_selection(
    result: EditResult,
    edits: &[(u64, u64, Option<Piece>)],
    (anchor, caret): (u64, u64),
    around: bool,
) -> EditResult {
    let empty = anchor == caret;
    let moved = |at: u64, is_start: bool| {
        // Whether text put in right here comes before it.
        let past_insert = empty || is_start == around;
        let mut out = at as i64;
        for &(start, end, piece) in edits {
            let added = piece.map_or(0, |p| p.len) as i64;
            if at > end || (at == end && (start < end || past_insert)) {
                out += added - (end - start) as i64;
            } else if at > start {
                out -= (at - start) as i64;
            }
        }
        out as u64
    };
    let forward = anchor <= caret;
    EditResult {
        anchor: moved(anchor, forward),
        caret: moved(caret, !forward),
        ..result
    }
}

/// Writes through `write` to a temporary file next to `path`, which then
/// replaces any file there. Returns `write`'s answer; `false` writes nothing.
fn write_file(
    path: &Path,
    write: impl FnOnce(&mut BufWriter<File>) -> io::Result<bool>,
) -> io::Result<bool> {
    let temp = temp_path(path);
    let written = (|| {
        let mut out = BufWriter::with_capacity(8 << 20, File::create(&temp)?);
        if !write(&mut out)? {
            return Ok(false);
        }
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&temp, meta.permissions())?;
        }
        // A replaced original stays readable through the open handle, so
        // unchanged pieces and undo keep working.
        fs::rename(&temp, path)?;
        Ok(true)
    })();
    if !matches!(written, Ok(true)) {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// `.name.hu-save` next to `path`.
fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map_or_else(Default::default, |n| n.to_string_lossy().into_owned());
    path.with_file_name(format!(".{name}.hu-save"))
}

mod lines;

pub use lines::BlockKind;

#[cfg(test)]
mod tests;
