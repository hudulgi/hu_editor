//! Serves the app's commands over HTTP, so the real frontend can run against
//! the real core in a browser (see `app/e2e`). Each command here mirrors one in
//! `app/src-tauri/src/commands.rs`; `run.mjs` stops if one is missing.
//!
//! Differences from the app: progress is not reported, a search cannot be
//! cancelled, the clipboard is a string here, and the settings file's path
//! comes with the request.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use hu_core::{
    BoxRows, Document, EditKind, Encoding, Eol, FindOptions, FindResult, ViewTarget, dir,
    ipc_message, settings,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[derive(Default)]
struct Bridge {
    docs: Mutex<HashMap<u32, Arc<Document>>>,
    next_id: AtomicU32,
    clipboard: Mutex<String>,
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
        info
    }

    fn dispatch(&self, cmd: &str, args: &Value) -> Result<Value, String> {
        let never = AtomicBool::new(false);
        let doc = || self.doc(args);
        Ok(match cmd {
            "launch_path" => Value::Null,
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
                self.docs.lock().unwrap().remove(&id);
                Value::Null
            }
            "index_status" => to_json(doc()?.index_status())?,
            "disk_changed" => json!(doc()?.changed_on_disk()),
            "detect_dialect" => to_json(doc()?.dialect().map_err(problem)?)?,
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
                let (needle, replacement): (String, String) =
                    (arg(args, "needle")?, arg(args, "replacement")?);
                let before = (arg(args, "anchor")?, arg(args, "caret")?);
                let case_sensitive = arg(args, "caseSensitive")?;
                let done = doc()?
                    .replace_all(
                        &needle,
                        &replacement,
                        case_sensitive,
                        before,
                        &never,
                        &mut |_| {},
                    )
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
                let doc = doc()?;
                let needle: String = arg(args, "needle")?;
                let needle = doc.encoding().encode(&needle).into_owned();
                let options = FindOptions {
                    case_sensitive: arg(args, "caseSensitive")?,
                    backward: arg(args, "backward")?,
                    wrap: true,
                };
                let found = doc
                    .text()
                    .find(&needle, arg(args, "from")?, &options, &never, &mut |_| {})
                    .map_err(problem)?;
                match found {
                    FindResult::Found(offset) => {
                        json!({ "kind": "found", "offset": offset, "len": needle.len() })
                    }
                    FindResult::NotFound => json!({ "kind": "notFound" }),
                    FindResult::Cancelled => json!({ "kind": "cancelled" }),
                }
            }
            "cancel_find" => Value::Null,
            "read_clipboard" => json!(*self.clipboard.lock().unwrap()),
            // Only for the scenarios: what `copy` and `copy_box` put on the clipboard.
            "test_clipboard" => json!(*self.clipboard.lock().unwrap()),
            _ => return Err(format!("unknown command {cmd}")),
        })
    }
}
