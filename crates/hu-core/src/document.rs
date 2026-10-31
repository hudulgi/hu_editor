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
use crate::source::FileSource;
use crate::text::{Text, View, ViewError, ViewTarget};

/// Larger selections are not copied to the clipboard.
pub const MAX_COPY: u64 = 256 << 20;
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
    disk: Mutex<Stamp>,
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
            }),
            encoding: Encoding::detect(&sample),
            eol: Eol::detect(&sample),
            cancel,
        })
    }

    pub fn path(&self) -> &Path {
        self.original.source.path()
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
        self.text_and_id().0
    }

    /// The text with the id of its state in the history.
    fn text_and_id(&self) -> (Text, u64) {
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
        (text, state.history.current())
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
        if !bytes.is_empty() {
            let at = self.added.append(&bytes);
            let newlines = Some(memchr::memchr_iter(b'\n', &bytes).count() as u64);
            let piece = Piece {
                source: Source::Added,
                start: at,
                len: bytes.len() as u64,
                newlines,
            };
            state.pieces.insert_added(start, piece, &count);
        }
        let new_len = bytes.len() as u64;
        state.history.record(start, new_len, replaced, kind, before);
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

    /// Saves to the file it was opened from. The text goes to a temporary
    /// file next to it, which then replaces the original, so a failed save
    /// leaves the original intact. Editing can go on meanwhile; the document
    /// stays dirty if it changed. Returns `false` if cancelled.
    pub fn save(&self, cancel: &AtomicBool, progress: &mut dyn FnMut(u64)) -> io::Result<bool> {
        let (text, id) = self.text_and_id();
        let path = self.path().to_path_buf();
        let temp = temp_path(&path);
        let written = (|| {
            let mut out = BufWriter::with_capacity(8 << 20, File::create(&temp)?);
            if !text.write_to(&mut out, cancel, progress)? {
                return Ok(false);
            }
            out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
            if let Ok(meta) = fs::metadata(&path) {
                fs::set_permissions(&temp, meta.permissions())?;
            }
            // The replaced file stays readable through the open handle, so
            // unchanged pieces and undo keep working.
            fs::rename(&temp, &path)?;
            Ok(true)
        })();
        if !matches!(written, Ok(true)) {
            let _ = fs::remove_file(&temp);
            return written;
        }
        self.state.write().unwrap().history.mark_saved(id);
        let meta = fs::metadata(&path)?;
        *self.disk.lock().unwrap() = (meta.len(), meta.modified().ok());
        Ok(true)
    }

    /// Whether the file on disk changed since it was opened or saved here.
    pub fn changed_on_disk(&self) -> bool {
        match fs::metadata(self.path()) {
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
