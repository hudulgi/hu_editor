//! Myers' greedy algorithm for the shortest edit script ("An O(ND)
//! Difference Algorithm and Its Variations", 1986), keeping each step's
//! furthest reaching points to walk the path back. Time and memory grow
//! with the square of the edits, so it is only run where they are few.

use crate::Hunk;

/// Appends the hunks of the shortest edit script of `a` into `b` to `out`,
/// offset by `at`. `false`, with nothing appended, when that takes more than
/// `max_cost` edits.
pub(crate) fn hunks<T: PartialEq>(
    a: &[T],
    b: &[T],
    max_cost: usize,
    at: (usize, usize),
    out: &mut Vec<Hunk>,
) -> bool {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max_d = (a.len() + b.len()).min(max_cost) as isize;
    let off = max_d + 1;
    // The x reached on each diagonal k = x - y, at `off + k`.
    let mut v = vec![0u32; (2 * max_d + 3) as usize];
    // `v` before each step d, for k in -d..=d, starting at d * d.
    let mut trace = Vec::new();
    let mut cost = None;
    'search: for d in 0..=max_d {
        trace.extend_from_slice(&v[(off - d) as usize..=(off + d) as usize]);
        for k in (-d..=d).step_by(2) {
            let down = k == -d || (k != d && v[(off + k - 1) as usize] < v[(off + k + 1) as usize]);
            let mut x = if down {
                v[(off + k + 1) as usize] as isize
            } else {
                v[(off + k - 1) as usize] as isize + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(off + k) as usize] = x as u32;
            if x >= n && y >= m {
                cost = Some(d);
                break 'search;
            }
        }
    }
    let Some(cost) = cost else {
        return false;
    };

    // Back from the end, one edit per step: where it was made, and whether
    // it inserts (down) or deletes (right).
    let mut edits = Vec::with_capacity(cost as usize);
    let (mut x, mut y) = (n, m);
    for d in (1..=cost).rev() {
        let before = |k: isize| trace[(d * d + k + d) as usize] as isize;
        let k = x - y;
        let down = k == -d || (k != d && before(k - 1) < before(k + 1));
        let from = if down { k + 1 } else { k - 1 };
        x = before(from);
        y = x - from;
        edits.push((x as usize, y as usize, down));
    }

    let mut hunk: Option<Hunk> = None;
    for &(x, y, down) in edits.iter().rev() {
        let (x, y) = (x + at.0, y + at.1);
        let (end_x, end_y) = if down { (x, y + 1) } else { (x + 1, y) };
        match &mut hunk {
            Some(h) if h.a_end == x && h.b_end == y => (h.a_end, h.b_end) = (end_x, end_y),
            _ => {
                out.extend(hunk);
                hunk = Some(Hunk {
                    a_start: x,
                    a_end: end_x,
                    b_start: y,
                    b_end: end_y,
                });
            }
        }
    }
    out.extend(hunk);
    true
}
