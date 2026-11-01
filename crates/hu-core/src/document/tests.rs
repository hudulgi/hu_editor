use std::io::Write;
use std::sync::atomic::AtomicBool;

use super::*;
use crate::search::{FindOptions, FindResult};
use crate::source::BLOCK_SIZE;
use crate::text::BoxRows;

fn open(content: &[u8]) -> (tempfile::NamedTempFile, Document) {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(content).unwrap();
    file.flush().unwrap();
    let doc = Document::open(file.path()).unwrap();
    doc.wait_for_index();
    (file, doc)
}

fn texts(view: &View) -> Vec<&str> {
    view.lines.iter().map(|l| l.text.as_str()).collect()
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

/// Deck-like lines of varying length, some CRLF, some with Korean comments.
fn sample(lines: usize) -> Vec<u8> {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut out = Vec::new();
    for i in 0..lines {
        let r = rng.next();
        match r % 10 {
            0 => out.extend_from_slice("** 한글 주석 comment".as_bytes()),
            1 => out.extend_from_slice(b"*Element, type=C3D8R, elset=E"),
            _ => {}
        }
        out.extend(std::iter::repeat_n(
            b'0' + (i % 10) as u8,
            (r % 120) as usize,
        ));
        out.extend_from_slice(if r.is_multiple_of(7) { b"\r\n" } else { b"\n" });
    }
    out
}

fn line_starts(content: &[u8]) -> Vec<u64> {
    let mut starts = vec![0];
    starts.extend(memchr::memchr_iter(b'\n', content).map(|i| i as u64 + 1));
    starts
}

/// The document reads exactly like `model`: bytes, line numbers, line
/// offsets, navigation and the view.
fn assert_matches(doc: &Document, model: &[u8]) {
    let text = doc.text();
    assert_eq!(text.len(), model.len() as u64);
    assert!(
        text.read_range(0, text.len()).unwrap() == model,
        "text differs"
    );
    let starts = line_starts(model);
    assert_eq!(doc.index_status().lines, starts.len() as u64);

    let step = (starts.len() / 400).max(1);
    for (line, &start) in starts.iter().enumerate().step_by(step) {
        assert_eq!(
            text.line_offset(line as u64).unwrap(),
            Some(start),
            "offset of line {line}"
        );
        assert_eq!(
            text.line_number(start).unwrap(),
            Some(line as u64),
            "line at {start}"
        );
        if let Some(&next) = starts.get(line + 1) {
            let mid = (start + next) / 2;
            assert_eq!(
                text.line_number(mid).unwrap(),
                Some(line as u64),
                "line at {mid}"
            );
            assert_eq!(text.line_start(mid).unwrap(), start, "line start of {mid}");
        }
    }
    assert_eq!(
        text.line_number(model.len() as u64).unwrap(),
        Some(starts.len() as u64 - 1)
    );
    assert_eq!(text.line_offset(starts.len() as u64).unwrap(), None);

    // Near the end the view is clamped to the last page.
    let view = text
        .view(
            ViewTarget::Line {
                line: starts.len() as u64 / 2,
            },
            5,
        )
        .unwrap();
    let first = view.first_line.unwrap() as usize;
    for (i, shown) in view.lines.iter().enumerate() {
        let start = starts[first + i] as usize;
        let end = starts
            .get(first + i + 1)
            .map_or(model.len(), |&s| s as usize - 1);
        let content = model[start..end]
            .strip_suffix(b"\r")
            .unwrap_or(&model[start..end]);
        assert_eq!(shown.offset, start as u64);
        assert_eq!(shown.len, content.len() as u64);
        assert_eq!(shown.text, String::from_utf8_lossy(content));
    }
}

/// What the document stores for `text`: the file's line breaks.
fn stored(doc: &Document, text: &str) -> Vec<u8> {
    let lf = text.replace("\r\n", "\n");
    match doc.eol() {
        Eol::Lf => lf.into_bytes(),
        Eol::Crlf => lf.replace('\n', "\r\n").into_bytes(),
    }
}

const INSERTS: [&str; 8] = [
    "",
    "x",
    "abc",
    "\n",
    "a\nb\n",
    "한글",
    "*Node\n1, 2, 3\n",
    "\r\n",
];

#[test]
fn line_numbers_match_naive_scan() {
    let content = sample(5000);
    assert!(
        content.len() > BLOCK_SIZE,
        "should span several cache blocks"
    );
    let (_file, doc) = open(&content);
    assert_matches(&doc, &content);
}

#[test]
fn random_edits_match_a_byte_model() {
    let mut model = sample(3000);
    let (_file, doc) = open(&model);
    let mut rng = Rng(42);
    for round in 0..400 {
        let len = model.len() as u64;
        let start = rng.below(len + 1);
        let span = if rng.below(10) == 0 { 20_000 } else { 60 };
        let end = (start + rng.below(span)).min(len);
        let insert = INSERTS[rng.below(INSERTS.len() as u64) as usize];
        let result = doc.edit(start, end, insert, EditKind::Other, (start, end));
        let bytes = stored(&doc, insert);
        model.splice(start as usize..end as usize, bytes.iter().copied());
        assert_eq!(result.caret, start + bytes.len() as u64);
        if round % 40 == 0 {
            assert_matches(&doc, &model);
        }
    }
    assert_matches(&doc, &model);
}

#[test]
fn edits_before_the_index_is_done_settle_later() {
    let mut model = sample(400_000);
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(&model).unwrap();
    let doc = Document::open(file.path()).unwrap();
    // Most likely still indexing: these split pieces of unknown line counts.
    let mut rng = Rng(7);
    for _ in 0..50 {
        let start = rng.below(model.len() as u64);
        let end = (start + rng.below(100)).min(model.len() as u64);
        doc.edit(start, end, "x\ny", EditKind::Other, (start, end));
        model.splice(start as usize..end as usize, stored(&doc, "x\ny"));
    }
    doc.wait_for_index();
    assert_matches(&doc, &model);
}

#[test]
fn undo_and_redo_walk_the_history() {
    let original = sample(800);
    let (_file, doc) = open(&original);
    let mut models = vec![original.clone()];
    let mut rng = Rng(3);
    for _ in 0..60 {
        let mut model = models.last().unwrap().clone();
        let len = model.len() as u64;
        let start = rng.below(len + 1);
        let end = (start + rng.below(200)).min(len);
        let insert = INSERTS[rng.below(INSERTS.len() as u64) as usize];
        doc.edit(start, end, insert, EditKind::Other, (start, end));
        model.splice(start as usize..end as usize, stored(&doc, insert));
        models.push(model);
    }
    assert!(doc.state().dirty);
    for model in models.iter().rev().skip(1) {
        doc.undo().unwrap();
        assert_matches(&doc, model);
    }
    assert!(doc.undo().is_none());
    assert!(!doc.state().dirty, "back to the file as opened");
    for model in models.iter().skip(1) {
        doc.redo().unwrap();
        assert_matches(&doc, model);
    }
    assert!(doc.redo().is_none());
}

#[test]
fn typing_and_backspacing_undo_as_one_step() {
    let (_file, doc) = open(b"*Node\n");
    for (i, c) in ["a", "b", "c"].into_iter().enumerate() {
        let at = 5 + i as u64;
        doc.edit(at, at, c, EditKind::Typing, (at, at));
    }
    assert_eq!(doc.text().read_range(0, 9).unwrap(), b"*Nodeabc\n");
    let undo = doc.undo().unwrap();
    assert_eq!(
        (undo.anchor, undo.caret),
        (5, 5),
        "selection before the first keystroke"
    );
    assert_eq!(doc.text().read_range(0, 6).unwrap(), b"*Node\n");
    assert!(!doc.state().can_undo);

    for at in [5, 4, 3] {
        doc.edit(at - 1, at, "", EditKind::Backspace, (at, at));
    }
    assert_eq!(doc.text().read_range(0, 3).unwrap(), b"*N\n");
    doc.undo().unwrap();
    assert_eq!(doc.text().read_range(0, 6).unwrap(), b"*Node\n");
}

#[test]
fn save_replaces_the_file_and_keeps_undo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deck.inp");
    fs::write(&path, b"*Heading\n*Node\n1, 0., 0., 0.\n").unwrap();
    let doc = Document::open(&path).unwrap();
    doc.wait_for_index();

    doc.edit(9, 9, "** added\n", EditKind::Other, (9, 9));
    assert!(doc.state().dirty);
    assert!(doc.save(&AtomicBool::new(false), &mut |_| {}).unwrap());
    assert_eq!(
        fs::read(&path).unwrap(),
        b"*Heading\n** added\n*Node\n1, 0., 0., 0.\n"
    );
    assert!(!doc.state().dirty);
    assert!(
        !doc.changed_on_disk(),
        "our own save is not an outside change"
    );
    assert_eq!(
        fs::read_dir(dir.path()).unwrap().count(),
        1,
        "no temporary file left"
    );

    // The replaced original still backs undo.
    doc.undo().unwrap();
    assert!(doc.state().dirty);
    assert_matches(&doc, b"*Heading\n*Node\n1, 0., 0., 0.\n");
    doc.redo().unwrap();
    assert!(!doc.state().dirty, "redo returns to the saved state");

    fs::write(&path, b"changed elsewhere\n").unwrap();
    assert!(doc.changed_on_disk());
}

