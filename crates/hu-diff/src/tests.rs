use std::sync::atomic::AtomicBool;

use super::*;

/// xorshift, so the tests need no crates.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn run(a: &[u64], b: &[u64]) -> Vec<Hunk> {
    let hunks = diff(a, b, &AtomicBool::new(false)).unwrap();
    check_valid(a, b, &hunks);
    hunks
}

/// The hunks are in order, apart, not empty, and what is between them is equal.
fn check_valid(a: &[u64], b: &[u64], hunks: &[Hunk]) {
    let (mut i, mut j) = (0, 0);
    for h in hunks {
        assert!(h.a_len() + h.b_len() > 0, "empty hunk {h:?}");
        assert!(h.a_start >= i && h.b_start >= j, "out of order {h:?}");
        assert_eq!(h.a_start - i, h.b_start - j, "unequal run before {h:?}");
        assert_eq!(a[i..h.a_start], b[j..h.b_start], "differs before {h:?}");
        (i, j) = (h.a_end, h.b_end);
    }
    assert_eq!(a[i..], b[j..], "differs after the last hunk");
    for pair in hunks.windows(2) {
        assert!(
            pair[0].a_end < pair[1].a_start || pair[0].b_end < pair[1].b_start,
            "touching {pair:?}"
        );
    }
}

fn cost(hunks: &[Hunk]) -> usize {
    hunks.iter().map(|h| h.a_len() + h.b_len()).sum()
}

fn lcs(a: &[u64], b: &[u64]) -> usize {
    let mut row = vec![0; b.len() + 1];
    for &x in a {
        let mut diag = 0;
        for (j, &y) in b.iter().enumerate() {
            let up = row[j + 1];
            row[j + 1] = if x == y { diag + 1 } else { up.max(row[j]) };
            diag = up;
        }
    }
    row[b.len()]
}

#[test]
fn equal_and_empty() {
    assert_eq!(run(&[1, 2, 3], &[1, 2, 3]), []);
    assert_eq!(run(&[], &[]), []);
    assert_eq!(
        run(&[], &[1, 2]),
        [Hunk {
            a_start: 0,
            a_end: 0,
            b_start: 0,
            b_end: 2
        }]
    );
    assert_eq!(
        run(&[1, 2], &[]),
        [Hunk {
            a_start: 0,
            a_end: 2,
            b_start: 0,
            b_end: 0
        }]
    );
}

#[test]
fn one_change_of_each_kind() {
    let a = [1, 2, 3, 4, 5];
    assert_eq!(
        run(&a, &[1, 2, 9, 4, 5]),
        [Hunk {
            a_start: 2,
            a_end: 3,
            b_start: 2,
            b_end: 3
        }]
    );
    assert_eq!(
        run(&a, &[1, 2, 4, 5]),
        [Hunk {
            a_start: 2,
            a_end: 3,
            b_start: 2,
            b_end: 2
        }]
    );
    assert_eq!(
        run(&a, &[1, 2, 3, 7, 8, 4, 5]),
        [Hunk {
            a_start: 3,
            a_end: 3,
            b_start: 3,
            b_end: 5
        }]
    );
    assert_eq!(
        run(&a, &[0, 1, 2, 3, 4]),
        [
            Hunk {
                a_start: 0,
                a_end: 0,
                b_start: 0,
                b_end: 1
            },
            Hunk {
                a_start: 4,
                a_end: 5,
                b_start: 5,
                b_end: 5
            }
        ]
    );
}

#[test]
fn small_gaps_get_the_shortest_script() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for round in 0..3000 {
        let letters = 2 + round % 4;
        let a: Vec<u64> = (0..rng.below(40)).map(|_| rng.below(letters)).collect();
        let b: Vec<u64> = (0..rng.below(40)).map(|_| rng.below(letters)).collect();
        let hunks = run(&a, &b);
        assert_eq!(
            cost(&hunks),
            a.len() + b.len() - 2 * lcs(&a, &b),
            "{a:?} {b:?}"
        );
    }
}

/// A deck-like file: mostly unique lines, a few repeated ones, with edits of
/// all kinds here and there.
fn edited(rng: &mut Rng, lines: usize, edits: usize) -> (Vec<u64>, Vec<u64>, usize) {
    let a: Vec<u64> = (0..lines as u64)
        .map(|i| if i % 17 == 0 { 7 } else { 1000 + i })
        .collect();
    let mut b = a.clone();
    let mut changed = 0;
    for _ in 0..edits {
        let at = rng.below(b.len() as u64) as usize;
        let len = 1 + rng.below(20) as usize;
        let end = (at + len).min(b.len());
        match rng.below(3) {
            0 => {
                b.splice(at..at, (0..len).map(|_| rng.next() | 1 << 63));
                changed += len;
            }
            1 => {
                changed += end - at;
                b.drain(at..end);
            }
            _ => {
                for one in &mut b[at..end] {
                    *one = rng.next() | 1 << 63;
                }
                changed += 2 * (end - at);
            }
        }
    }
    (a, b, changed)
}

