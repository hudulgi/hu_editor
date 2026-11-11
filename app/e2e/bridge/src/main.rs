//! Serves the app's commands over HTTP, so the real frontend can run against
//! the real core in a browser (see `app/e2e`). Each command here mirrors one in
//! `app/src-tauri/src/commands.rs`; `run.mjs` stops if one is missing.
//!
//! Differences from the app: progress is not reported, a search cannot be
//! cancelled, the clipboard is a string here, and the settings file's path
//! comes with the request. What the app streams through a channel comes all
//! at once, in `__channels` beside the answer, for the page to hand on. A delete is for good, not to the trash, and the
//! file manager, terminal and web links asked for are only noted.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use hu_core::compare::{Comparison, Side};
use hu_core::files::{self, FileSearch, Globs, Source};
use hu_core::{
    BlockKind, BoxRows, Document, EditKind, Encoding, Eol, FindResult, Query, ViewTarget, dir,
    ipc_message, markdown, settings,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// A comparison's documents, and it once compared.
type Compared = ([u32; 2], Option<Comparison>);

#[derive(Default)]
struct Bridge {
    docs: Mutex<HashMap<u32, Arc<Document>>>,
    next_id: AtomicU32,
    /// How many windows show each document.
    doc_windows: Mutex<HashMap<u32, u32>>,
    window_starts: Mutex<HashMap<String, Value>>,
    next_window: AtomicU32,
    clipboard: Mutex<String>,
    /// What the file manager or a terminal was asked to show.
    launched: Mutex<Vec<Value>>,
    /// The documents of each comparison, and it once compared.
    comparisons: Mutex<HashMap<u32, Compared>>,
    next_comparison: AtomicU32,
}

fn main() {
    let port = std::env::args()
        .nth(1)
        .expect("usage: hu-e2e-bridge <port>");
    let listener = TcpListener::bind(("127.0.0.1", port.parse().expect("port"))).expect("bind");
    let bridge = Arc::new(Bridge::default());
    for stream in listener.incoming() {
        let bridge = bridge.clone();
        let stream = stream.expect("connection");
        std::thread::spawn(move || {
            if let Err(e) = serve(stream, &bridge) {
                eprintln!("bridge: {e}");
            }
        });
    }
}

/// Answers one request; the page only sends `POST`s of `{ cmd, args }`.
fn serve(mut stream: TcpStream, bridge: &Bridge) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let is_post = line.starts_with("POST");
    let mut len = 0;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            len = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    let answer = if is_post {
        let request: Value = serde_json::from_slice(&body).map_err(io::Error::other)?;
        let cmd = request["cmd"].as_str().unwrap_or("");
        match bridge.dispatch(cmd, &request["args"]) {
            Ok(value) => json!({ "ok": value }),
            Err(error) => json!({ "err": error }),
        }
        .to_string()
    } else {
        String::new()
    };
    write!(
        stream,
        "HTTP/1.1 200 OK\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{answer}",
        answer.len()
    )
}

/// An argument, by the name the frontend gives it; as in the app, a missing
/// one is an error unless its type allows null.
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args[name].clone()).map_err(|e| format!("argument {name}: {e}"))
}