#[test]
fn line_breaks_follow_the_file() {
    let (_file, doc) = open(b"a\r\nb\r\n");
    assert_eq!(doc.eol(), Eol::Crlf);
    doc.edit(0, 0, "x\ny\r\nz", EditKind::Other, (0, 0));
    assert_eq!(
        doc.text().read_range(0, doc.len()).unwrap(),
        b"x\r\ny\r\nza\r\nb\r\n"
    );
}

#[test]
fn typing_into_a_cp949_file_writes_cp949() {
    let (bytes, _, _) = encoding_rs::EUC_KR.encode("** 강철\n*Material, name=STEEL\n");
    let (_file, doc) = open(&bytes);
    assert_eq!(doc.encoding(), Encoding::Cp949);
    let end = doc.len();
    doc.edit(end, end, "** 재료", EditKind::Other, (end, end));
    let all = doc.text().read_range(0, doc.len()).unwrap();
    assert_eq!(
        encoding_rs::EUC_KR.decode(&all).0,
        "** 강철\n*Material, name=STEEL\n** 재료"
    );
    assert_eq!(doc.copy_text(0, 7).unwrap(), "** 강철");
}

#[test]
fn search_sees_edits() {
    let content = sample(2000);
    let (_file, doc) = open(&content);
    let at = content.len() as u64 / 2;
    doc.edit(at, at, "NEEDLE", EditKind::Other, (at, at));
    let found = doc.text().find(
        b"NEEDLE",
        0,
        &FindOptions::default(),
        &AtomicBool::new(false),
        &mut |_| {},
    );
    assert_eq!(found.unwrap(), FindResult::Found(at));
}

