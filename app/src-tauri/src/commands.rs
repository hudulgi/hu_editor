//! IPC commands. The frontend never sees the file, only the lines it is
//! about to draw.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hu_core::{Document, FindOptions, FindResult, IndexStatus, Mark, View, ViewTarget, dir};
use serde::Serialize;
use tauri::State;
use tauri::async_runtime::spawn_blocking;
use tauri::ipc::Channel;

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
    len: u64,
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
    spawn_blocking(move || dir::list(&path).map_err(|e| format!("{}: {e}", path.display())))
        .await
        .map_err(|e| e.to_string())?
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
    let doc = Document::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let id = docs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let info = DocInfo {
        id,
        name: path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        path: path.display().to_string(),
        len: doc.len(),
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
    Ok(docs.get(id)?.doc.index_status())
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
    marks: Vec<Mark>,
    docs: State<'_, Docs>,
) -> Result<View, String> {
    let open = docs.get(id)?;
    spawn_blocking(move || open.doc.view(target, rows, &marks))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
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

    let len = needle.len() as u64;
    let result = spawn_blocking(move || {
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
            .find(needle.as_bytes(), from, &options, &cancel, &mut progress)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

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
