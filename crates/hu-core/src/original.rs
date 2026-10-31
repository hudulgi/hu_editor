//! Line arithmetic on the original file, answered from the background line
//! index as far as it has got.

use std::io;
use std::sync::{Arc, RwLock};

use crate::line_index::LineIndex;
use crate::source::FileSource;

#[derive(Clone)]
pub struct Original {
    pub source: Arc<FileSource>,
    pub index: Arc<RwLock<LineIndex>>,
}

impl Original {
    /// Line feeds in `[0, offset)`, once the index has reached `offset`.
    pub fn newlines_before(&self, offset: u64) -> io::Result<Option<u64>> {
        let Some((line, checkpoint)) = self.index.read().unwrap().checkpoint_for_offset(offset)
        else {
            return Ok(None);
        };
        Ok(Some(line + self.source.count(b'\n', checkpoint, offset)?))
    }

    /// Line feeds in `[start, end)`, once the index has reached `end`.
    pub fn newlines_in(&self, start: u64, end: u64) -> io::Result<Option<u64>> {
        Ok(
            match (self.newlines_before(start)?, self.newlines_before(end)?) {
                (Some(a), Some(b)) => Some(b - a),
                _ => None,
            },
        )
    }

    /// Offset just past the `n`-th line feed (`n >= 1`), once indexed.
    pub fn after_newline(&self, n: u64) -> io::Result<Option<u64>> {
        let Some((checkpoint, skip)) = self.index.read().unwrap().checkpoint_for_line(n) else {
            return Ok(None);
        };
        if skip == 0 {
            return Ok(Some(checkpoint));
        }
        self.source.after_nth(b'\n', checkpoint, skip)
    }

    /// Bytes the index has covered so far.
    pub fn scanned(&self) -> u64 {
        self.index.read().unwrap().status(0).scanned
    }
}