#[test]
fn crlf_and_no_trailing_newline() {
    let (_file, doc) = open(b"*Heading\r\n** comment\r\n*Node\r\n1, 0., 0., 0.");
    let view = doc
        .view(ViewTarget::Fraction { fraction: 0.0 }, 10)
        .unwrap();
    assert_eq!(
        texts(&view),
        ["*Heading", "** comment", "*Node", "1, 0., 0., 0."]
    );
    assert_eq!(view.lines[0].len, 8, "without the CR");
    assert_eq!((view.top, view.max_top, view.first_line), (0, 0, Some(0)));
    assert_eq!(view.end, doc.len());
    assert_eq!(doc.index_status().lines, 4);
}

#[test]
fn trailing_newline_gives_empty_last_line() {
    let (_file, doc) = open(b"a\nb\n");
    let view = doc
        .view(ViewTarget::Fraction { fraction: 0.0 }, 10)
        .unwrap();
    assert_eq!(texts(&view), ["a", "b", ""]);
    assert_eq!(doc.index_status().lines, 3);
}

#[test]
fn empty_file() {
    let (_file, doc) = open(b"");
    let view = doc
        .view(ViewTarget::Fraction { fraction: 0.5 }, 10)
        .unwrap();
    assert_eq!(texts(&view), [""]);
    let status = doc.index_status();
    assert!(status.complete);
    assert_eq!(status.lines, 1);

    doc.edit(0, 0, "*Heading", EditKind::Typing, (0, 0));
    assert_matches(&doc, b"*Heading");
}

