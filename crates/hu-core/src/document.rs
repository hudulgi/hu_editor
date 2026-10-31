//! An open file: the original on disk, the background line index, the piece
//! table of edits and their history.
//!
//! Reads go through a [`Text`] snapshot, which is cheap to take and stays
//! valid while editing goes on, so a long search or save never blocks typing.

use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::decode::Encoding;
use crate::history::{EditKind, History};
use crate::line_index::{self, IndexStatus, LineIndex};
use crate::original::Original;
use crate::pieces::{Added, Piece, Pieces, Source, total_len};
use crate::search;
use crate::source::FileSource;
use crate::text::{BoxRows, Text, View, ViewError, ViewTarget};

/// Larger selections are not copied to the clipboard.
pub const MAX_COPY: u64 = 256 << 20;
/// Replace All stops at this many matches.
pub const MAX_REPLACE: usize = 2_000_000;
const SNIFF_LEN: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
            None if cfg!(windows) => Eol::Crlf,
            None => Eol::Lf,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocState {
    pub len: u64,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
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
        }
    }
}

/// Size and modification time of the file as last opened or saved here.
type Stamp = (u64, Option<SystemTime>);

pub struct Document {
    original: Original,
    added: Arc<Added>,
    state: RwLock<State>,
    encoding: Encoding,
    eol: Eol,
    /// Where it saves: the file it was opened from or last saved as; `None`
    /// for a new document.
    path: RwLock<Option<PathBuf>>,
    disk: Mutex<Stamp>,
    cancel: Arc<AtomicBool>,
}

impl Document {
    /// Opens `path` without reading it; the line index is built on a
    /// background thread.
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        Self::from_source(FileSource::open(path)?, Some(path.to_path_buf()))
    }

    /// A new, empty document with no file yet: UTF-8, with the platform's
    /// line breaks.
    pub fn untitled() -> Self {
        Self::from_source(FileSource::empty(), None).expect("an empty source has nothing to read")
    }

    fn from_source(source: FileSource, path: Option<PathBuf>) -> io::Result<Self> {
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
            encoding: Encoding::detect(&sample),
            eol: Eol::detect(&sample),
            path: RwLock::new(path),
            cancel,
        })
    }

    /// Where it saves; `None` for a new document.
    pub fn path(&self) -> Option<PathBuf> {
        self.path.read().unwrap().clone()
    }

    pub fn len(&self) -> u64 {
        self.state.read().unwrap().pieces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn encoding(&self) -> Encoding {
        self.encoding
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
        let state = self.state.read().unwrap();
        let text = Text {
            pieces: state.pieces.clone(),
            original: self.original.clone(),
            added: self.added.clone(),
        };
        (text, state.history.current(), state.version)
    }

    pub fn view(&self, target: ViewTarget, rows: usize) -> Result<View, ViewError> {
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
        Err(io::Error::other("the document kept changing; try again"))
    }

    /// A box selection's lines joined with the file's line break, for the
    /// clipboard.
    pub fn box_text(&self, top: u64, bottom: u64, left: u32, right: u32) -> io::Result<String> {
        let text = self.text();
        let lines = text.box_lines(top, BoxRows::Until { bottom }, left, right)?;
        let size: u64 = lines.iter().map(|l| l.end - l.start).sum();
        if size > MAX_COPY {
            return Err(io::Error::other(format!(
                "selection is too large to copy ({} MB; the limit is {} MB)",
                size >> 20,
                MAX_COPY >> 20
            )));
        }
        let parts = lines
            .iter()
            .map(|l| {
                Ok(self
                    .encoding
                    .decode(&text.read_range(l.start, l.end)?)
                    .into_owned())
            })
            .collect::<io::Result<Vec<_>>>()?;
        Ok(parts.join(match self.eol {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
        }))
    }

    /// Replaces every match of `needle` with `replacement` as one undo step.
    /// Returns how many were replaced, or `None` if cancelled. All
    /// replacements point at one copy of the text, so even a million of
    /// them cost only their pieces.
    pub fn replace_all(
        &self,
        needle: &str,
        replacement: &str,
        case_sensitive: bool,
        before: (u64, u64),
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> io::Result<Option<(usize, Option<EditResult>)>> {
        let needle = self.encoding.encode(needle).into_owned();
        let piece = self.added_piece(&self.encode(replacement));
        for _ in 0..3 {
            let (text, _, version) = self.snapshot();
            let Some(found) = search::find_all(
                &text,
                &needle,
                case_sensitive,
                MAX_REPLACE,
                cancel,
                progress,
            )?
            else {
                return Ok(None);
            };
            let n = needle.len() as u64;
            let edits: Vec<_> = found.iter().map(|&at| (at, at + n, piece)).collect();
            let mut state = self.state.write().unwrap();
            if state.version == version {
                let result = self.apply(&mut state, &edits, EditKind::Other, before);
                return Ok(Some((found.len(), result)));
            }
        }
        Err(io::Error::other(
            "the document kept changing during the replace; try again",
        ))
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

    /// `[start, end)` decoded, for the clipboard.
    pub fn copy_text(&self, start: u64, end: u64) -> io::Result<String> {
        let len = end.saturating_sub(start);
        if len > MAX_COPY {
            return Err(io::Error::other(format!(
                "selection is too large to copy ({} MB; the limit is {} MB)",
                len >> 20,
                MAX_COPY >> 20
            )));
        }
        let bytes = self.text().read_range(start, end)?;
        Ok(self.encoding.decode(&bytes).into_owned())
    }

    /// Saves to the file it was opened from or last saved as. A new
    /// document has none: use [`save_as`](Self::save_as).
    pub fn save(&self, cancel: &AtomicBool, progress: &mut dyn FnMut(u64)) -> io::Result<bool> {
        let path = self
            .path()
            .ok_or_else(|| io::Error::other("a new document needs a file name: use Save As"))?;
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
        let temp = temp_path(path);
        let written = (|| {
            let mut out = BufWriter::with_capacity(8 << 20, File::create(&temp)?);
            if !text.write_to(&mut out, cancel, progress)? {
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
            return written;
        }
        self.state.write().unwrap().history.mark_saved(id);
        let meta = fs::metadata(path)?;
        *self.disk.lock().unwrap() = (meta.len(), meta.modified().ok());
        *self.path.write().unwrap() = Some(path.to_path_buf());
        Ok(true)
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
        self.encoding.encode(&text).into_owned()
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

/// `.name.hu-save` next to `path`.
fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map_or_else(Default::default, |n| n.to_string_lossy().into_owned());
    path.with_file_name(format!(".{name}.hu-save"))
}

#[cfg(test)]
mod tests;