fn to_json(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn problem(error: io::Error) -> String {
    ipc_message(&error)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

impl Bridge {
    fn doc(&self, args: &Value) -> Result<Arc<Document>, String> {
        let id: u32 = arg(args, "id")?;
        let docs = self.docs.lock().unwrap();
        docs.get(&id).cloned().ok_or_else(|| "not open".to_string())
    }

    fn add(&self, doc: Document, path: Option<&Path>) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let info = json!({
            "id": id,
            "path": path,
            "name": path.map_or_else(String::new, file_name),
            "encoding": doc.encoding(),
            "eol": doc.eol(),
            "state": doc.state(),
        });
        self.docs.lock().unwrap().insert(id, Arc::new(doc));
        self.doc_windows.lock().unwrap().insert(id, 1);
        info
    }

    /// As in the app: the open documents that were `from` or in it save under `to`.
    fn follow(&self, from: &Path, to: &Path) -> Vec<Value> {
        let docs = self.docs.lock().unwrap();
        let mut moved = Vec::new();
        for (&id, doc) in docs.iter() {
            let Some(new) = doc.path().and_then(|path| dir::moved(&path, from, to)) else {
                continue;
            };
            doc.moved_to(new.clone());
            moved.push(json!({ "id": id, "path": new, "name": file_name(&new) }));
        }
        moved
    }

    fn doc_of(&self, id: u32) -> Result<Arc<Document>, String> {
        let docs = self.docs.lock().unwrap();
        docs.get(&id).cloned().ok_or_else(|| "not open".to_string())
    }

    /// As in the app: `f` on comparison `id`, with both documents as they are now.
    fn compared<T>(
        &self,
        args: &Value,
        f: impl FnOnce(&mut Comparison, [Arc<Document>; 2]) -> Result<T, String>,
    ) -> Result<T, String> {
        let id: u32 = arg(args, "id")?;
        let mut all = self.comparisons.lock().unwrap();
        let (ids, slot) = all.get_mut(&id).ok_or("comparison not open")?;
        let docs = [self.doc_of(ids[0])?, self.doc_of(ids[1])?];
        let comparison = slot.as_mut().ok_or("not compared yet")?;
        for (side, doc) in [Side::Left, Side::Right].into_iter().zip(&docs) {
            comparison.sync(side, doc.text()).map_err(problem)?;
        }
        f(comparison, docs)
    }

    fn dispatch(&self, cmd: &str, args: &Value) -> Result<Value, String> {
        let never = AtomicBool::new(false);
        let doc = || self.doc(args);
        Ok(match cmd {
            "launch_path" => Value::Null,
            "notices_path" => to_json(
                std::fs::canonicalize(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../src-tauri/THIRD_PARTY_NOTICES.txt"
                ))
                .map_err(problem)?,
            )?,
            "roots" => to_json(dir::roots())?,
            "list_dir" => {
                let path: PathBuf = arg(args, "path")?;
                let listed = dir::list(&path, arg(args, "showHidden")?);
                to_json(listed.map_err(problem)?)?
            }
            "path_chain" => json!(dir::chain(&arg::<PathBuf>(args, "path")?)),
            "path_kind" => match std::fs::metadata(arg::<PathBuf>(args, "path")?) {
                Ok(meta) if meta.is_dir() => json!("dir"),
                Ok(_) => json!("file"),
                Err(_) => Value::Null,
            },
            "create_file" => {
                dir::create_file(&arg::<PathBuf>(args, "path")?).map_err(problem)?;
                Value::Null
            }
            "create_dir" => {
                dir::create_dir(&arg::<PathBuf>(args, "path")?).map_err(problem)?;
                Value::Null
            }
            "rename_path" => {
                let (from, to): (PathBuf, PathBuf) = (arg(args, "from")?, arg(args, "to")?);
                dir::rename(&from, &to).map_err(problem)?;
                json!(self.follow(&from, &to))
            }
            "paste" => {
                let paths: Vec<PathBuf> = arg(args, "paths")?;
                let into: PathBuf = arg(args, "into")?;
                let cut: bool = arg(args, "cut")?;
                let (mut to, mut docs, mut error) = (Vec::new(), Vec::new(), None);
                for from in paths {
                    let pasted = if cut {
                        dir::move_into(&from, &into)
                    } else {
                        dir::copy_into(&from, &into)
                    };
                    match pasted {
                        Ok(at) => {
                            if cut {
                                docs.extend(self.follow(&from, &at));
                            }
                            to.push(at);
                        }
                        Err(e) => {
                            error = Some(problem(e));
                            break;
                        }
                    }
                }
                json!({ "to": to, "docs": docs, "error": error })
            }
            "delete_path" => {
                dir::remove(&arg::<PathBuf>(args, "path")?).map_err(problem)?;
                Value::Null
            }
            "reveal_path" | "open_terminal" => {
                let path: PathBuf = arg(args, if cmd == "reveal_path" { "path" } else { "dir" })?;
                self.launched.lock().unwrap().push(json!([cmd, path]));
                Value::Null
            }
            "open_url" => {
                let url: String = arg(args, "url")?;
                if !markdown::is_web_link(&url) {
                    return Err(format!("{url}: not a web or mail link"));
                }
                self.launched.lock().unwrap().push(json!([cmd, url]));
                Value::Null
            }
            "image_data" => {
                let path: PathBuf = arg(args, "path")?;
                to_json(markdown::image_data(&path).map_err(problem)?)?
            }
            "write_clipboard" => {
                *self.clipboard.lock().unwrap() = arg(args, "text")?;
                Value::Null
            }
            "open_document" => {
                let path: PathBuf = arg(args, "path")?;
                let doc = Document::open_as(&path, arg(args, "encoding")?, arg(args, "fallback")?);
                self.add(doc.map_err(problem)?, Some(&path))
            }
            "new_document" => {
                let eol: Option<Eol> = arg(args, "eol")?;
                let doc =
                    Document::untitled(arg(args, "encoding")?, eol.unwrap_or(Eol::platform()));
                self.add(doc, None)
            }
            "load_settings" => {
                let path: PathBuf = arg(args, "path")?;
                json!(settings::load(&path).map_err(|e| e.to_string())?)
            }
            "save_settings" => {
                let (path, text): (PathBuf, String) = (arg(args, "path")?, arg(args, "text")?);
                settings::save(&path, &text).map_err(|e| e.to_string())?;
                Value::Null
            }
            "close_document" => {
                let id: u32 = arg(args, "id")?;
                let mut windows = self.doc_windows.lock().unwrap();
                if let Some(count) = windows.get_mut(&id) {
                    *count -= 1;
                    if *count == 0 {
                        windows.remove(&id);
                        self.docs.lock().unwrap().remove(&id);
                    }
                }
                Value::Null
            }
            "retain_document" => {
                doc()?;
                let id: u32 = arg(args, "id")?;
                *self.doc_windows.lock().unwrap().entry(id).or_insert(0) += 1;
                Value::Null
            }
            "document_windows" => {
                doc()?;
                let id: u32 = arg(args, "id")?;
                json!(self.doc_windows.lock().unwrap().get(&id))
            }
            // The label goes back to the page here: the scenarios make the window.
            "open_window" => {
                let id = self.next_window.fetch_add(1, Ordering::Relaxed) + 1;
                let label = format!("editor-{id}");
                let start: Value = arg(args, "start")?;
                self.window_starts
                    .lock()
                    .unwrap()
                    .insert(label.clone(), start);
                json!(label)
            }
            "open_compare_window" => {
                let id = self.next_window.fetch_add(1, Ordering::Relaxed) + 1;
                let label = format!("compare-{id}");
                let start: Value = arg(args, "start")?;
                self.window_starts
                    .lock()
                    .unwrap()
                    .insert(label.clone(), start);
                json!(label)
            }
            "compare_new" => {
                let ids: [u32; 2] = [arg(args, "left")?, arg(args, "right")?];
                let work = 2 * (self.doc_of(ids[0])?.len() + self.doc_of(ids[1])?.len());
                let id = self.next_comparison.fetch_add(1, Ordering::Relaxed) + 1;
                self.comparisons.lock().unwrap().insert(id, (ids, None));
                json!({ "id": id, "work": work })
            }
            "compare_run" => {
                let id: u32 = arg(args, "id")?;
                let ids = self
                    .comparisons
                    .lock()
                    .unwrap()
                    .get(&id)
                    .ok_or("comparison not open")?
                    .0;
                let (left, right) = (self.doc_of(ids[0])?, self.doc_of(ids[1])?);
                left.wait_for_index();
                right.wait_for_index();
                let work = 2 * (left.len() + right.len());
                let made = Comparison::new(left.text(), right.text(), &never, &mut |_| {})
                    .map_err(problem)?;
                let comparison = made.expect("not cancelled");
                let compared =
                    json!({ "rows": comparison.rows(), "hunks": comparison.hunk_count() });
                if let Some(entry) = self.comparisons.lock().unwrap().get_mut(&id) {
                    entry.1 = Some(comparison);
                }
                json!({ "__channels": { "onProgress": [work, u64::MAX] }, "value": compared })
            }
            "compare_view" => {
                let (top, rows): (u64, usize) = (arg(args, "top")?, arg(args, "rows")?);
                self.compared(args, |c, _| to_json(c.view(top, rows).map_err(problem)?))?
            }
            "compare_overview" => {
                let buckets: usize = arg(args, "buckets")?;
                self.compared(args, |c, _| Ok(json!(c.overview(buckets.min(1 << 16)))))?
            }
            "compare_hunk" => {
                let index: Option<usize> = arg(args, "index")?;
                let from: Option<u64> = arg(args, "from")?;
                let forward: bool = arg(args, "forward")?;
                let near: Option<u64> = arg(args, "near")?;
                let reach: Option<u64> = arg(args, "reach")?;
                self.compared(args, |c, _| {
                    to_json(match (index, from, near) {
                        (Some(index), _, _) => c.hunk_rows(index),
                        (None, Some(row), _) => c.hunk_from(row, forward),
                        (None, None, Some(row)) => c.hunk_near(row, reach.unwrap_or(0)),
                        (None, None, None) => None,
                    })
                })?
            }
            "compare_merge" => {
                let index: usize = arg(args, "index")?;
                let to: Side = arg(args, "to")?;
                let ids = {
                    let id: u32 = arg(args, "id")?;
                    self.comparisons
                        .lock()
                        .unwrap()
                        .get(&id)
                        .ok_or("comparison not open")?
                        .0
                };
                let side = if to == Side::Left { 0 } else { 1 };
                self.compared(args, |c, docs| {
                    let target = &docs[side];
                    let merge = c.merge(index, to).map_err(problem)?;
                    let before = (merge.start, merge.start);
                    let result =
                        target.edit(merge.start, merge.end, &merge.text, EditKind::Other, before);
                    c.sync(to, target.text()).map_err(problem)?;
                    Ok(json!({ "doc": ids[side], "result": to_json(result)? }))
                })?
            }
            "compare_edit_line" => {
                let side: Side = arg(args, "side")?;
                let line: u64 = arg(args, "line")?;
                let text: String = arg(args, "text")?;
                let ids = {
                    let id: u32 = arg(args, "id")?;
                    self.comparisons
                        .lock()
                        .unwrap()
                        .get(&id)
                        .ok_or("comparison not open")?
                        .0
                };
                let at = if side == Side::Left { 0 } else { 1 };
                self.compared(args, |c, docs| {
                    let target = &docs[at];
                    let (start, end) = c.line_range(side, line).map_err(problem)?;
                    let result = target.edit(start, end, &text, EditKind::Other, (start, start));
                    c.sync(side, target.text()).map_err(problem)?;
                    Ok(json!({ "doc": ids[at], "result": to_json(result)? }))
                })?
            }
            "compare_close" => {
                let id: u32 = arg(args, "id")?;
                self.comparisons.lock().unwrap().remove(&id);
                Value::Null
            }
            "window_start" => {
                let label: String = arg(args, "label")?;
                let start = self.window_starts.lock().unwrap().remove(&label);
                start.unwrap_or(Value::Null)
            }
            "index_status" => to_json(doc()?.index_status())?,
            "disk_changed" => json!(doc()?.changed_on_disk()),
            "detect_dialect" => to_json(doc()?.dialect().map_err(problem)?)?,
            "render_markdown" => to_json(markdown::preview(&*doc()?).map_err(problem)?)?,
            "view" => {
                let target: ViewTarget = arg(args, "target")?;
                to_json(doc()?.view(target, arg(args, "rows")?).map_err(problem)?)?
            }
            "edit" => {
                let text: String = arg(args, "text")?;
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                let (start, end) = (arg(args, "start")?, arg(args, "end")?);
                let kind: EditKind = arg(args, "kind")?;
                to_json(doc()?.edit(start, end, &text, kind, before))?
            }
            "undo" => to_json(doc()?.undo())?,
            "redo" => to_json(doc()?.redo())?,
            "copy" => {
                let text = doc()?.copy_text(arg(args, "start")?, arg(args, "end")?);
                *self.clipboard.lock().unwrap() = text.map_err(problem)?;
                Value::Null
            }
            "edit_box" => {
                let rows: BoxRows = arg(args, "rows")?;
                let texts: Vec<String> = arg(args, "texts")?;
                let kind: EditKind = arg(args, "kind")?;
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                let (left, right) = (arg(args, "left")?, arg(args, "right")?);
                let edited = doc()?
                    .edit_box(arg(args, "top")?, rows, left, right, &texts, kind, before)
                    .map_err(problem)?;
                match edited {
                    Some((result, last_line)) => json!({
                        "result": to_json(result)?,
                        "lastLine": last_line,
                    }),
                    None => Value::Null,
                }
            }
            "copy_box" => {
                let text = doc()?.box_text(
                    arg(args, "top")?,
                    arg(args, "bottom")?,
                    arg(args, "left")?,
                    arg(args, "right")?,
                );
                *self.clipboard.lock().unwrap() = text.map_err(problem)?;
                Value::Null
            }
            "replace_all" => {
                let (query, replacement): (Query, String) =
                    (arg(args, "query")?, arg(args, "replacement")?);
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                let keep_case = arg(args, "preserveCase")?;
                let done = doc()?
                    .replace_all(&query, &replacement, keep_case, before, &never, &mut |_| {})
                    .map_err(problem)?;
                match done {
                    Some((count, result)) => {
                        json!({ "kind": "replaced", "count": count, "result": to_json(result)? })
                    }
                    None => json!({ "kind": "cancelled" }),
                }
            }
            "save" => {
                let doc = doc()?;
                doc.save(&never, &mut |_| {}).map_err(problem)?;
                to_json(doc.state())?
            }
            "save_as" => {
                let doc = doc()?;
                let path: PathBuf = arg(args, "path")?;
                doc.save_as(&path, &never, &mut |_| {}).map_err(problem)?;
                json!({ "path": path, "name": file_name(&path), "state": doc.state() })
            }
            "set_encoding" => {
                let chosen: Option<Encoding> = arg(args, "encoding")?;
                let set = doc()?.set_encoding(chosen, arg(args, "fallback")?);
                to_json(set.map_err(problem)?)?
            }
            "save_converted" => {
                let path: PathBuf = arg(args, "path")?;
                let encoding: Encoding = arg(args, "encoding")?;
                doc()?
                    .save_converted(&path, encoding, &never, &mut |_| {})
                    .map_err(problem)?;
                Value::Null
            }
            "find" => {
                let query: Query = arg(args, "query")?;
                let selection = (arg(args, "anchor")?, arg(args, "caret")?);
                let found = doc()?
                    .find(
                        &query,
                        selection,
                        arg(args, "backward")?,
                        &never,
                        &mut |_| {},
                    )
                    .map_err(problem)?;
                match found {
                    FindResult::Found(start, end) => {
                        json!({ "kind": "found", "offset": start, "len": end - start })
                    }
                    FindResult::NotFound => json!({ "kind": "notFound" }),
                    FindResult::Cancelled => json!({ "kind": "cancelled" }),
                }
            }
            "count_matches" => {
                let query: Query = arg(args, "query")?;
                let selection = (arg(args, "anchor")?, arg(args, "caret")?);
                let counted = doc()?.count(&query, selection, &never, &mut |_| {});
                to_json(counted.map_err(problem)?)?
            }
            "matches_in" => {
                let query: Query = arg(args, "query")?;
                let marks = doc()?.matches_in(&query, arg(args, "from")?, arg(args, "to")?);
                to_json(marks.map_err(problem)?)?
            }
            "replacement_for" => {
                let (query, replacement): (Query, String) =
                    (arg(args, "query")?, arg(args, "replacement")?);
                let selection = (arg(args, "anchor")?, arg(args, "caret")?);
                let keep_case = arg(args, "preserveCase")?;
                let replaced = doc()?.replacement_for(&query, &replacement, keep_case, selection);
                to_json(replaced.map_err(problem)?)?
            }
            "cancel_find" | "cancel_search_files" => Value::Null,
            "move_lines" | "copy_lines" => {
                let up: bool = arg(args, "up")?;
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                let doc = doc()?;
                let done = if cmd == "move_lines" {
                    doc.move_lines(up, before)
                } else {
                    doc.copy_lines(up, before)
                };
                to_json(done.map_err(problem)?)?
            }
            "duplicate_selection" => {
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                to_json(doc()?.duplicate_selection(before).map_err(problem)?)?
            }
            "block_around" => {
                let kind: BlockKind = arg(args, "kind")?;
                let selection = (arg(args, "anchor")?, arg(args, "caret")?);
                to_json(doc()?.block_around(kind, selection).map_err(problem)?)?
            }
            "toggle_line_comment" => {
                let marker: String = arg(args, "marker")?;
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                let done = doc()?.toggle_line_comment(&marker, arg(args, "atStart")?, before);
                to_json(done.map_err(problem)?)?
            }
            "toggle_block_comment" => {
                let (open, close): (String, String) = (arg(args, "open")?, arg(args, "close")?);
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                to_json(
                    doc()?
                        .toggle_block_comment(&open, &close, before)
                        .map_err(problem)?,
                )?
            }
            "search_files" => {
                let folder: PathBuf = arg(args, "folder")?;
                let mut query: Query = arg(args, "query")?;
                query.scope = None;
                let include =
                    Globs::new(&arg::<String>(args, "include")?).map_err(|e| problem(e.into()))?;
                let exclude =
                    Globs::new(&arg::<String>(args, "exclude")?).map_err(|e| problem(e.into()))?;
                let search = FileSearch {
                    folder: &folder,
                    query: &query,
                    include: &include,
                    exclude: &exclude,
                    fallback: arg(args, "fallback")?,
                };
                let open: Vec<(PathBuf, Arc<Document>)> = {
                    let docs = self.docs.lock().unwrap();
                    docs.values()
                        .filter_map(|d| d.path().map(|p| (p, d.clone())))
                        .collect()
                };
                let source = |path: &Path| match open.iter().find(|(p, _)| p == path) {
                    Some((_, doc)) => Source::Open(Box::new(doc.text()), doc.encoding()),
                    None => Source::Disk,
                };
                let mut found = Vec::new();
                let done = files::search_files(
                    &search,
                    &source,
                    &never,
                    &mut |m| found.push(m),
                    &mut |_| {},
                )
                .map_err(problem)?;
                json!({ "__channels": { "onFound": to_json(found)? }, "value": to_json(done)? })
            }
            "replace_in_files" => {
                let paths: Vec<PathBuf> = arg(args, "paths")?;
                let mut query: Query = arg(args, "query")?;
                query.scope = None;
                let replacement: String = arg(args, "replacement")?;
                let keep_case: bool = arg(args, "preserveCase")?;
                let fallback: Encoding = arg(args, "fallback")?;
                let mut out = Vec::new();
                for path in paths {
                    let open = {
                        let docs = self.docs.lock().unwrap();
                        docs.iter()
                            .find(|(_, d)| d.path().is_some_and(|p| p == path))
                            .map(|(&id, d)| (id, d.clone()))
                    };
                    let (mut doc_id, mut result) = (None, None);
                    let replaced = match open {
                        Some((id, doc)) => doc
                            .replace_all(
                                &query,
                                &replacement,
                                keep_case,
                                (0, 0),
                                &never,
                                &mut |_| {},
                            )
                            .map(|r| {
                                let (count, edit) = r.unwrap_or((0, None));
                                doc_id = Some(id);
                                result = edit;
                                count
                            }),
                        None => {
                            files::replace_in_file(&path, &query, &replacement, keep_case, fallback)
                        }
                    };
                    let (count, error) = match replaced {
                        Ok(count) => (count, None),
                        Err(e) => (0, Some(problem(e))),
                    };
                    out.push(json!({ "path": path, "count": count, "error": error, "doc": doc_id, "result": to_json(result)? }));
                }
                json!(out)
            }
            "read_clipboard" => json!(*self.clipboard.lock().unwrap()),
            // Only for the scenarios: what `copy` and `copy_box` put on the clipboard.
            "test_clipboard" => json!(*self.clipboard.lock().unwrap()),
            // Only for the scenarios: how many documents the app still holds.
            "test_open_documents" => json!(self.docs.lock().unwrap().len()),
            // Only for the scenarios: what the file manager and terminals were asked to show.
            "test_launched" => json!(*self.launched.lock().unwrap()),
            _ => return Err(format!("unknown command {cmd}")),
        })
    }
}