#[test]
fn scrolling_and_jumps() {
    let content: Vec<String> = (0..100).map(|i| format!("line {i}")).collect();
    let (_file, doc) = open(content.join("\n").as_bytes());
    let text = doc.text();
    let first = |target| text.view(target, 10).unwrap().first_line.unwrap();

    assert_eq!(
        first(ViewTarget::Scroll {
            anchor: 0,
            delta: 5
        }),
        5
    );
    assert_eq!(
        first(ViewTarget::Scroll {
            anchor: 0,
            delta: 1000
        }),
        90,
        "clamped to last page"
    );
    let last_top = text.last_page_top(10).unwrap();
    assert_eq!(
        first(ViewTarget::Scroll {
            anchor: last_top,
            delta: -1000
        }),
        0
    );
    assert_eq!(first(ViewTarget::Fraction { fraction: 1.0 }), 90);
    assert!((40..50).contains(&first(ViewTarget::Fraction { fraction: 0.5 })));
    assert_eq!(first(ViewTarget::Line { line: 42 }), 42);
    assert_eq!(first(ViewTarget::Line { line: 99 }), 90);
    assert_eq!(
        first(ViewTarget::Line { line: 5000 }),
        90,
        "past the end: last page"
    );
    let line_50 = text.line_offset(50).unwrap().unwrap();
    assert_eq!(
        first(ViewTarget::Offset {
            offset: line_50 + 3,
            context: 3
        }),
        47
    );

    let view = text.view(ViewTarget::Line { line: 42 }, 10).unwrap();
    assert_eq!(view.lines.len(), 10);
    assert_eq!(view.lines[0].text, "line 42");
    assert_eq!(view.end, text.line_offset(52).unwrap().unwrap());
}

#[test]
fn non_ascii_lines_carry_byte_offsets() {
    let content = "** 한글 STEEL\n*Material, name=STEEL\n";
    let (_file, doc) = open(content.as_bytes());
    let view = doc
        .view(ViewTarget::Fraction { fraction: 0.0 }, 10)
        .unwrap();
    let starts = view.lines[0].char_starts.as_ref().unwrap();
    let col = view.lines[0]
        .text
        .encode_utf16()
        .position(|u| u == u16::from(b'S'))
        .unwrap();
    assert_eq!(starts[col] as usize, content.find("STEEL").unwrap());
    assert_eq!(*starts.last().unwrap() as u64, view.lines[0].len);
    assert!(view.lines[1].char_starts.is_none(), "ASCII");
}

#[test]
fn cp949_lines_are_decoded() {
    let (bytes, _, _) = encoding_rs::EUC_KR.encode("** 강철 재료\n*Material, name=STEEL");
    let (_file, doc) = open(&bytes);
    let view = doc
        .view(ViewTarget::Fraction { fraction: 0.0 }, 10)
        .unwrap();
    assert_eq!(texts(&view), ["** 강철 재료", "*Material, name=STEEL"]);
}

#[test]
fn very_long_lines_are_broken() {
    let max_scan = 1usize << 20;
    let (_file, doc) = open(&vec![b'x'; 2 * max_scan + 10]);
    let view = doc.view(ViewTarget::Fraction { fraction: 0.0 }, 5).unwrap();
    assert_eq!(view.lines.len(), 3);
    assert!(view.lines[0].truncated);
    assert_eq!(view.lines[0].text.len(), 16 * 1024);
    assert_eq!(view.lines[2].text.len(), 10);
}

fn all_text(doc: &Document) -> String {
    String::from_utf8(doc.text().read_range(0, doc.len()).unwrap()).unwrap()
}

const FIELDS: &str = "GRID    1       0.      0.\nGRID    2       1.      0.\nGRID    3\nGRID    4       3.      0.\n";

