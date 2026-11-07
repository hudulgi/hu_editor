//! IPC commands. The frontend never holds the file, only the lines it is
//! about to draw; edits are sent as byte ranges and text.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hu_core::files::{self, FileMatches, FileSearch, Globs, Searched, Source};
use hu_core::{
    BlockKind, BoxRows, Dialect, DocState, Document, EditKind, EditResult, Encoding, Eol,
    FindResult, IndexStatus, MatchCount, Query, View, ViewTarget, dir, ipc_message, settings,
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
    /// Cancels the running count of matches; a new count replaces it.
    count_cancel: Mutex<Arc<AtomicBool>>,
    /// How many windows show it; it closes with the last.
    windows: AtomicU32,
}

/// Cancels the running Find in Files; a new one replaces it.
#[derive(Default)]
pub struct FileSearches(Mutex<Arc<AtomicBool>>);

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
            count_cancel: Mutex::default(),
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

    /// The open document of the file at `path`, if any.
    fn of_path(&self, path: &Path) -> Option<(u32, Arc<OpenDoc>)> {
        let open = self.open.lock().unwrap();
        open.iter()
            .find(|(_, one)| one.doc.path().is_some_and(|p| p == path))
            .map(|(&id, one)| (id, one.clone()))
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
        let mut progress = throttled(on_progress);
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
    for slot in [&open.find_cancel, &open.count_cancel] {
        slot.lock().unwrap().store(true, Ordering::Relaxed);
    }
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
    query: Query,
    replacement: String,
    preserve_case: bool,
    anchor: u64,
    caret: u64,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<ReplaceOutcome, String> {
    let open = docs.get(id)?;
    let cancel = replace_cancel(&open.find_cancel);
    blocking(move || {
        let mut progress = throttled(on_progress);
        let done = open
            .doc
            .replace_all(
                &query,
                &replacement,
                preserve_case,
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

/// A new flag in `slot`, the one it replaces set: the work it was for stops.
fn replace_cancel(slot: &Mutex<Arc<AtomicBool>>) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    let previous = std::mem::replace(&mut *slot.lock().unwrap(), cancel.clone());
    previous.store(true, Ordering::Relaxed);
    cancel
}

/// Sends progress to the frontend ten times a second at most.
fn throttled(channel: Channel<u64>) -> impl FnMut(u64) {
    let mut last = Instant::now();
    move |done| {
        if last.elapsed() >= Duration::from_millis(100) {
            last = Instant::now();
            let _ = channel.send(done);
        }
    }
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
        let mut progress = throttled(on_progress);
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
        let mut progress = throttled(on_progress);
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

/// The next match after the selection (the one before it `backward`),
/// streaming the number of bytes searched to `on_progress`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn find(
    id: u32,
    query: Query,
    anchor: u64,
    caret: u64,
    backward: bool,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<FindOutcome, String> {
    let open = docs.get(id)?;
    let cancel = replace_cancel(&open.find_cancel);
    let result = blocking(move || {
        let mut progress = throttled(on_progress);
        open.doc
            .find(&query, (anchor, caret), backward, &cancel, &mut progress)
            .map_err(|e| ipc_message(&e))
    })
    .await?;
    Ok(match result {
        FindResult::Found(start, end) => FindOutcome::Found {
            offset: start,
            len: end - start,
        },
        FindResult::NotFound => FindOutcome::NotFound,
        FindResult::Cancelled => FindOutcome::Cancelled,
    })
}

/// How many matches there are and which one is selected; `None` if a newer
/// count or `cancel_find` stopped it. Streams the bytes read to `on_progress`.
#[tauri::command]
pub async fn count_matches(
    id: u32,
    query: Query,
    anchor: u64,
    caret: u64,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
) -> Result<Option<MatchCount>, String> {
    let open = docs.get(id)?;
    let cancel = replace_cancel(&open.count_cancel);
    blocking(move || {
        let mut progress = throttled(on_progress);
        open.doc
            .count(&query, (anchor, caret), &cancel, &mut progress)
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// Where the matches starting in `[from, to)` are, to mark them on screen.
#[tauri::command]
pub async fn matches_in(
    id: u32,
    query: Query,
    from: u64,
    to: u64,
    docs: State<'_, Docs>,
) -> Result<Vec<(u64, u64)>, String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .matches_in(&query, from, to)
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// What the selection would be replaced with, if it is a match.
#[tauri::command]
pub async fn replacement_for(
    id: u32,
    query: Query,
    replacement: String,
    preserve_case: bool,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<Option<String>, String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .replacement_for(&query, &replacement, preserve_case, (anchor, caret))
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// Stops the running search, replace or count.
#[tauri::command]
pub async fn cancel_find(id: u32, docs: State<'_, Docs>) -> Result<(), String> {
    let open = docs.get(id)?;
    for slot in [&open.find_cancel, &open.count_cancel] {
        slot.lock().unwrap().store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Toggle Line Comment with `marker`, at each line's start for a deck.
#[tauri::command]
pub async fn toggle_line_comment(
    id: u32,
    marker: String,
    at_start: bool,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<Option<EditResult>, String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .toggle_line_comment(&marker, at_start, (anchor, caret))
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// Toggle Block Comment between `open` and `close`.
#[tauri::command]
pub async fn toggle_block_comment(
    id: u32,
    open: String,
    close: String,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<Option<EditResult>, String> {
    let doc = docs.get(id)?;
    blocking(move || {
        doc.doc
            .toggle_block_comment(&open, &close, (anchor, caret))
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// Find in Files under `folder`, each file's matches streamed to
/// `on_found` as they come and the files searched to `on_progress`. A file
/// open here is searched as it is open, unsaved changes included.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_files(
    folder: PathBuf,
    mut query: Query,
    include: String,
    exclude: String,
    fallback: Encoding,
    on_found: Channel<FileMatches>,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
    searches: State<'_, FileSearches>,
) -> Result<Searched, String> {
    query.scope = None;
    let cancel = replace_cancel(&searches.0);
    let open: Vec<(PathBuf, Arc<OpenDoc>)> = {
        let open = docs.open.lock().unwrap();
        open.values()
            .filter_map(|one| one.doc.path().map(|p| (p, one.clone())))
            .collect()
    };
    blocking(move || {
        let include = Globs::new(&include).map_err(|e| ipc_message(&e.into()))?;
        let exclude = Globs::new(&exclude).map_err(|e| ipc_message(&e.into()))?;
        let search = FileSearch {
            folder: &folder,
            query: &query,
            include: &include,
            exclude: &exclude,
            fallback,
        };
        let source = |path: &Path| match open.iter().find(|(p, _)| p == path) {
            Some((_, one)) => Source::Open(Box::new(one.doc.text()), one.doc.encoding()),
            None => Source::Disk,
        };
        let mut progress = throttled(on_progress);
        files::search_files(
            &search,
            &source,
            &cancel,
            &mut |found| {
                let _ = on_found.send(found);
            },
            &mut progress,
        )
        .map_err(|e| ipc_message(&e))
    })
    .await
}

#[tauri::command]
pub fn cancel_search_files(searches: State<'_, FileSearches>) {
    searches.0.lock().unwrap().store(true, Ordering::Relaxed);
}

/// What Replace in Files did to one file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReplaced {
    path: String,
    count: usize,
    error: Option<String>,
    /// A file open in the editor is replaced there, unsaved, with this change.
    doc: Option<u32>,
    result: Option<EditResult>,
}

/// Replace in Files: a file open in the editor is replaced there, as one
/// undo step left unsaved; any other is replaced and saved.
#[tauri::command]
pub async fn replace_in_files(
    paths: Vec<PathBuf>,
    mut query: Query,
    replacement: String,
    preserve_case: bool,
    fallback: Encoding,
    docs: State<'_, Docs>,
) -> Result<Vec<FileReplaced>, String> {
    query.scope = None;
    let open: Vec<Option<(u32, Arc<OpenDoc>)>> = paths.iter().map(|p| docs.of_path(p)).collect();
    blocking(move || {
        let never = AtomicBool::new(false);
        Ok(paths
            .into_iter()
            .zip(open)
            .map(|(path, open)| {
                let mut done = FileReplaced {
                    path: path.display().to_string(),
                    count: 0,
                    error: None,
                    doc: None,
                    result: None,
                };
                let replaced = match open {
                    Some((id, one)) => one
                        .doc
                        .replace_all(
                            &query,
                            &replacement,
                            preserve_case,
                            (0, 0),
                            &never,
                            &mut |_| {},
                        )
                        .map(|r| {
                            let (count, result) = r.unwrap_or((0, None));
                            done.doc = Some(id);
                            done.result = result;
                            count
                        }),
                    None => {
                        files::replace_in_file(&path, &query, &replacement, preserve_case, fallback)
                    }
                };
                match replaced {
                    Ok(count) => done.count = count,
                    Err(e) => done.error = Some(at_path(&path, &e)),
                }
                done
            })
            .collect())
    })
    .await
}

/// Move Line Up or Down; `None` at the top or the bottom.
#[tauri::command]
pub async fn move_lines(
    id: u32,
    up: bool,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<Option<EditResult>, String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .move_lines(up, (anchor, caret))
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// Copy Line Up or Down.
#[tauri::command]
pub async fn copy_lines(
    id: u32,
    up: bool,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<Option<EditResult>, String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .copy_lines(up, (anchor, caret))
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// Duplicate Selection; without one, the line.
#[tauri::command]
pub async fn duplicate_selection(
    id: u32,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<Option<EditResult>, String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .duplicate_selection((anchor, caret))
            .map_err(|e| ipc_message(&e))
    })
    .await
}

/// The block the selection's lines are in, for Expand Selection.
#[tauri::command]
pub async fn block_around(
    id: u32,
    kind: BlockKind,
    anchor: u64,
    caret: u64,
    docs: State<'_, Docs>,
) -> Result<(u64, u64), String> {
    let open = docs.get(id)?;
    blocking(move || {
        open.doc
            .block_around(kind, (anchor, caret))
            .map_err(|e| ipc_message(&e))
    })
    .await
}
