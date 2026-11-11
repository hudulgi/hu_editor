//! Anchors for a large gap: the lines that occur exactly once on each side,
//! as many of them as are in the same order on both. Found by sorting rather
//! than with a hash map, which for tens of millions of lines takes twice the
//! memory.

/// Pairs of indices of a line unique in `a` and in `b`: the longest run of
/// them in the same order on both sides, in that order.
pub(crate) fn anchors(a: &[u64], b: &[u64]) -> Vec<(u32, u32)> {
    let once_a = once(a);
    let once_b = once(b);
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < once_a.len() && j < once_b.len() {
        match once_a[i].0.cmp(&once_b[j].0) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                pairs.push((once_a[i].1, once_b[j].1));
                i += 1;
                j += 1;
            }
        }
    }
    drop((once_a, once_b));
    pairs.sort_unstable_by_key(|&(_, j)| j);
    longest_increasing(&pairs)
}

/// The lines that occur once, as their hash and index, in hash order.
fn once(lines: &[u64]) -> Vec<(u64, u32)> {
    let mut all: Vec<(u64, u32)> = lines
        .iter()
        .enumerate()
        .map(|(i, &h)| (h, i as u32))
        .collect();
    all.sort_unstable_by_key(|&(h, _)| h);
    let mut kept = 0;
    let mut i = 0;
    while i < all.len() {
        let mut j = i + 1;
        while j < all.len() && all[j].0 == all[i].0 {
            j += 1;
        }
        if j == i + 1 {
            all[kept] = all[i];
            kept += 1;
        }
        i = j;
    }
    all.truncate(kept);
    all.shrink_to_fit();
    all
}

/// The longest subsequence of `pairs` (in increasing second index) whose
/// first index increases too, by patience sorting.
fn longest_increasing(pairs: &[(u32, u32)]) -> Vec<(u32, u32)> {
    // For each length, the pair ending the run of that length with the
    // smallest first index; and for each pair, the one before it in its run.
    let mut tails: Vec<u32> = Vec::new();
    let mut before = vec![u32::MAX; pairs.len()];
    for (p, &(i, _)) in pairs.iter().enumerate() {
        let first = |t: &u32| pairs[*t as usize].0;
        // Mostly in order already: then it extends the longest run.
        let len = if tails.last().is_none_or(|t| first(t) < i) {
            tails.len()
        } else {
            tails.partition_point(|t| first(t) < i)
        };
        if len > 0 {
            before[p] = tails[len - 1];
        }
        if len == tails.len() {
            tails.push(p as u32);
        } else {
            tails[len] = p as u32;
        }
    }
    let mut run = Vec::with_capacity(tails.len());
    let mut at = tails.last().copied();
    while let Some(p) = at {
        run.push(pairs[p as usize]);
        at = Some(before[p as usize]).filter(|&b| b != u32::MAX);
    }
    run.reverse();
    run
}