#[test]
fn box_copy_and_replace_one_column() {
    let (_file, doc) = open(FIELDS.as_bytes());
    let bottom = doc.text().line_offset(3).unwrap().unwrap();
    assert_eq!(
        doc.box_text(0, bottom, 16, 24).unwrap(),
        "0.      \n1.      \n\n3.      "
    );

    let (result, last) = doc
        .edit_box(
            0,
            BoxRows::Until { bottom },
            16,
            24,
            &["9.".into()],
            EditKind::Other,
            (0, 0),
        )
        .unwrap()
        .unwrap();
    let after =
        "GRID    1       9.0.\nGRID    2       9.0.\nGRID    3       9.\nGRID    4       9.0.\n";
    assert_eq!(
        all_text(&doc),
        after,
        "the short line is padded to the column"
    );
    assert_eq!(last, doc.text().line_offset(3).unwrap().unwrap());
    assert_eq!(result.change.start, 16);
    assert_matches(&doc, after.as_bytes());

    doc.undo().unwrap();
    assert_eq!(all_text(&doc), FIELDS, "one undo step");
}

#[test]
fn column_typing_undoes_as_one_step() {
    let (_file, doc) = open(b"x\ny\nz\n");
    let rows = |n| BoxRows::Count { count: n };
    doc.edit_box(0, rows(3), 0, 0, &["a".into()], EditKind::Typing, (0, 0))
        .unwrap();
    doc.edit_box(0, rows(3), 1, 1, &["b".into()], EditKind::Typing, (1, 1))
        .unwrap();
    assert_eq!(all_text(&doc), "abx\naby\nabz\n");
    doc.undo().unwrap();
    assert_eq!(all_text(&doc), "x\ny\nz\n");
    assert!(!doc.state().can_undo);
}

#[test]
fn box_follows_display_columns() {
    let (_file, doc) = open("** 한글 a\n** abcd b\n".as_bytes());
    let bottom = doc.text().line_offset(1).unwrap().unwrap();
    // Columns 3..5 are 한 on the first line and "ab" on the second.
    doc.edit_box(
        0,
        BoxRows::Until { bottom },
        3,
        5,
        &[String::new()],
        EditKind::Delete,
        (0, 0),
    )
    .unwrap();
    assert_eq!(all_text(&doc), "** 글 a\n** cd b\n");
}

#[test]
fn box_paste_spreads_lines() {
    let (_file, doc) = open(b"1\n2\n3\n");
    let (_, last) = doc
        .edit_box(
            0,
            BoxRows::Count { count: 2 },
            1,
            1,
            &[",A".into(), ",B".into()],
            EditKind::Other,
            (0, 0),
        )
        .unwrap()
        .unwrap();
    assert_eq!(all_text(&doc), "1,A\n2,B\n3\n");
    assert_eq!(last, 4);
}

fn naive_replace(
    model: &[u8],
    needle: &[u8],
    with: &[u8],
    case_sensitive: bool,
) -> (Vec<u8>, usize) {
    let (mut out, mut count, mut i) = (Vec::new(), 0, 0);
    while i < model.len() {
        let hit = model.len() - i >= needle.len() && {
            let window = &model[i..i + needle.len()];
            if case_sensitive {
                window == needle
            } else {
                window.eq_ignore_ascii_case(needle)
            }
        };
        if hit {
            out.extend_from_slice(with);
            i += needle.len();
            count += 1;
        } else {
            out.push(model[i]);
            i += 1;
        }
    }
    (out, count)
}

