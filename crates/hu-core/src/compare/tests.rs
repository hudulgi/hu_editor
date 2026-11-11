use std::io::Write;
use std::sync::atomic::AtomicBool;

use super::*;
use crate::document::Document;
use crate::history::EditKind;

fn open(content: &str) -> (tempfile::NamedTempFile, Document) {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(content.as_bytes()).unwrap();
    file.flush().unwrap();
    let doc = Document::open(file.path()).unwrap();
    doc.wait_for_index();
    (file, doc)
}

fn compare(left: &Document, right: &Document) -> Comparison {
    Comparison::new(
        left.text(),
        right.text(),
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap()
    .unwrap()
}

/// Rows as `left|right`, `-` for no line, `*` first in a hunk.
fn rows(c: &Comparison) -> Vec<String> {
    let text =
        |line: &Option<CompareLine>| line.as_ref().map_or("-".to_string(), |l| l.text.clone());
    let view = c.view(0, 1000).unwrap();
    view.rows
        .iter()
        .map(|r| {
            format!(
                "{}{}|{}",
                if r.hunk.is_some() { "*" } else { "" },
                text(&r.left),
                text(&r.right)
            )
        })
        .collect()
}

fn content(doc: &Document) -> String {
    String::from_utf8(doc.text().read_range(0, doc.len()).unwrap()).unwrap()
}

/// Copies hunk `index` to `to` the way the app does: an edit, then a sync.
fn merge(c: &mut Comparison, docs: [&Document; 2], index: usize, to: Side) {
    let m = c.merge(index, to).unwrap();
    let doc = docs[to.index()];
    doc.edit(m.start, m.end, &m.text, EditKind::Other, (m.start, m.start));
    c.sync(to, doc.text()).unwrap();
}

/// Everything a comparison keeps agrees with comparing afresh: the hashes,
/// equal lines between the hunks, the rows.
fn check(c: &Comparison) {
    for side in [Side::Left, Side::Right] {
        let text = &c.texts[side.index()];
        let fresh = hash_lines(
            text,
            0,
            u64::MAX,
            CHUNK,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap()
        .unwrap();
        assert_eq!(c.hashes[side.index()], fresh, "hashes of {side:?}");
    }
    let [a, b] = &c.hashes;
    let (mut i, mut j) = (0, 0);
    for h in &c.hunks {
        assert!(
            h.a_len() + h.b_len() > 0 && h.a_start >= i && h.b_start >= j,
            "{h:?}"
        );
        assert_eq!(a[i..h.a_start], b[j..h.b_start], "before {h:?}");
        (i, j) = (h.a_end, h.b_end);
    }
    assert_eq!(a[i..], b[j..], "after the hunks");
    let mut again = Comparison {
        texts: c.texts.clone(),
        hashes: c.hashes.clone(),
        hunks: c.hunks.clone(),
        starts: Vec::new(),
    };
    again.place_hunks(0);
    assert_eq!(c.starts, again.starts, "rows");
}

#[test]
fn side_by_side() {
    let (_a, left) = open("a\nb\nc\nd\n");
    let (_b, right) = open("a\nB\nc\nx\nd\n");
    let c = compare(&left, &right);
    assert_eq!(rows(&c), ["a|a", "*b|B", "c|c", "*-|x", "d|d", "|"]);
    assert_eq!((c.rows(), c.hunk_count()), (6, 2));
    let only_right = HunkLines {
        changed: 0,
        only_left: 0,
        only_right: 1,
    };
    assert_eq!(
        c.hunk_rows(1),
        Some(HunkRows {
            index: 1,
            start: 3,
            end: 4,
            lines: only_right,
        })
    );
    assert_eq!(c.hunk_from(0, true).map(|h| h.index), Some(0));
    assert_eq!(c.hunk_from(1, true).map(|h| h.index), Some(1));
    assert_eq!(c.hunk_from(3, false).map(|h| h.index), Some(0));
    assert_eq!(c.hunk_from(1, false), None);
    assert_eq!(c.hunk_from(3, true), None);
    assert_eq!((c.hunk_at(1), c.hunk_at(2)), (Some(0), None));
    let near = |row, reach| c.hunk_near(row, reach).map(|h| h.index);
    assert_eq!(
        [near(1, 0), near(0, 1), near(2, 0), near(2, 1)],
        [Some(0), Some(0), None, Some(0)]
    );
    // Row 2 is as near to both: the first. Row 4 is one past the second, row 5 two.
    assert_eq!([near(4, 1), near(4, 0), near(5, 1)], [Some(1), None, None]);
    assert_eq!(near(3, 0), Some(1));
    let view = c.view(3, 2).unwrap();
    let both = HunkLines {
        changed: 1,
        only_left: 0,
        only_right: 1,
    };
    assert_eq!(view.lines, both);
    assert_eq!((view.top, view.total, view.rows.len()), (3, 6, 2));
    assert_eq!(view.rows[1].left.as_ref().map(|l| l.line), Some(3));
    assert_eq!(view.rows[1].right.as_ref().map(|l| l.line), Some(4));
}

#[test]
fn line_breaks_are_not_compared_but_a_last_one_is() {
    let (_a, left) = open("a\r\nb\r\n");
    let (_b, right) = open("a\nb\n");
    assert_eq!(compare(&left, &right).hunk_count(), 0);
    let (_c, without) = open("a\nb");
    assert_eq!(rows(&compare(&right, &without)), ["a|a", "b|b", "*|-"]);
}

#[test]
fn hashes_whatever_the_chunks() {
    let text = "ab\r\ncd\r\r\n\r\n\rx\r\nlong line here\r\r\rend\r";
    let (_f, doc) = open(text);
    let lines: Vec<&[u8]> = text.as_bytes().split(|&b| b == b'\n').collect();
    let expected: Vec<u64> = lines
        .iter()
        .map(|l| xxh3_64(l.strip_suffix(b"\r").unwrap_or(l)))
        .collect();
    let never = AtomicBool::new(false);
    for chunk in [1, 2, 3, 5, 7, 64] {
        let got = hash_lines(&doc.text(), 0, u64::MAX, chunk, &never, &mut |_| {})
            .unwrap()
            .unwrap();
        assert_eq!(got, expected, "chunk {chunk}");
        // From the start of line 2, three lines.
        let got = hash_lines(&doc.text(), 9, 3, chunk, &never, &mut |_| {})
            .unwrap()
            .unwrap();
        assert_eq!(got, expected[2..5], "chunk {chunk}, part");
    }
}

#[test]
fn marks_in_changed_lines() {
    let (_a, left) = open("GRID    1       0.      1.5\n** 주석 a\nsame\n");
    let (_b, right) = open("GRID    1       0.      1.6\n** 주석 b\nsame\n");
    let view = compare(&left, &right).view(0, 10).unwrap();
    let marks = |row: usize| {
        let r = &view.rows[row];
        (
            r.left.as_ref().unwrap().marks.clone(),
            r.right.as_ref().unwrap().marks.clone(),
        )
    };
    assert_eq!(marks(0), (vec![[24, 27]], vec![[24, 27]]));
    // In UTF-16 units: "** 주석 " is six.
    assert_eq!(marks(1), (vec![[6, 7]], vec![[6, 7]]));
    assert_eq!(marks(2), (vec![], vec![]));
}

#[test]
fn overview() {
    let (_a, left) = open("a\nb\nc\nd\ne\nf\ng\nh\n");
    let (_b, right) = open("a\nB\nc\nd\ne\nf\nh\nnew\n");
    let c = compare(&left, &right);
    assert_eq!(
        rows(&c),
        [
            "a|a", "*b|B", "c|c", "d|d", "e|e", "f|f", "*g|-", "h|h", "*-|new", "|"
        ]
    );
    assert_eq!(
        c.overview(5),
        [OVERVIEW_CHANGED, 0, 0, OVERVIEW_LEFT, OVERVIEW_RIGHT]
    );
    assert_eq!(c.overview(1), [OVERVIEW_CHANGED]);
    // More buckets than rows: each row covers its share.
    let o = c.overview(20);
    assert_eq!(
        (o[1], o[2], o[3], o[4]),
        (0, OVERVIEW_CHANGED, OVERVIEW_CHANGED, 0)
    );
    assert_eq!(
        (o[12], o[13], o[14], o[16], o[17], o[18]),
        (
            OVERVIEW_LEFT,
            OVERVIEW_LEFT,
            0,
            OVERVIEW_RIGHT,
            OVERVIEW_RIGHT,
            0
        )
    );
    assert!(c.overview(0).is_empty());
    // A hunk of both kinds: its rows changed, then its rows on one side only.
    let (_c, left) = open("a\nb\nc\nd\n");
    let (_d, right) = open("a\nB\nd\n");
    let c = compare(&left, &right);
    assert_eq!(rows(&c), ["a|a", "*b|B", "*c|-", "d|d", "|"]);
    assert_eq!(c.overview(5), [0, OVERVIEW_CHANGED, OVERVIEW_LEFT, 0, 0]);
}

#[test]
fn merging_each_kind_of_hunk() {
    let cases: &[(&str, &str, Side, &str)] = &[
        // Lines changed.
        ("a\nb\nc\n", "a\nB\nc\n", Side::Right, "a\nb\nc\n"),
        ("a\nb\nc\n", "a\nB\nc\n", Side::Left, "a\nB\nc\n"),
        // Lines only on the left, in the middle and at the end without a break.
        ("a\nb\nc\n", "a\nc\n", Side::Right, "a\nb\nc\n"),
        ("a\nb\nc\n", "a\nc\n", Side::Left, "a\nc\n"),
        ("a\nb", "a", Side::Right, "a\nb"),
        ("a\nb", "a", Side::Left, "a"),
        // At the very start.
        ("x\na\n", "a\n", Side::Right, "x\na\n"),
        ("x\na\n", "a\n", Side::Left, "a\n"),
        // Into CRLF, from LF: the document's own line breaks.
        (
            "a\nx\ny\nc\n",
            "a\r\nB\r\nc\r\n",
            Side::Right,
            "a\r\nx\r\ny\r\nc\r\n",
        ),
        (
            "a\r\nx\r\ny\r\nc\r\n",
            "a\nB\nc\n",
            Side::Right,
            "a\nx\ny\nc\n",
        ),
        // All of it.
        ("", "a\nb", Side::Right, ""),
        ("a\nb\n", "z\n", Side::Right, "a\nb\n"),
    ];
    for &(l, r, to, expected) in cases {
        let (_a, left) = open(l);
        let (_b, right) = open(r);
        let mut c = compare(&left, &right);
        assert_eq!(c.hunk_count(), 1, "{l:?} {r:?}");
        merge(&mut c, [&left, &right], 0, to);
        let doc = if to == Side::Right { &right } else { &left };
        assert_eq!(content(doc), expected, "{l:?} {r:?} to {to:?}");
        assert_eq!(c.hunk_count(), 0, "{l:?} {r:?} to {to:?}");
        check(&c);
    }
}

#[test]
fn merging_keeps_the_rest() {
    let (_a, left) = open("a\nb\nc\nd\ne\nf\n");
    let (_b, right) = open("a\nB\nc\nd\nE\nf\nnew\n");
    let mut c = compare(&left, &right);
    assert_eq!(c.hunk_count(), 3);
    merge(&mut c, [&left, &right], 1, Side::Left);
    assert_eq!(content(&left), "a\nb\nc\nd\nE\nf\n");
    assert_eq!(
        rows(&c),
        ["a|a", "*b|B", "c|c", "d|d", "E|E", "f|f", "*-|new", "|"]
    );
    check(&c);
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
}

fn random_lines(rng: &mut Rng, lines: usize) -> String {
    (0..lines)
        .map(|_| match rng.below(4) {
            0 => format!("{}", rng.below(5)),
            1 => format!("{}\r", rng.below(5)),
            _ => format!("line {}", rng.below(1000)),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn edits_anywhere_are_compared_again_where_they_are() {
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    for _ in 0..40 {
        let (_a, left) = open(&random_lines(&mut rng, 60));
        let (_b, right) = open(&random_lines(&mut rng, 60));
        let docs = [&left, &right];
        let mut c = compare(&left, &right);
        check(&c);
        for _ in 0..30 {
            let side = if rng.below(2) == 0 {
                Side::Left
            } else {
                Side::Right
            };
            let doc = docs[side.index()];
            let start = rng.below(doc.len() + 1);
            let end = (start + rng.below(12)).min(doc.len());
            let text = ["", "x", "\n", "line 7\n", "\r\n", "a\nb\nc", "\r"][rng.below(7) as usize];
            doc.edit(start, end, text, EditKind::Other, (start, start));
            c.sync(side, doc.text()).unwrap();
            check(&c);
        }
    }
}

#[test]
fn copying_every_hunk_makes_the_files_equal() {
    let mut rng = Rng(77);
    for round in 0..20 {
        let (_a, left) = open(&random_lines(&mut rng, 80).replace('\r', ""));
        let (_b, right) = open(&random_lines(&mut rng, 80).replace('\r', ""));
        let mut c = compare(&left, &right);
        let to = if round % 2 == 0 {
            Side::Right
        } else {
            Side::Left
        };
        for _ in 0..200 {
            if c.hunk_count() == 0 {
                break;
            }
            let index = rng.below(c.hunk_count() as u64) as usize;
            merge(&mut c, [&left, &right], index, to);
            check(&c);
        }
        assert_eq!(c.hunk_count(), 0);
        assert_eq!(content(&left), content(&right));
    }
}

#[test]
fn cancelled() {
    let (_a, left) = open("a\n");
    let (_b, right) = open("b\n");
    let cancelled = Comparison::new(
        left.text(),
        right.text(),
        &AtomicBool::new(true),
        &mut |_| {},
    )
    .unwrap();
    assert!(cancelled.is_none());
}

/// `HU_LEFT=a HU_RIGHT=b cargo test -p hu-core --release speed -- --ignored --nocapture`
#[test]
#[ignore]
fn speed_on_files_given() {
    let (Ok(left), Ok(right)) = (std::env::var("HU_LEFT"), std::env::var("HU_RIGHT")) else {
        return;
    };
    let start = std::time::Instant::now();
    let (left, right) = (
        Document::open(left).unwrap(),
        Document::open(right).unwrap(),
    );
    left.wait_for_index();
    right.wait_for_index();
    println!("indexed in {:?}", start.elapsed());
    let start = std::time::Instant::now();
    let c = compare(&left, &right);
    println!(
        "{} lines, {} hunks, {} rows in {:?}",
        c.lines(Side::Left),
        c.hunk_count(),
        c.rows(),
        start.elapsed()
    );
    let start = std::time::Instant::now();
    let middle = c.rows() / 2;
    let view = c.view(middle, 60).unwrap();
    println!("60 rows from the middle in {:?}", start.elapsed());
    assert_eq!(view.rows.len(), 60);
}
