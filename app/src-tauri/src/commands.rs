//! IPC commands. The frontend never holds the file, only the lines it is
//! about to draw; edits are sent as byte ranges and text.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hu_core::{
    BoxRows, Dialect, DocState, Document, EditKind, EditResult, Encoding, Eol, FindOptions,
    FindResult, IndexStatus, Matching, View, ViewTarget, dir, ipc_message, settings,
};
use serde::Serialize;
use serde_json::Value;
use tauri::async_runtime::spawn_blocking;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
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
    /// How many windows show it; it closes with the last.
    windows: AtomicU32,
}

/// What each window opened by `open_window` shows first, until it asks.
#[derive(Default)]
pub struct WindowStarts {
    waiting: Mutex<HashMap<String, Value>>,
    next_id: AtomicU32,
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
            windows: AtomicU32::new(1),
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

    /// The open documents that were `from` or in it save under `to` from now on.
    fn follow(&self, from: &Path, to: &Path) -> Vec<MovedDoc> {
        let open = self.open.lock().unwrap();
        let mut moved = Vec::new();
        for (&id, one) in open.iter() {
            let Some(new) = one.doc.path().and_then(|path| dir::moved(&path, from, to)) else {
                continue;
            };
            one.doc.moved_to(new.clone());
            moved.push(MovedDoc {
                id,
                name: file_name(&new),
                path: new.display().to_string(),
            });
        }
        moved
    }
}

/// An open document whose file was renamed or moved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedDoc {
    id: u32,
    path: String,
    name: String,
}

/// What a paste did, up to where it may have stopped.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pasted {
    /// Where each pasted file or folder is now.
    to: Vec<String>,
    /// Open documents that moved with them.
    docs: Vec<MovedDoc>,
    error: Option<String>,
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

/// An error for the frontend, with the path if the OS is the one complaining.
fn at_path(path: &Path, error: &std::io::Error) -> String {
    let message = ipc_message(error);
    if message.starts_with('{') {
        message
    } else {
        format!("{}: {message}", path.display())
    }
}

/// Runs blocking work (disk reads) off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_file(path: PathBuf) -> Result<(), String> {
    blocking(move || dir::create_file(&path).map_err(|e| at_path(&path, &e))).await
}

#[tauri::command]
pub async fn create_dir(path: PathBuf) -> Result<(), String> {
    blocking(move || dir::create_dir(&path).map_err(|e| at_path(&path, &e))).await
}

/// Renames a file or folder; documents open from it save under the new name.
#[tauri::command]
pub async fn rename_path(
    from: PathBuf,
    to: PathBuf,
    docs: State<'_, Docs>,
) -> Result<Vec<MovedDoc>, String> {
    let (old, new) = (from.clone(), to.clone());
    blocking(move || dir::rename(&old, &new).map_err(|e| at_path(&old, &e))).await?;
    Ok(docs.follow(&from, &to))
}

/// Copies (or with `cut`, moves) each of `paths` into the folder `into`,
/// stopping at the first that fails.
#[tauri::command]
pub async fn paste(
    paths: Vec<PathBuf>,
    into: PathBuf,
    cut: bool,
    docs: State<'_, Docs>,
) -> Result<Pasted, String> {
    let (done, error) = blocking(move || {
        let mut done = Vec::new();
        for from in paths {
            let pasted = if cut {
                dir::move_into(&from, &into)
            } else {
                dir::copy_into(&from, &into)
            };
            match pasted {
                Ok(to) => done.push((from, to)),
                Err(e) => return Ok((done, Some(at_path(&from, &e)))),
            }
        }
        Ok((done, None))
    })
    .await?;
    let docs = if cut {
        done.iter()
            .flat_map(|(from, to)| docs.follow(from, to))
            .collect()
    } else {
        Vec::new()
    };
    let to = done
        .iter()
        .map(|(_, to)| to.display().to_string())
        .collect();
    Ok(Pasted { to, docs, error })
}

/// Moves a file or folder to the Recycle Bin (the Trash).
#[tauri::command]
pub async fn delete_path(path: PathBuf) -> Result<(), String> {
    blocking(move || {
        #[allow(unused_mut)]
        let mut trash = trash::TrashContext::new();
        // Asking the Finder would need a permission, and make its sound.
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            trash.set_delete_method(DeleteMethod::NsFileManager);
        }
        trash
            .delete(&path)
            .map_err(|e| format!("{}: {e}", path.display()))
    })
    .await
}

/// Shows the file or folder selected in File Explorer (the Finder).
#[tauri::command]
pub fn reveal_path(path: PathBuf) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Opens the system's terminal in `dir`.
#[tauri::command]
pub fn open_terminal(dir: PathBuf) -> Result<(), String> {
    terminal(&dir).map_err(|e| format!("{}: {e}", dir.display()))
}

