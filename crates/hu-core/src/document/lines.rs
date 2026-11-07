//! The Selection menu's line work, as VS Code has it: moving and copying
//! lines, duplicating the selection, and the block a selection grows to.
//! Copies point at the text they copy, so even a gigabyte costs only its
//! pieces.

use std::io;

use serde::Deserialize;

use super::{Change, Document, EditResult, Eol, State};
use crate::history::EditKind;
use crate::pieces::{Piece, total_len};
use crate::text::Text;

/// What a selection grows to after its lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    /// An Abaqus keyword with its data lines, up to the next keyword.
    Abaqus,
    /// A Nastran card with its continuation lines.
    Nastran,
    /// Lines up to a blank one.
    Paragraph,
}

/// Read at a time to look for a block's ends.
const CHUNK: u64 = 1 << 20;

impl Document {
    /// Move Line Up or Down: the lines the selection touches change places
    /// with the line above or below, and the selection goes with them.
    /// `None` at the top or the bottom.
    pub fn move_lines(&self, up: bool, before: (u64, u64)) -> io::Result<Option<EditResult>> {
        let mut state = self.state.write().unwrap();
        let text = self.text_of(&state);
        let (a, b) = line_span(&text, before)?;
        let len = text.len();
        let range = |x: u64, y: u64| self.range(&state, x, y);
        let (start, end, pieces, moved_to, moved_len) = if up {
            if a == 0 {
                return Ok(None);
            }
            let p = text.line_start(a - 1)?;
            let bt = if b > a { break_len(&text, b)? } else { 0 };
            if bt > 0 {
                (p, b, [range(a, b), range(p, a)].concat(), p, b - a)
            } else {
                // The last line, without a break: the break above goes after it.
                let pt = break_len(&text, a)?;
                let pieces = [range(a, b), range(a - pt, a), range(p, a - pt)].concat();
                (p, b, pieces, p, b - a + pt)
            }
        } else {
            if b == len {
                return Ok(None);
            }
            let next = text.line_bounds(b)?.1.unwrap_or(len);
            let nt = break_len(&text, next)?;
            if nt > 0 {
                (
                    a,
                    next,
                    [range(b, next), range(a, b)].concat(),
                    a + (next - b),
                    b - a,
                )
            } else {
                // Below goes the last line, without a break: this one's break goes before.
                let bt = break_len(&text, b)?;
                let pieces = [range(b, next), range(b - bt, b), range(a, b - bt)].concat();
                (a, next, pieces, a + (next - b) + bt, b - a - bt)
            }
        };
        let follow = |at: u64| moved_to + (at - a).min(moved_len);
        let after = (follow(before.0.max(a)), follow(before.1.max(a)));
        Ok(Some(
            self.put(&mut state, start, end, &pieces, before, after),
        ))
    }

    /// Copy Line Up or Down: the lines the selection touches once more,
    /// above or below; the selection goes on the copy below.
    pub fn copy_lines(&self, up: bool, before: (u64, u64)) -> io::Result<Option<EditResult>> {
        let mut state = self.state.write().unwrap();
        let text = self.text_of(&state);
        let (a, b) = line_span(&text, before)?;
        let bt = if b > a { break_len(&text, b)? } else { 0 };
        let mut pieces = self.range(&state, a, b);
        if bt == 0 {
            // The last line, without a break: the copy brings one.
            let eol = self.added_piece(match self.eol {
                Eol::Lf => b"\n",
                Eol::Crlf => b"\r\n",
            });
            if up {
                pieces.extend(eol);
            } else {
                pieces.splice(0..0, eol);
            }
        }
        let (at, shift) = if up { (a, 0) } else { (b, total_len(&pieces)) };
        let after = (before.0 + shift, before.1 + shift);
        Ok(Some(self.put(&mut state, at, at, &pieces, before, after)))
    }

    /// Duplicate Selection: the selection once more after it, selected; or,
    /// without one, Copy Line Down.
    pub fn duplicate_selection(&self, before: (u64, u64)) -> io::Result<Option<EditResult>> {
        let (start, end) = (before.0.min(before.1), before.0.max(before.1));
        if start == end {
            return self.copy_lines(false, before);
        }
        let mut state = self.state.write().unwrap();
        let pieces = self.range(&state, start, end);
        let after = if before.0 <= before.1 {
            (end, end + (end - start))
        } else {
            (end + (end - start), end)
        };
        Ok(Some(self.put(&mut state, end, end, &pieces, before, after)))
    }

    /// The block the selection's lines are in, for Expand Selection.
    pub fn block_around(&self, kind: BlockKind, selection: (u64, u64)) -> io::Result<(u64, u64)> {
        let text = self.text();
        let (a, b) = line_span(&text, selection)?;
        let keyword = |line: &[u8]| line.first() == Some(&b'*') && line.get(1) != Some(&b'*');
        let continued =
            |line: &[u8]| matches!(line.first(), Some(b'+' | b'*' | b' ' | b'\t' | b','));
        let blank = |line: &[u8]| matches!(line, [] | [b'\n', ..] | [b'\r', b'\n', ..]);
        Ok(match kind {
            BlockKind::Abaqus => (
                last_line_back(&text, a, keyword)?.unwrap_or(0),
                first_line_from(&text, b, keyword)?,
            ),
            BlockKind::Nastran => (
                last_line_back(&text, a, |l| !continued(l))?.unwrap_or(0),
                first_line_from(&text, b, |l| !continued(l))?,
            ),
            BlockKind::Paragraph => {
                // After the last blank line above.
                let above = match a.checked_sub(1) {
                    Some(before) => last_line_back(&text, text.line_start(before)?, blank)?,
                    None => None,
                };
                let start = match above {
                    Some(blank_at) => text.line_bounds(blank_at)?.1.unwrap_or(a),
                    None => 0,
                };
                (start, first_line_from(&text, b, blank)?)
            }
        })
    }

