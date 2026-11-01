//! IPC commands. The frontend never holds the file, only the lines it is
//! about to draw; edits are sent as byte ranges and text.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hu_core::{
    BoxRows, Dialect, DocState, Document, EditKind, EditResult, Encoding, Eol, FindOptions,
    FindResult, IndexStatus, View, ViewTarget, dir,
};
use serde::Serialize;
use tauri::async_runtime::spawn_blocking;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Default)]
pub struct Docs {
    open: Mutex<HashMap<u32, Arc<OpenDoc>>>,
    next_id: AtomicU32,
}

struct OpenDoc {
    doc: Document,
    /// Cancels the running search; a new search replaces it.
    find_cancel: Mutex<Arc<AtomicBool>>,
}

impl Docs {
    fn add(&self, doc: Document) -> DocInfo {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let path = doc.path();
        let info = DocInfo {
            id,
            name: path.as_deref().map(file_name).unwrap_or_default(),
            path: path.map(|p| p.display().to_string()),
            encoding: doc.encoding(),
            eol: doc.eol(),
            state: doc.state(),
        };
        let open = OpenDoc {
            doc,
            find_cancel: Mutex::default(),
        };
        self.open.lock().unwrap().insert(id, Arc::new(open));
        info
    }

    fn get(&self, id: u32) -> Result<Arc<OpenDoc>, String> {
        self.open
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("document {id} is not open"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    id: u32,
    /// `None` for a new document.
    path: Option<String>,
    name: String,
    encoding: Encoding,
    eol: Eol,
    state: DocState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathKind {
    File,
    Dir,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FindOutcome {
    Found { offset: u64, len: u64 },
    NotFound,
    Cancelled,
}

/// Runs blocking work (disk reads) off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// File passed on the command line ("Open with" on Windows).
#[tauri::command]
pub fn launch_path() -> Option<String> {
    std::env::args().nth(1)
}

#[tauri::command]
pub async fn roots() -> Vec<dir::Root> {
    spawn_blocking(dir::roots).await.unwrap_or_default()
}

#[tauri::command]
pub async fn list_dir(path: PathBuf) -> Result<Vec<dir::Entry>, String> {
    blocking(move || dir::list(&path).map_err(|e| format!("{}: {e}", path.display()))).await
}

#[tauri::command]
pub fn path_chain(path: PathBuf) -> Vec<String> {
    dir::chain(&path)
}

/// `None` when nothing exists at `path`.
#[tauri::command]
pub async fn path_kind(path: PathBuf) -> Option<PathKind> {
    spawn_blocking(move || {
        let meta = std::fs::metadata(path).ok()?;
        Some(if meta.is_dir() {
            PathKind::Dir
        } else {
            PathKind::File
        })
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn open_document(
    path: PathBuf,
    encoding: Option<Encoding>,
    docs: State<'_, Docs>,
) -> Result<DocInfo, String> {
    let doc = blocking(move || {
        Document::open_as(&path, encoding).map_err(|e| format!("{}: {e}", path.display()))
    })
    .await?;
    Ok(docs.add(doc))
}

/// Reads the same bytes in `encoding`, or back in the one detected; the file
/// does not change. Returns the encoding now in use.
#[tauri::command]
pub async fn set_encoding(
    id: u32,
    encoding: Option<Encoding>,
    docs: State<'_, Docs>,
) -> Result<Encoding, String> {
    let open = docs.get(id)?;
    blocking(move || open.doc.set_encoding(encoding).map_err(|e| e.to_string())).await
}

/// Writes the text to `path` converted to `encoding`, streaming the bytes
/// read to `on_progress`. The document no longer matches the file: open it
/// again to go on.
#[tauri::command]
pub async fn save_converted(
    id: u32,
    path: PathBuf,
    encoding: Encoding,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<(), String> {
    let open = docs.get(id)?;
    blocking(move || {
        let mut last = Instant::now();
        let mut progress = |read| {
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = on_progress.send(read);
            }
        };
        open.doc
            .save_converted(&path, encoding, &AtomicBool::new(false), &mut progress)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
}

/// A new, empty document without a file; the frontend names it.
#[tauri::command]
pub fn new_document(docs: State<'_, Docs>) -> DocInfo {
    docs.add(Document::untitled())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn close_document(id: u32, docs: State<'_, Docs>) {
    if let Some(open) = docs.open.lock().unwrap().remove(&id) {
        open.find_cancel
            .lock()
            .unwrap()
            .store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn index_status(id: u32, docs: State<'_, Docs>) -> Result<IndexStatus, String> {
    let open = docs.get(id)?;
    blocking(move || Ok(open.doc.index_status())).await
}

/// Which solver the document's content looks written for, if it says.
#[tauri::command]
pub async fn detect_dialect(id: u32, docs: State<'_, Docs>) -> Result<Option<Dialect>, String> {
    let open = docs.get(id)?;
    blocking(move || open.doc.dialect().map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn disk_changed(id: u32, docs: State<'_, Docs>) -> Result<bool, String> {
    Ok(docs.get(id)?.doc.changed_on_disk())
}

#[tauri::command]
pub async fn view(
    id: u32,
    target: ViewTarget,
    rows: usize,
    docs: State<'_, Docs>,
) -> Result<View, String> {
    let open = docs.get(id)?;
    blocking(move || open.doc.view(target, rows).map_err(|e| e.to_string())).await
}

/// Replaces `[start, end)` with `text`. `anchor` and `caret` are the
/// selection before the edit, restored by undo.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit(
    id: u32,
    start: u64,
    end: u64,
    text: String,
    kind: EditKind,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<EditResult, String> {
    let open = docs.get(id)?;
    blocking(move || Ok(open.doc.edit(start, end, &text, kind, (anchor, caret)))).await
}

#[tauri::command]
pub async fn undo(id: u32, docs: State<'_, Docs>) -> Result<Option<EditResult>, String> {
    let open = docs.get(id)?;
    blocking(move || Ok(open.doc.undo())).await
}

#[tauri::command]
pub async fn redo(id: u32, docs: State<'_, Docs>) -> Result<Option<EditResult>, String> {
    let open = docs.get(id)?;
    blocking(move || Ok(open.doc.redo())).await
}

/// Puts `[start, end)` on the clipboard without sending it to the frontend.
#[tauri::command]
pub async fn copy(
    id: u32,
    start: u64,
    end: u64,
    app: AppHandle,
    docs: State<'_, Docs>,
) -> Result<(), String> {
    let open = docs.get(id)?;
    let text = blocking(move || open.doc.copy_text(start, end).map_err(|e| e.to_string())).await?;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxEdit {
    result: EditResult,
    /// Where the box's last line starts after the edit.
    last_line: u64,
}

/// Replaces the columns `[left, right)` of a box selection's lines with
/// `texts` (one for all lines, or one per line).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_box(
    id: u32,
    top: u64,
    rows: BoxRows,
    left: u32,
    right: u32,
    texts: Vec<String>,
    kind: EditKind,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<Option<BoxEdit>, String> {
    let open = docs.get(id)?;
    blocking(move || {
        let edited = open
            .doc
            .edit_box(top, rows, left, right, &texts, kind, (anchor, caret));
        Ok(edited
            .map_err(|e| e.to_string())?
            .map(|(result, last_line)| BoxEdit { result, last_line }))
    })
    .await
}

/// Puts a box selection on the clipboard, one line per row.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn copy_box(
    id: u32,
    top: u64,
    bottom: u64,
    left: u32,
    right: u32,
    app: AppHandle,
    docs: State<'_, Docs>,
) -> Result<(), String> {
    let open = docs.get(id)?;
    let text = blocking(move || {
        open.doc
            .box_text(top, bottom, left, right)
            .map_err(|e| e.to_string())
    })
    .await?;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReplaceOutcome {
    Replaced {
        count: usize,
        result: Option<EditResult>,
    },
    Cancelled,
}

/// Replaces every match as one undo step, streaming the bytes searched to
/// `on_progress`. Cancelled like a search.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn replace_all(
    id: u32,
    needle: String,
    replacement: String,
    case_sensitive: bool,
    anchor: u64,
    caret: u64,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<ReplaceOutcome, String> {
    let open = docs.get(id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let previous = std::mem::replace(&mut *open.find_cancel.lock().unwrap(), cancel.clone());
    previous.store(true, Ordering::Relaxed);
    blocking(move || {
        let mut last = Instant::now();
        let mut progress = |searched| {
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = on_progress.send(searched);
            }
        };
        let done = open
            .doc
            .replace_all(
                &needle,
                &replacement,
                case_sensitive,
                (anchor, caret),
                &cancel,
                &mut progress,
            )
            .map_err(|e| e.to_string())?;
        Ok(match done {
            Some((count, result)) => ReplaceOutcome::Replaced { count, result },
            None => ReplaceOutcome::Cancelled,
        })
    })
    .await
}

/// Streams the number of bytes written to `on_progress` while it runs.
#[tauri::command]
pub async fn save(
    id: u32,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<DocState, String> {
    let open = docs.get(id)?;
    blocking(move || {
        let mut last = Instant::now();
        let mut progress = |written| {
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = on_progress.send(written);
            }
        };
        let path = open
            .doc
            .path()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        open.doc
            .save(&AtomicBool::new(false), &mut progress)
            .map_err(|e| format!("{path}: {e}"))?;
        Ok(open.doc.state())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAs {
    path: String,
    name: String,
    state: DocState,
}

/// Saves to `path`, where the document saves from now on.
#[tauri::command]
pub async fn save_as(
    id: u32,
    path: PathBuf,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<SavedAs, String> {
    let open = docs.get(id)?;
    blocking(move || {
        let mut last = Instant::now();
        let mut progress = |written| {
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = on_progress.send(written);
            }
        };
        open.doc
            .save_as(&path, &AtomicBool::new(false), &mut progress)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(SavedAs {
            name: file_name(&path),
            path: path.display().to_string(),
            state: open.doc.state(),
        })
    })
    .await
}

/// Streams the number of bytes searched to `on_progress` while it runs.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn find(
    id: u32,
    needle: String,
    from: u64,
    case_sensitive: bool,
    backward: bool,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<FindOutcome, String> {
    let open = docs.get(id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let previous = std::mem::replace(&mut *open.find_cancel.lock().unwrap(), cancel.clone());
    previous.store(true, Ordering::Relaxed);

    let needle = open.doc.encoding().encode(&needle).into_owned();
    let len = needle.len() as u64;
    let result = blocking(move || {
        let options = FindOptions {
            case_sensitive,
            backward,
            wrap: true,
        };
        let mut last = Instant::now();
        let mut progress = |searched| {
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = on_progress.send(searched);
            }
        };
        open.doc
            .text()
            .find(&needle, from, &options, &cancel, &mut progress)
            .map_err(|e| e.to_string())
    })
    .await?;

    Ok(match result {
        FindResult::Found(offset) => FindOutcome::Found { offset, len },
        FindResult::NotFound => FindOutcome::NotFound,
        FindResult::Cancelled => FindOutcome::Cancelled,
    })
}

#[tauri::command]
pub async fn cancel_find(id: u32, docs: State<'_, Docs>) -> Result<(), String> {
    docs.get(id)?
        .find_cancel
        .lock()
        .unwrap()
        .store(true, Ordering::Relaxed);
    Ok(())
}
