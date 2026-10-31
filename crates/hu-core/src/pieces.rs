//! Piece table, UltraEdit style: the document is a list of pieces pointing
//! into the original file, which is never copied or modified, or into the
//! buffer of added text. An edit only rearranges pieces, so deleting a
//! gigabyte costs a few pieces, and undo keeps pieces instead of text.

use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Original,
    Added,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece {
    pub source: Source,
    /// Offset in its source.
    pub start: u64,
    pub len: u64,
    /// Line feeds in the piece; `None` for original text the background line
    /// index has not reached yet.
    pub newlines: Option<u64>,
}

impl Piece {
    pub fn end(&self) -> u64 {
        self.start + self.len
    }
}

pub fn total_len(pieces: &[Piece]) -> u64 {
    pieces.iter().map(|p| p.len).sum()
}

/// Text typed or pasted in this session. Only ever appended to, so a range
/// a piece points at never changes.
#[derive(Debug, Default)]
pub struct Added(RwLock<Vec<u8>>);

impl Added {
    /// Appends `bytes`, returning where they start.
    pub fn append(&self, bytes: &[u8]) -> u64 {
        let mut buf = self.0.write().unwrap();
        let start = buf.len() as u64;
        buf.extend_from_slice(bytes);
        start
    }

    pub fn read<R>(&self, start: u64, end: u64, f: impl FnOnce(&[u8]) -> R) -> R {
        f(&self.0.read().unwrap()[start as usize..end as usize])
    }

    pub fn newlines(&self, start: u64, end: u64) -> u64 {
        self.read(start, end, |bytes| {
            memchr::memchr_iter(b'\n', bytes).count() as u64
        })
    }
}

/// Counts the line feeds in a piece, `None` while unknown.
pub type Counter<'a> = &'a dyn Fn(&Piece) -> Option<u64>;

/// The ordered pieces of a document. Cloning is cheap (shared until the
/// next edit), so a snapshot can be read while editing goes on.
#[derive(Debug, Clone, Default)]
pub struct Pieces {
    pieces: Arc<Vec<Piece>>,
    /// Document offset where each piece starts.
    starts: Arc<Vec<u64>>,
    len: u64,
}

impl Pieces {
    pub fn new(initial: Piece) -> Self {
        let mut pieces = Self::default();
        if initial.len > 0 {
            pieces.pieces = Arc::new(vec![initial]);
            pieces.reindex(0);
        }
        pieces
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn pieces(&self) -> &[Piece] {
        &self.pieces
    }

    pub fn starts(&self) -> &[u64] {
        &self.starts
    }

    /// Index of the piece containing `offset`; the piece count at the end.
    pub fn index_of(&self, offset: u64) -> usize {
        if offset >= self.len {
            return self.pieces.len();
        }
        self.starts.partition_point(|&s| s <= offset) - 1
    }

    /// Replaces `[start, end)` with `new`, returning the pieces it replaced.
    pub fn splice(&mut self, start: u64, end: u64, new: &[Piece], count: Counter) -> Vec<Piece> {
        let a = self.split(start, count);
        let b = self.split(end, count);
        let new = new.iter().copied().filter(|p| p.len > 0);
        let removed = Arc::make_mut(&mut self.pieces).splice(a..b, new).collect();
        self.reindex(a);
        removed
    }

    /// Inserts added text at `at`. Typing appends to the added buffer right
    /// after the previous keystroke, so that piece just grows.
    pub fn insert_added(&mut self, at: u64, piece: Piece, count: Counter) {
        let i = self.split(at, count);
        let pieces = Arc::make_mut(&mut self.pieces);
        match i.checked_sub(1).map(|j| &mut pieces[j]) {
            Some(prev) if prev.source == Source::Added && prev.end() == piece.start => {
                prev.len += piece.len;
                prev.newlines = prev.newlines.zip(piece.newlines).map(|(a, b)| a + b);
                self.reindex(i - 1);
            }
            _ => {
                pieces.insert(i, piece);
                self.reindex(i);
            }
        }
    }

    pub fn has_unknown_newlines(&self) -> bool {
        self.pieces.iter().any(|p| p.newlines.is_none())
    }

    /// Fills in line counts that have become known.
    pub fn settle(&mut self, count: Counter) {
        let known: Vec<_> = self
            .pieces
            .iter()
            .map(|p| p.newlines.or_else(|| count(p)))
            .collect();
        if known
            .iter()
            .zip(self.pieces.iter())
            .any(|(k, p)| *k != p.newlines)
        {
            for (p, k) in Arc::make_mut(&mut self.pieces).iter_mut().zip(known) {
                p.newlines = k;
            }
        }
    }

    /// Makes `offset` a piece boundary; returns the index of the piece that
    /// starts there (the piece count at the end).
    fn split(&mut self, offset: u64, count: Counter) -> usize {
        let i = self.index_of(offset);
        if i == self.pieces.len() || self.starts[i] == offset {
            return i;
        }
        let piece = self.pieces[i];
        let at = offset - self.starts[i];
        let mut left = Piece {
            len: at,
            newlines: None,
            ..piece
        };
        let mut right = Piece {
            start: piece.start + at,
            len: piece.len - at,
            newlines: None,
            ..piece
        };
        left.newlines = count(&left);
        right.newlines = match (piece.newlines, left.newlines) {
            (Some(all), Some(l)) => Some(all - l),
            _ => count(&right),
        };
        let pieces = Arc::make_mut(&mut self.pieces);
        pieces[i] = left;
        pieces.insert(i + 1, right);
        self.reindex(i);
        i + 1
    }

    /// Recomputes piece starts from piece `from` on.
    fn reindex(&mut self, from: usize) {
        let starts = Arc::make_mut(&mut self.starts);
        starts.truncate(from);
        let mut pos = match from.checked_sub(1) {
            Some(j) => starts[j] + self.pieces[j].len,
            None => 0,
        };
        for piece in &self.pieces[from..] {
            starts.push(pos);
            pos += piece.len;
        }
        self.len = pos;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn added(start: u64, len: u64) -> Piece {
        Piece {
            source: Source::Added,
            start,
            len,
            newlines: Some(0),
        }
    }

    #[test]
    fn splice_splits_and_reindexes() {
        let none: Counter = &|_| Some(0);
        let mut pieces = Pieces::new(Piece {
            source: Source::Original,
            start: 0,
            len: 10,
            newlines: Some(0),
        });
        let removed = pieces.splice(3, 5, &[added(0, 4)], none);
        assert_eq!(
            removed,
            [Piece {
                source: Source::Original,
                start: 3,
                len: 2,
                newlines: Some(0)
            }]
        );
        assert_eq!(pieces.len(), 12);
        assert_eq!(pieces.starts(), [0, 3, 7]);
        assert_eq!(pieces.index_of(6), 1);
        assert_eq!(pieces.index_of(12), 3);

        // Typing right after added text grows that piece instead of adding one.
        pieces.insert_added(7, added(4, 1), none);
        assert_eq!(pieces.pieces().len(), 3);
        assert_eq!(pieces.pieces()[1].len, 5);
    }
}
