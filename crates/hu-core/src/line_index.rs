//! Sparse line index built in the background.
//!
//! Instead of one offset per line (8 bytes × hundreds of millions of lines),
//! only every `CHECKPOINT_INTERVAL`-th line start is stored; a line in
//! between is found by scanning at most that many lines from the nearest
//! checkpoint. A 30 GB deck with 500 M lines needs about 4 MB of index.
//!
//! The index grows while the file is scanned, so line numbers become
//! available progressively from the top of the file.

use std::io;
use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::source::FileSource;

pub const CHECKPOINT_INTERVAL: u64 = 1024;
const SCAN_CHUNK: usize = 8 << 20;

#[derive(Debug)]
pub struct LineIndex {
    /// `checkpoints[k]` is the offset where line `k * CHECKPOINT_INTERVAL` starts.
    checkpoints: Vec<u64>,
    /// Bytes `[0, scanned)` have been scanned.
    scanned: u64,
    /// Line feeds found in `[0, scanned)`.
    newlines: u64,
    complete: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub scanned: u64,
    pub len: u64,
    /// Lines whose start is known so far; the final line count once `complete`.
    pub lines: u64,
    pub complete: bool,
    pub error: Option<String>,
}

impl Default for LineIndex {
    fn default() -> Self {
        Self {
            checkpoints: vec![0],
            scanned: 0,
            newlines: 0,
            complete: false,
            error: None,
        }
    }
}

impl LineIndex {
    /// Nearest checkpoint at or before 0-based line `line`, as
    /// `(checkpoint offset, lines left to skip)`. `None` until the scan
    /// reaches that line.
    pub fn checkpoint_for_line(&self, line: u64) -> Option<(u64, u64)> {
        // Line `n` starts right after the `n`-th line feed.
        if line > self.newlines {
            return None;
        }
        let k = line / CHECKPOINT_INTERVAL;
        Some((self.checkpoints[k as usize], line % CHECKPOINT_INTERVAL))
    }

    /// Nearest checkpoint at or before byte `offset`, as `(its line, its
    /// offset)`. `None` until the scan reaches that offset.
    pub fn checkpoint_for_offset(&self, offset: u64) -> Option<(u64, u64)> {
        if offset > self.scanned {
            return None;
        }
        let k = self.checkpoints.partition_point(|&c| c <= offset) - 1;
        Some((k as u64 * CHECKPOINT_INTERVAL, self.checkpoints[k]))
    }

    pub fn status(&self, len: u64) -> IndexStatus {
        IndexStatus {
            scanned: self.scanned,
            len,
            lines: if self.complete {
                self.newlines + 1
            } else {
                self.newlines
            },
            complete: self.complete,
            error: self.error.clone(),
        }
    }
}

/// Scans the whole file, publishing checkpoints after every chunk. Runs on
/// its own thread; stops early when `cancel` is set.
pub fn build(source: &FileSource, index: &RwLock<LineIndex>, cancel: &AtomicBool) {
    if let Err(e) = scan(source, index, cancel) {
        index.write().unwrap().error = Some(e.to_string());
    }
}

fn scan(source: &FileSource, index: &RwLock<LineIndex>, cancel: &AtomicBool) -> io::Result<()> {
    let len = source.len();
    let mut buf = vec![0; SCAN_CHUNK.min(len as usize)];
    let mut offset = 0;
    let mut newlines = 0;
    let mut found = Vec::new();
    while offset < len {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let chunk = &mut buf[..(len - offset).min(SCAN_CHUNK as u64) as usize];
        source.read_uncached(offset, chunk)?;
        for pos in memchr::memchr_iter(b'\n', chunk) {
            newlines += 1;
            if newlines % CHECKPOINT_INTERVAL == 0 {
                found.push(offset + pos as u64 + 1);
            }
        }
        offset += chunk.len() as u64;

        let mut index = index.write().unwrap();
        index.checkpoints.append(&mut found);
        index.scanned = offset;
        index.newlines = newlines;
    }
    index.write().unwrap().complete = true;
    Ok(())
}