    /// The text as `state` has it.
    fn text_of(&self, state: &State) -> Text {
        Text {
            pieces: state.pieces.clone(),
            original: self.original.clone(),
            added: self.added.clone(),
            decoding: self.reading.read().unwrap().decoding(),
        }
    }

    fn range(&self, state: &State, start: u64, end: u64) -> Vec<Piece> {
        state
            .pieces
            .range(start, end, &|p: &Piece| self.newlines(p))
    }

    /// Replaces `[start, end)` with `pieces` as one undo step, leaving the selection `after`.
    fn put(
        &self,
        state: &mut State,
        start: u64,
        end: u64,
        pieces: &[Piece],
        before: (u64, u64),
        (anchor, caret): (u64, u64),
    ) -> EditResult {
        let count = |p: &Piece| self.newlines(p);
        let replaced = state.pieces.range(start, end, &count);
        let new_len = total_len(pieces);
        state.pieces.splice(start, end, pieces, &count);
        state
            .history
            .record(start, new_len, replaced, EditKind::Other, before);
        state.version += 1;
        EditResult {
            change: Change {
                start,
                old_len: end - start,
                new_len,
            },
            anchor,
            caret,
            state: state.doc_state(),
        }
    }
}

/// The lines a selection touches, as VS Code takes them: from the line of
/// its start to the line of its end, but not one it ends at the start of.
/// Where they start, and end after the last one's line break, if it has one.
pub(crate) fn line_span(text: &Text, (anchor, caret): (u64, u64)) -> io::Result<(u64, u64)> {
    let (start, end) = (anchor.min(caret), anchor.max(caret));
    let first = text.line_start(start)?;
    let last = if end > start && end > first && text.line_start(end)? == end {
        end - 1
    } else {
        end
    };
    let last_start = text.line_start(last)?;
    Ok((first, text.line_bounds(last_start)?.1.unwrap_or(text.len())))
}

/// How long the line break just before `end` is: 2 for CRLF, 1, or 0 for none.
fn break_len(text: &Text, end: u64) -> io::Result<u64> {
    let tail = text.read_range(end.saturating_sub(2), end)?;
    Ok(match tail.as_slice() {
        [b'\r', b'\n'] => 2,
        [.., b'\n'] => 1,
        _ => 0,
    })
}

/// The start of the first line at or after `from`, a line start, whose first
/// bytes `is` says yes to; the end of the text if none.
fn first_line_from(text: &Text, from: u64, is: impl Fn(&[u8]) -> bool) -> io::Result<u64> {
    let len = text.len();
    if from >= len || is(&head(text, from)?) {
        return Ok(from.min(len));
    }
    let mut pos = from;
    while pos < len {
        let end = (pos + CHUNK).min(len);
        let chunk = text.read_range(pos, end)?;
        for i in memchr::memchr_iter(b'\n', &chunk) {
            let start = pos + i as u64 + 1;
            if start < len && is(&head_in(text, &chunk, pos, start)?) {
                return Ok(start);
            }
        }
        pos = end;
    }
    Ok(len)
}

/// The start of the last line at or before the line starting at `from`
/// whose first bytes `is` says yes to.
fn last_line_back(text: &Text, from: u64, is: impl Fn(&[u8]) -> bool) -> io::Result<Option<u64>> {
    if is(&head(text, from)?) {
        return Ok(Some(from));
    }
    // Line starts before `from`, a chunk at a time, the nearest first.
    let mut end = from;
    while end > 0 {
        let floor = end.saturating_sub(CHUNK);
        let chunk = text.read_range(floor, end)?;
        for i in memchr::memrchr_iter(b'\n', &chunk) {
            let start = floor + i as u64 + 1;
            if start < from && is(&head_in(text, &chunk, floor, start)?) {
                return Ok(Some(start));
            }
        }
        if floor == 0 {
            return Ok((from > 0 && is(&head(text, 0)?)).then_some(0));
        }
        end = floor;
    }
    Ok(None)
}

/// The first two bytes of the line starting at `start`.
fn head(text: &Text, start: u64) -> io::Result<Vec<u8>> {
    text.read_range(start, (start + 2).min(text.len()))
}

/// The same, from `chunk`, read from `at`, when it holds them.
fn head_in(text: &Text, chunk: &[u8], at: u64, start: u64) -> io::Result<Vec<u8>> {
    let i = (start - at) as usize;
    match chunk.get(i..i + 2) {
        Some(two) => Ok(two.to_vec()),
        None => head(text, start),
    }
}
