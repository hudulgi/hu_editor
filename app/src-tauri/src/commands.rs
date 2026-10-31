//! IPC commands. The frontend never holds the file, only the lines it is
//! about to draw; edits are sent as byte ranges and text.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hu_core::{
    DocState, Document, EditKind, EditResult, Encoding, Eol, FindOptions, FindResult, IndexStatus,
    View, ViewTarget, dir,
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
    path: String,
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
pub async fn open_document(path: PathBuf, docs: State<'_, Docs>) -> Result<DocInfo, String> {
    let doc = {
        let path = path.clone();
        blocking(move || Document::open(&path).map_err(|e| format!("{}: {e}", path.display())))
            .await?
    };
    let id = docs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let info = DocInfo {
        id,
        name: path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        path: path.display().to_string(),
        encoding: doc.encoding(),
        eol: doc.eol(),
        state: doc.state(),
    };
    let open = OpenDoc {
        doc,
        find_cancel: Mutex::default(),
    };
    docs.open.lock().unwrap().insert(id, Arc::new(open));
    Ok(info)
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
        let path = open.doc.path().display().to_string();
        open.doc
            .save(&AtomicBool::new(false), &mut progress)
            .map_err(|e| format!("{path}: {e}"))?;
        Ok(open.doc.state())
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
