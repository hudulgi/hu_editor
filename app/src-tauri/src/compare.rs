//! Commands of the compare window. A comparison is of two open documents;
//! before each answer it takes their current text, so edits made anywhere
//! (another window, a hunk copied across) are compared again where they are.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hu_core::compare::{CompareView, Comparison, HunkRows, Side};
use hu_core::{EditKind, EditResult, ipc_message};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::commands::{Docs, OpenDoc, WindowStarts, blocking, throttled};

#[derive(Default)]
pub struct Comparisons {
    open: Mutex<HashMap<u32, Arc<Open>>>,
    next_id: AtomicU32,
}

struct Open {
    docs: [u32; 2],
    cancel: AtomicBool,
    /// Once compared.
    comparison: Mutex<Option<Comparison>>,
}

impl Comparisons {
    fn get(&self, id: u32) -> Result<Arc<Open>, String> {
        self.open
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("comparison {id} is not open"))
    }
}

/// A comparison made, and the work comparing it takes, in the units its
/// progress is reported in.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewComparison {
    id: u32,
    work: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compared {
    rows: u64,
    hunks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    /// The document copied to.
    doc: u32,
    result: EditResult,
}

type Both = [Arc<OpenDoc>; 2];

/// The comparison `id` and its documents.
fn get(id: u32, docs: &Docs, comparisons: &Comparisons) -> Result<(Arc<Open>, Both), String> {
    let open = comparisons.get(id)?;
    let both = [docs.get(open.docs[0])?, docs.get(open.docs[1])?];
    Ok((open, both))
}

/// Runs `f` on the comparison with both documents as they are now.
fn with<T>(
    (open, docs): &(Arc<Open>, Both),
    f: impl FnOnce(&mut Comparison, &Both) -> Result<T, String>,
) -> Result<T, String> {
    let mut slot = open.comparison.lock().unwrap();
    let comparison = slot.as_mut().ok_or("not compared yet")?;
    for (side, one) in [Side::Left, Side::Right].into_iter().zip(docs) {
        comparison
            .sync(side, one.doc.text())
            .map_err(|e| ipc_message(&e))?;
    }
    f(comparison, docs)
}

#[tauri::command]
pub fn compare_new(
    left: u32,
    right: u32,
    docs: State<'_, Docs>,
    comparisons: State<'_, Comparisons>,
) -> Result<NewComparison, String> {
    // Read twice: once by the line index, once to compare.
    let work = 2 * (docs.get(left)?.doc.len() + docs.get(right)?.doc.len());
    let id = comparisons.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let open = Open {
        docs: [left, right],
        cancel: AtomicBool::new(false),
        comparison: Mutex::new(None),
    };
    comparisons.open.lock().unwrap().insert(id, Arc::new(open));
    Ok(NewComparison { id, work })
}

/// Compares, once both line indexes are done, streaming the work done to
/// `on_progress`, then `u64::MAX` once both are read and only the hunks are
/// left to find. `None` when closed first.
#[tauri::command]
pub async fn compare_run(
    id: u32,
    on_progress: Channel<u64>,
    docs: State<'_, Docs>,
    comparisons: State<'_, Comparisons>,
) -> Result<Option<Compared>, String> {
    let (open, [left, right]) = get(id, &docs, &comparisons)?;
    blocking(move || {
        let all_read = on_progress.clone();
        let mut progress = throttled(on_progress);
        loop {
            if open.cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            let (a, b) = (left.doc.index_status(), right.doc.index_status());
            if let Some(error) = a.error.or(b.error) {
                return Err(error);
            }
            if a.complete && b.complete {
                break;
            }
            progress(a.scanned + b.scanned);
            std::thread::sleep(Duration::from_millis(20));
        }
        let read = left.doc.len() + right.doc.len();
        let made = Comparison::new(left.doc.text(), right.doc.text(), &open.cancel, &mut |n| {
            if n == read {
                let _ = all_read.send(u64::MAX);
            } else {
                progress(read + n)
            }
        })
        .map_err(|e| ipc_message(&e))?;
        let Some(comparison) = made else {
            return Ok(None);
        };
        let compared = Compared {
            rows: comparison.rows(),
            hunks: comparison.hunk_count(),
        };
        *open.comparison.lock().unwrap() = Some(comparison);
        Ok(Some(compared))
    })
    .await
}

#[tauri::command]
pub async fn compare_view(
    id: u32,
    top: u64,
    rows: usize,
    docs: State<'_, Docs>,
    comparisons: State<'_, Comparisons>,
) -> Result<CompareView, String> {
    let both = get(id, &docs, &comparisons)?;
    blocking(move || with(&both, |c, _| c.view(top, rows).map_err(|e| ipc_message(&e)))).await
}

#[tauri::command]
pub async fn compare_overview(
    id: u32,
    buckets: usize,
    docs: State<'_, Docs>,
    comparisons: State<'_, Comparisons>,
) -> Result<Vec<u8>, String> {
    let both = get(id, &docs, &comparisons)?;
    blocking(move || with(&both, |c, _| Ok(c.overview(buckets.min(1 << 16))))).await
}

/// Hunk `index`, or with `from` the first one starting after that row
/// (`forward`) or the last one before it.
#[tauri::command]
pub async fn compare_hunk(
    id: u32,
    index: Option<usize>,
    from: Option<u64>,
    forward: bool,
    docs: State<'_, Docs>,
    comparisons: State<'_, Comparisons>,
) -> Result<Option<HunkRows>, String> {
    let both = get(id, &docs, &comparisons)?;
    blocking(move || {
        with(&both, |c, _| {
            Ok(match (index, from) {
                (Some(index), _) => c.hunk_rows(index),
                (None, Some(row)) => c.hunk_from(row, forward),
                (None, None) => None,
            })
        })
    })
    .await
}

/// Makes the lines of hunk `index` on side `to` what they are on the other.
#[tauri::command]
pub async fn compare_merge(
    id: u32,
    index: usize,
    to: Side,
    docs: State<'_, Docs>,
    comparisons: State<'_, Comparisons>,
) -> Result<Merged, String> {
    let both = get(id, &docs, &comparisons)?;
    let side = if to == Side::Left { 0 } else { 1 };
    let doc = both.0.docs[side];
    blocking(move || {
        let result = with(&both, |c, docs| {
            let target = &docs[side].doc;
            let merge = c.merge(index, to).map_err(|e| ipc_message(&e))?;
            let before = (merge.start, merge.start);
            let result = target.edit(merge.start, merge.end, &merge.text, EditKind::Other, before);
            c.sync(to, target.text()).map_err(|e| ipc_message(&e))?;
            Ok(result)
        })?;
        Ok(Merged { doc, result })
    })
    .await
}

#[tauri::command]
pub fn compare_close(id: u32, comparisons: State<'_, Comparisons>) {
    if let Some(open) = comparisons.open.lock().unwrap().remove(&id) {
        open.cancel.store(true, Ordering::Relaxed);
    }
}

/// Opens a compare window, which gets `start` from `window_start`.
#[tauri::command]
pub async fn open_compare_window(
    start: Value,
    app: AppHandle,
    starts: State<'_, WindowStarts>,
) -> Result<(), String> {
    starts.open(&app, "compare", start, (1400.0, 860.0))
}