#[test]
fn replace_all_matches_a_naive_replace() {
    let mut model = sample(3000);
    let (_file, doc) = open(&model);
    // Edit first, so the replace runs over pieces.
    let mut rng = Rng(11);
    for _ in 0..30 {
        let start = rng.below(model.len() as u64);
        doc.edit(start, start, "*element x", EditKind::Other, (start, start));
        model.splice(
            start as usize..start as usize,
            b"*element x".iter().copied(),
        );
    }
    let cancel = AtomicBool::new(false);
    for (needle, with, case_sensitive) in [
        ("*Element", "*ELEM", true),
        ("*element", "", false),
        ("0000", "0\n0", true),
    ] {
        let (expected, count) = naive_replace(
            &model,
            needle.as_bytes(),
            &stored(&doc, with),
            case_sensitive,
        );
        let (replaced, _) = doc
            .replace_all(needle, with, case_sensitive, (0, 0), &cancel, &mut |_| {})
            .unwrap()
            .unwrap();
        assert_eq!(replaced, count, "{needle:?}");
        assert!(count > 0);
        assert_matches(&doc, &expected);
        model = expected;
    }
    // Each Replace All is one undo step.
    for _ in 0..3 {
        doc.undo().unwrap();
    }
    assert!(doc.state().can_undo, "the earlier edits remain");
}

#[test]
fn replace_all_without_matches_changes_nothing() {
    let (_file, doc) = open(b"*Heading\n");
    let result = doc
        .replace_all(
            "missing",
            "x",
            true,
            (0, 0),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
    assert!(matches!(result, Some((0, None))));
    assert!(!doc.state().dirty);
}

#[test]
fn a_new_document_is_saved_as_then_saved() {
    let doc = Document::untitled();
    assert_eq!(doc.path(), None);
    assert_eq!(doc.encoding(), Encoding::Utf8);
    assert_eq!(doc.wait_for_index().lines, 1);
    assert!(!doc.state().dirty);
    assert!(!doc.changed_on_disk());

    doc.edit(0, 0, "*Heading\n** new deck\n", EditKind::Typing, (0, 0));
    assert!(doc.state().dirty);
    assert!(
        doc.save(&AtomicBool::new(false), &mut |_| {}).is_err(),
        "no file name yet"
    );

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.inp");
    assert!(
        doc.save_as(&path, &AtomicBool::new(false), &mut |_| {})
            .unwrap()
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        stored(&doc, "*Heading\n** new deck\n")
    );
    assert_eq!(doc.path(), Some(path.clone()));
    assert!(!doc.state().dirty);

    let end = doc.len();
    doc.edit(end, end, "*Node\n", EditKind::Other, (end, end));
    assert!(doc.save(&AtomicBool::new(false), &mut |_| {}).unwrap());
    assert_eq!(
        fs::read(&path).unwrap(),
        stored(&doc, "*Heading\n** new deck\n*Node\n")
    );
    assert!(!doc.changed_on_disk());
    assert_matches(&doc, &stored(&doc, "*Heading\n** new deck\n*Node\n"));
}

#[test]
fn save_as_leaves_the_original_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a.inp"), dir.path().join("b.inp"));
    fs::write(&a, b"*Heading\n").unwrap();
    let doc = Document::open(&a).unwrap();
    doc.wait_for_index();

    doc.edit(9, 9, "*Node\n", EditKind::Other, (9, 9));
    assert!(
        doc.save_as(&b, &AtomicBool::new(false), &mut |_| {})
            .unwrap()
    );
    doc.edit(0, 0, "** b\n", EditKind::Other, (0, 0));
    assert!(doc.save(&AtomicBool::new(false), &mut |_| {}).unwrap());

    assert_eq!(fs::read(&a).unwrap(), b"*Heading\n");
    assert_eq!(fs::read(&b).unwrap(), b"** b\n*Heading\n*Node\n");
    assert_eq!(doc.path(), Some(b));
    assert_eq!(
        fs::read_dir(dir.path()).unwrap().count(),
        2,
        "no temporary files left"
    );
}

#[test]
fn dialect_follows_the_text() {
    let (_file, doc) = open(b"");
    assert_eq!(doc.dialect().unwrap(), None);
    doc.edit(0, 0, "*Node\n", EditKind::Typing, (0, 0));
    assert_eq!(doc.dialect().unwrap(), Some(Dialect::Abaqus));
    doc.undo().unwrap();
    doc.edit(0, 0, "GRID    1\n", EditKind::Other, (0, 0));
    assert_eq!(doc.dialect().unwrap(), Some(Dialect::Nastran));

    let (_file, nastran) = open(b"$ comment\nGRID    1\n");
    assert_eq!(nastran.dialect().unwrap(), Some(Dialect::Nastran));
}
