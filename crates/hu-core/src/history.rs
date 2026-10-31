//! Undo and redo. A change records where it happened, how long its text is,
//! and the pieces it replaced; applying it swaps the two and yields the
//! inverse change. Pieces are references, so undoing the deletion of a
//! gigabyte stores a few pieces, not a gigabyte.

use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::pieces::Piece;

/// Keystrokes closer together than this undo as one step.
const GROUP_WINDOW: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditKind {
    /// Typed text; consecutive typing undoes as one step.
    Typing,
    /// Backspace without a selection.
    Backspace,
    /// Delete without a selection.
    Delete,
    Other,
}

#[derive(Debug, Clone)]
pub struct Change {
    /// Identifies the document state this change leads to.
    pub id: u64,
    pub offset: u64,
    /// Length of the text this change put in place.
    pub len: u64,
    /// The pieces it replaced.
    pub replaced: Vec<Piece>,
    /// Selection (anchor, caret) before the change.
    pub before: (u64, u64),
    kind: EditKind,
    at: Instant,
    /// Never extended by later keystrokes (it was redone).
    sealed: bool,
}

#[derive(Debug, Default)]
pub struct History {
    pub undo: Vec<Change>,
    pub redo: Vec<Change>,
    next_id: u64,
    /// State id at the last save; 0 is the file as opened.
    saved: u64,
}

impl History {
    /// Id of the current document state.
    pub fn current(&self) -> u64 {
        self.undo.last().map_or(0, |c| c.id)
    }

    pub fn is_dirty(&self) -> bool {
        self.current() != self.saved
    }

    pub fn mark_saved(&mut self, id: u64) {
        self.saved = id;
    }

    /// Records an edit that replaced `old_len` bytes at `offset` (the pieces
    /// `replaced`) with `new_len` bytes.
    pub fn record(
        &mut self,
        offset: u64,
        new_len: u64,
        replaced: Vec<Piece>,
        kind: EditKind,
        before: (u64, u64),
    ) {
        self.redo.clear();
        let now = Instant::now();
        let old_len: u64 = replaced.iter().map(|p| p.len).sum();
        if let Some(top) = self.undo.last_mut()
            && !top.sealed
            && top.id != self.saved
            && top.kind == kind
            && now.duration_since(top.at) < GROUP_WINDOW
        {
            let grouped = match kind {
                EditKind::Typing if old_len == 0 && offset == top.offset + top.len => {
                    top.len += new_len;
                    true
                }
                EditKind::Backspace
                    if new_len == 0 && top.len == 0 && offset + old_len == top.offset =>
                {
                    top.replaced.splice(0..0, replaced.iter().copied());
                    top.offset = offset;
                    true
                }
                EditKind::Delete if new_len == 0 && top.len == 0 && offset == top.offset => {
                    top.replaced.extend(replaced.iter().copied());
                    true
                }
                _ => false,
            };
            if grouped {
                top.at = now;
                return;
            }
        }
        self.next_id += 1;
        self.undo.push(Change {
            id: self.next_id,
            offset,
            len: new_len,
            replaced,
            before,
            kind,
            at: now,
            sealed: false,
        });
    }

    /// The change `undone` was undone; `restored_len` bytes are back and
    /// `removed` are the pieces of its text, kept for redo.
    pub fn push_redo(&mut self, undone: &Change, restored_len: u64, removed: Vec<Piece>) {
        self.redo.push(Change {
            len: restored_len,
            replaced: removed,
            ..undone.clone()
        });
    }

    /// The change `redone` was redone; its `new_len` bytes are back and
    /// `removed` are the pieces it replaced again.
    pub fn push_undo(&mut self, redone: &Change, new_len: u64, removed: Vec<Piece>) {
        self.undo.push(Change {
            len: new_len,
            replaced: removed,
            sealed: true,
            ..redone.clone()
        });
    }
}
