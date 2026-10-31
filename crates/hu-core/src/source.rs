//! Disk-backed access to the original file.
//!
//! Small reads (the viewport, line navigation) go through an LRU cache of
//! fixed-size blocks. Long sequential scans (line indexing, search) read
//! straight from disk so they do not evict the blocks the viewport is using.
//!
//! Positioned reads are used instead of a memory map on purpose: on Windows a
//! mapped file cannot be truncated or replaced, so a pre-processor could not
//! re-export a deck that is open here, and an I/O error on a mapped page
//! (e.g. a dropped network drive) kills the process instead of returning an
//! error.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// Size of a cached block.
pub const BLOCK_SIZE: usize = 256 * 1024;
/// Number of cached blocks (64 MiB in total).
const CACHE_BLOCKS: usize = 256;

pub struct FileSource {
    path: PathBuf,
    /// `None` for the empty source of a new document.
    file: Option<File>,
    len: u64,
    modified: Option<SystemTime>,
    cache: Mutex<BlockCache>,
}

impl FileSource {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = open_shared(path)?;
        let meta = file.metadata()?;
        Ok(Self {
            path: path.to_path_buf(),
            file: Some(file),
            len: meta.len(),
            modified: meta.modified().ok(),
            cache: Mutex::new(BlockCache::new(CACHE_BLOCKS)),
        })
    }

    /// No file: what a new document starts from.
    pub fn empty() -> Self {
        Self {
            path: PathBuf::new(),
            file: None,
            len: 0,
            modified: None,
            cache: Mutex::new(BlockCache::new(1)),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// File size when it was opened.
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Block `index`: `BLOCK_SIZE` bytes, shorter for the last block, empty past the end.
    pub fn block(&self, index: u64) -> io::Result<Arc<[u8]>> {
        if let Some(block) = self.cache.lock().unwrap().get(index) {
            return Ok(block);
        }
        let start = index * BLOCK_SIZE as u64;
        let len = self.len.saturating_sub(start).min(BLOCK_SIZE as u64) as usize;
        let mut buf = vec![0; len];
        self.read_at(&mut buf, start)?;
        let block: Arc<[u8]> = buf.into();
        self.cache.lock().unwrap().insert(index, block.clone());
        Ok(block)
    }

    /// Copies `[start, end)` through the block cache.
    pub fn read_range(&self, start: u64, end: u64) -> io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        let mut pos = start;
        while pos < end {
            let block = self.block(pos / BLOCK_SIZE as u64)?;
            let in_block = (pos % BLOCK_SIZE as u64) as usize;
            if in_block >= block.len() {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let take = ((end - pos) as usize).min(block.len() - in_block);
            out.extend_from_slice(&block[in_block..in_block + take]);
            pos += take as u64;
        }
        Ok(out)
    }

    /// Fills `buf` from `offset`, bypassing the block cache.
    pub fn read_uncached(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        self.read_at(buf, offset)
    }

    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        match &self.file {
            Some(file) => read_exact_at(file, buf, offset),
            None if buf.is_empty() => Ok(()),
            None => Err(io::ErrorKind::UnexpectedEof.into()),
        }
    }

    /// Modification time when it was opened.
    pub fn modified(&self) -> Option<SystemTime> {
        self.modified
    }

    /// Feeds consecutive cached slices covering `[from, to)` to `f`, with the
    /// offset of each, until it returns `Some`.
    pub fn scan<T>(
        &self,
        from: u64,
        to: u64,
        mut f: impl FnMut(u64, &[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let mut pos = from;
        while pos < to {
            let index = pos / BLOCK_SIZE as u64;
            let block = self.block(index)?;
            let base = index * BLOCK_SIZE as u64;
            let lo = (pos - base) as usize;
            let hi = ((to - base) as usize).min(block.len());
            if lo >= hi {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if let Some(found) = f(pos, &block[lo..hi]) {
                return Ok(Some(found));
            }
            pos = base + hi as u64;
        }
        Ok(None)
    }

    /// Like [`scan`](Self::scan), from the end of the range backward.
    pub fn scan_rev<T>(
        &self,
        from: u64,
        to: u64,
        mut f: impl FnMut(u64, &[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let mut end = to;
        while end > from {
            let index = (end - 1) / BLOCK_SIZE as u64;
            let block = self.block(index)?;
            let base = index * BLOCK_SIZE as u64;
            let lo = from.saturating_sub(base) as usize;
            let hi = (end - base) as usize;
            if hi > block.len() {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if let Some(found) = f(base + lo as u64, &block[lo..hi]) {
                return Ok(Some(found));
            }
            end = base.max(from);
        }
        Ok(None)
    }

    /// Occurrences of `byte` in `[from, to)`.
    pub fn count(&self, byte: u8, from: u64, to: u64) -> io::Result<u64> {
        let mut count = 0;
        self.scan(from, to, |_, bytes| {
            count += memchr::memchr_iter(byte, bytes).count() as u64;
            None::<()>
        })?;
        Ok(count)
    }

    /// Offset just past the `n`-th `byte` at or after `from` (`n >= 1`).
    pub fn after_nth(&self, byte: u8, from: u64, n: u64) -> io::Result<Option<u64>> {
        let mut left = n;
        self.scan(from, self.len, |pos, bytes| {
            for i in memchr::memchr_iter(byte, bytes) {
                left -= 1;
                if left == 0 {
                    return Some(pos + i as u64 + 1);
                }
            }
            None
        })
    }
}

/// Opens for reading without locking the file against other programs.
fn open_shared(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        options.share_mode(0x1 | 0x2 | 0x4);
    }
    options.open(path)
}

#[cfg(unix)]
fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buf, offset)
}

#[cfg(windows)]
fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_read(buf, offset) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                buf = &mut buf[n..];
                offset += n as u64;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Least-recently-used block cache. Small enough that a linear scan for the
/// eviction victim costs nothing next to the disk read that triggers it.
struct BlockCache {
    blocks: HashMap<u64, (Arc<[u8]>, u64)>,
    tick: u64,
    capacity: usize,
}

impl BlockCache {
    fn new(capacity: usize) -> Self {
        Self {
            blocks: HashMap::with_capacity(capacity),
            tick: 0,
            capacity,
        }
    }

    fn get(&mut self, index: u64) -> Option<Arc<[u8]>> {
        self.tick += 1;
        let tick = self.tick;
        self.blocks.get_mut(&index).map(|(block, used)| {
            *used = tick;
            block.clone()
        })
    }

    fn insert(&mut self, index: u64, block: Arc<[u8]>) {
        if self.blocks.len() >= self.capacity && !self.blocks.contains_key(&index) {
            let oldest = self
                .blocks
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(&i, _)| i);
            if let Some(oldest) = oldest {
                self.blocks.remove(&oldest);
            }
        }
        self.tick += 1;
        self.blocks.insert(index, (block, self.tick));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_range_spans_blocks() {
        let content: Vec<u8> = (0..BLOCK_SIZE * 3 + 17).map(|i| (i % 251) as u8).collect();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&content).unwrap();
        let source = FileSource::open(file.path()).unwrap();

        let (a, b) = (BLOCK_SIZE as u64 - 5, BLOCK_SIZE as u64 * 3 + 10);
        assert_eq!(
            source.read_range(a, b).unwrap(),
            &content[a as usize..b as usize]
        );
        assert_eq!(source.read_range(0, content.len() as u64).unwrap(), content);
        assert!(source.read_range(0, content.len() as u64 + 1).is_err());
    }

    #[test]
    fn cache_evicts_least_recently_used() {
        let mut cache = BlockCache::new(2);
        let block = |b: u8| -> Arc<[u8]> { vec![b].into() };
        cache.insert(1, block(1));
        cache.insert(2, block(2));
        cache.get(1);
        cache.insert(3, block(3));
        assert!(cache.get(2).is_none());
        assert!(cache.get(1).is_some());
        assert!(cache.get(3).is_some());
    }
}