/// Windows Terminal where it is installed, the console otherwise.
#[cfg(windows)]
fn terminal(dir: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NEW_CONSOLE: u32 = 0x10;
    if Command::new("wt.exe").arg("-d").arg(dir).spawn().is_ok() {
        return Ok(());
    }
    Command::new("cmd.exe")
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(drop)
}

#[cfg(not(windows))]
fn terminal(dir: &Path) -> std::io::Result<()> {
    use std::process::Command;
    let mut command = if cfg!(target_os = "macos") {
        let mut open = Command::new("open");
        open.args(["-a", "Terminal"]).arg(dir);
        open
    } else {
        let mut emulator = Command::new("x-terminal-emulator");
        emulator.current_dir(dir);
        emulator
    };
    let mut child = command.spawn()?;
    // Reaped when it exits, so as not to leave a zombie.
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[tauri::command]
pub fn write_clipboard(text: String, app: AppHandle) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
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
pub async fn list_dir(path: PathBuf, show_hidden: bool) -> Result<Vec<dir::Entry>, String> {
    blocking(move || dir::list(&path, show_hidden).map_err(|e| at_path(&path, &e))).await
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
    fallback: Encoding,
    docs: State<'_, Docs>,
) -> Result<DocInfo, String> {
    let doc = blocking(move || {
        Document::open_as(&path, encoding, fallback).map_err(|e| at_path(&path, &e))
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
    fallback: Encoding,
    docs: State<'_, Docs>,
) -> Result<Encoding, String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .set_encoding(encoding, fallback)
            .map_err(|e| ipc_message(&e))
    })
    .await
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
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// A new, empty document without a file; the frontend names it. Without an
/// `eol` it takes the platform's.
#[tauri::command]
pub fn new_document(encoding: Encoding, eol: Option<Eol>, docs: State<'_, Docs>) -> DocInfo {
    docs.add(Document::untitled(
        encoding,
        eol.unwrap_or_else(Eol::platform),
    ))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// The settings file's text; none before the first change.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    settings::load(&settings_path(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(text: String, app: AppHandle) -> Result<(), String> {
    settings::save(&settings_path(&app)?, &text).map_err(|e| e.to_string())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn close_document(id: u32, docs: State<'_, Docs>) {
    let mut documents = docs.open.lock().unwrap();
    let Some(open) = documents.get(&id) else {
        return;
    };
    if open.windows.fetch_sub(1, Ordering::Relaxed) > 1 {
        return;
    }
    open.find_cancel
        .lock()
        .unwrap()
        .store(true, Ordering::Relaxed);
    documents.remove(&id);
}

/// Another window is going to show the document.
#[tauri::command]
pub fn retain_document(id: u32, docs: State<'_, Docs>) -> Result<(), String> {
    docs.get(id)?.windows.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn document_windows(id: u32, docs: State<'_, Docs>) -> Result<u32, String> {
    Ok(docs.get(id)?.windows.load(Ordering::Relaxed))
}

/// Opens another window, which gets `start` from `window_start`. Async because
/// making a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_window(
    start: Value,
    app: AppHandle,
    starts: State<'_, WindowStarts>,
) -> Result<(), String> {
    let label = format!(
        "editor-{}",
        starts.next_id.fetch_add(1, Ordering::Relaxed) + 1
    );
    starts.waiting.lock().unwrap().insert(label.clone(), start);
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("HU Editor")
        .inner_size(1280.0, 800.0)
        .min_inner_size(480.0, 320.0)
        .build();
    if let Err(error) = built {
        starts.waiting.lock().unwrap().remove(&label);
        return Err(error.to_string());
    }
    Ok(())
}

/// What this window was opened to show; `None` for the first window.
#[tauri::command]
pub fn window_start(window: WebviewWindow, starts: State<'_, WindowStarts>) -> Option<Value> {
    starts.waiting.lock().unwrap().remove(window.label())
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
    blocking(move || open.doc.dialect().map_err(|e| ipc_message(&e))).await
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
    blocking(move || open.doc.view(target, rows).map_err(|e| ipc_message(&e))).await
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
    let text =
        blocking(move || open.doc.copy_text(start, end).map_err(|e| ipc_message(&e))).await?;
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
            .map_err(|e| ipc_message(&e))?
            .map(|(result, last_line)| BoxEdit { result, last_line }))
    })
    .await
}

/// The text on the clipboard, empty if there is none.
#[tauri::command]
pub fn read_clipboard(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
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
            .map_err(|e| ipc_message(&e))
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
    whole_word: bool,
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
                Matching {
                    case_sensitive,
                    whole_word,
                },
                (anchor, caret),
                &cancel,
                &mut progress,
            )
            .map_err(|e| ipc_message(&e))?;
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
        open.doc
            .save(&AtomicBool::new(false), &mut progress)
            .map_err(|e| at_path(&open.doc.path().unwrap_or_default(), &e))?;
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
            .map_err(|e| at_path(&path, &e))?;
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
    whole_word: bool,
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
            matching: Matching {
                case_sensitive,
                whole_word,
            },
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
            .map_err(|e| ipc_message(&e))
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