#[test]
fn large_files_are_anchored_on_their_unique_lines() {
    let mut rng = Rng(42);
    for _ in 0..5 {
        let (a, b, changed) = edited(&mut rng, 200_000, 100);
        let hunks = run(&a, &b);
        assert!(
            cost(&hunks) <= changed,
            "cost {} for {} changed lines",
            cost(&hunks),
            changed
        );
    }
}

#[test]
fn a_block_inserted_in_a_large_file() {
    let a: Vec<u64> = (0..100_000).collect();
    let mut b = a.clone();
    b.splice(50_000..50_000, 1_000_000..1_000_010);
    assert_eq!(
        run(&a, &b),
        [Hunk {
            a_start: 50_000,
            a_end: 50_000,
            b_start: 50_000,
            b_end: 50_010
        }]
    );
}

#[test]
fn a_block_moved_in_a_large_file() {
    // Its lines are unique on both sides, but out of order: the longest run in order is kept.
    let a: Vec<u64> = (0..10_000).collect();
    let mut b = a.clone();
    let moved: Vec<u64> = b.drain(1000..1100).collect();
    b.splice(7900..7900, moved);
    assert_eq!(cost(&run(&a, &b)), 200);
}

#[test]
fn large_gaps_without_unique_lines() {
    // Every line repeated: no anchors, but few edits.
    let a: Vec<u64> = (0..6000).map(|i| i % 2).collect();
    let b: Vec<u64> = (1..6001).map(|i| i % 2).collect();
    assert_eq!(cost(&run(&a, &b)), 2);
    // Nothing in common: too costly to compare, so one hunk.
    let a: Vec<u64> = (0..3000).collect();
    let b: Vec<u64> = (10_000..13_000).collect();
    assert_eq!(
        run(&a, &b),
        [Hunk {
            a_start: 0,
            a_end: 3000,
            b_start: 0,
            b_end: 3000
        }]
    );
}

#[test]
fn cancelled() {
    assert_eq!(diff(&[1, 2], &[2, 1], &AtomicBool::new(true)), None);
}

fn marks<'a>(a: &'a str, b: &'a str) -> (Vec<&'a str>, Vec<&'a str>) {
    let (ma, mb) = inline(a.as_bytes(), b.as_bytes());
    (
        ma.into_iter().map(|r| &a[r]).collect(),
        mb.into_iter().map(|r| &b[r]).collect(),
    )
}

#[test]
fn inline_marks_whole_numbers() {
    assert_eq!(
        marks(
            "GRID    1       0.      1.5     2.",
            "GRID    1       0.      1.55    2."
        ),
        (vec!["1.5     "], vec!["1.55    "])
    );
    assert_eq!(
        marks("1, 0.5, 1.5E+03", "1, 0.5, 1.6E+03"),
        (vec!["1.5E+03"], vec!["1.6E+03"])
    );
    assert_eq!(marks("1, 2, 3", "1, 2, 3, 4"), (vec![], vec![", 4"]));
    assert_eq!(
        marks("*Node, nset=all", "*Node, nset=ALL"),
        (vec!["all"], vec!["ALL"])
    );
}

#[test]
fn inline_leaves_unrelated_lines_unmarked() {
    assert_eq!(marks("*Node", "*Element, type=C3D8R"), (vec![], vec![]));
    assert_eq!(
        marks(
            "GRID    1       0.      1.5",
            "CQUAD4  5       1       2       3"
        ),
        (vec![], vec![])
    );
}

/// `cargo test -p hu-diff --release -- --ignored --nocapture`
#[test]
#[ignore]
fn speed_on_ten_million_lines() {
    let mut rng = Rng(7);
    let (a, b, _) = edited(&mut rng, 10_000_000, 2000);
    let start = std::time::Instant::now();
    let hunks = diff(&a, &b, &AtomicBool::new(false)).unwrap();
    println!("{} hunks in {:?}", hunks.len(), start.elapsed());
    check_valid(&a, &b, &hunks);
}

/// `cargo test -p hu-diff --release repeated -- --ignored --nocapture`
#[test]
#[ignore]
fn speed_with_repeated_lines() {
    let mut rng = Rng(11);
    for (lines, kinds, edits) in [
        (200_000u64, 1000u64, 500),
        (2_000_000, 1000, 500),
        (2_000_000, 50, 500),
        (2_000_000, 1000, 3000),
        (10_000_000, 1000, 3000),
    ] {
        let a: Vec<u64> = (0..lines).map(|_| rng.below(kinds)).collect();
        let mut b = a.clone();
        for _ in 0..edits {
            let at = rng.below(b.len() as u64) as usize;
            b[at] = rng.below(kinds);
        }
        let start = std::time::Instant::now();
        let hunks = diff(&a, &b, &AtomicBool::new(false)).unwrap();
        println!(
            "{lines} lines of {kinds} kinds, {edits} edits: {} hunks, cost {} in {:?}",
            hunks.len(),
            cost(&hunks),
            start.elapsed()
        );
    }
}
