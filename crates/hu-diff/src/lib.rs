//! Diff of two files line by line, for files of millions of lines. The lines
//! come in as 64-bit hashes, which is all that is kept of them; the runs of
//! lines that differ come out.
//!
//! The common start and end are taken off first: two versions of a deck
//! mostly differ in a few places. What is left is anchored on the lines that
//! occur once on each side ([patience diff]), which in a deck are most of
//! them, as node and element lines carry their IDs. The gaps between anchors
//! are then small and get Myers' shortest edit script. A large gap without
//! such lines gets Myers up to a cost, and past that is one run that differs.
//!
//! [`inline`] compares a pair of lines word by word, to show what in a
//! changed line changed.
//!
//! [patience diff]: https://bramcohen.livejournal.com/73318.html

use std::sync::atomic::{AtomicBool, Ordering};

mod inline;
mod myers;
mod patience;

pub use inline::inline;

/// Lines `a_start..a_end` of the first file became `b_start..b_end` of the
/// second. One side is empty for lines only added or only removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Hunk {
    pub a_start: usize,
    pub a_end: usize,
    pub b_start: usize,
    pub b_end: usize,
}

impl Hunk {
    pub fn a_len(&self) -> usize {
        self.a_end - self.a_start
    }

    pub fn b_len(&self) -> usize {
        self.b_end - self.b_start
    }
}

/// A gap this long, both sides together, gets the shortest edit script
/// whatever it costs (at most this many edits).
const SMALL: usize = 2048;
/// A longer gap without lines unique on both sides gets Myers up to this
/// many edits, and past that is one hunk.
const MAX_COST: usize = 1024;

/// The hunks that turn `a` into `b`, in order; `None` once `cancel` is set.
/// Lines are equal when their hashes are. Each side holds fewer than
/// `u32::MAX` lines.
pub fn diff(a: &[u64], b: &[u64], cancel: &AtomicBool) -> Option<Vec<Hunk>> {
    assert!(a.len() < u32::MAX as usize && b.len() < u32::MAX as usize);
    let mut out = Vec::new();
    // Gaps still to compare, the next one last: hunks come out in order.
    let mut gaps = vec![(0, a.len(), 0, b.len())];
    while let Some((mut a0, mut a1, mut b0, mut b1)) = gaps.pop() {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        while a0 < a1 && b0 < b1 && a[a0] == b[b0] {
            a0 += 1;
            b0 += 1;
        }
        while a0 < a1 && b0 < b1 && a[a1 - 1] == b[b1 - 1] {
            a1 -= 1;
            b1 -= 1;
        }
        let whole = Hunk {
            a_start: a0,
            a_end: a1,
            b_start: b0,
            b_end: b1,
        };
        if a0 == a1 || b0 == b1 {
            if a0 != a1 || b0 != b1 {
                out.push(whole);
            }
            continue;
        }
        let (a_gap, b_gap) = (&a[a0..a1], &b[b0..b1]);
        if a_gap.len() + b_gap.len() <= SMALL {
            myers::hunks(a_gap, b_gap, SMALL, (a0, b0), &mut out);
            continue;
        }
        let anchors = patience::anchors(a_gap, b_gap);
        if anchors.is_empty() {
            if !myers::hunks(a_gap, b_gap, MAX_COST, (a0, b0), &mut out) {
                out.push(whole);
            }
            continue;
        }
        let (mut a_end, mut b_end) = (a1, b1);
        for &(i, j) in anchors.iter().rev() {
            let (i, j) = (a0 + i as usize, b0 + j as usize);
            if i + 1 < a_end || j + 1 < b_end {
                gaps.push((i + 1, a_end, j + 1, b_end));
            }
            (a_end, b_end) = (i, j);
        }
        gaps.push((a0, a_end, b0, b_end));
    }
    Some(out)
}

#[cfg(test)]
mod tests;
