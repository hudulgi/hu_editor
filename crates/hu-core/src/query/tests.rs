use super::*;
use crate::problem::Problem;

// `Reader` for `&[u8]` comes from the search tests.

fn regex(needle: &str, case_sensitive: bool, whole_word: bool) -> Query {
    Query {
        needle: needle.into(),
        case_sensitive,
        whole_word,
        regex: true,
        scope: None,
    }
}

fn matcher(query: &Query, text: &[u8], chunk: usize) -> Matcher {
    Matcher::new(query, Encoding::Utf8, text.len() as u64)
        .unwrap()
        .unwrap()
        .chunked(chunk)
}

/// The matches a walk finds, and where it could go on from.
fn walk(matcher: &Matcher, text: &[u8], resume: u64) -> (Vec<(u64, u64)>, Vec<u64>) {
    let (mut found, mut resumes) = (Vec::new(), Vec::new());
    let never = AtomicBool::new(false);
    let done = matcher
        .each(
            &text,
            resume,
            u64::MAX,
            true,
            &never,
            &mut |_| {},
            &mut |step| {
                match step {
                    Step::Match(hit) => found.push((hit.start, hit.end)),
                    Step::Resume(at) => resumes.push(at),
                }
                ControlFlow::Continue(())
            },
        )
        .unwrap();
    assert!(done);
    (found, resumes)
}

/// The matches of each line on its own, with its line break: what a walk
/// through the whole text must find, however it is cut.
fn line_by_line(query: &Query, text: &[u8]) -> Vec<(u64, u64)> {
    let mut found = Vec::new();
    let mut start = 0;
    for line in text.split_inclusive(|&b| b == b'\n') {
        let alone = matcher(query, line, 1 << 20);
        // One at the end of a line break is the next line's.
        let ends = line.len() as u64;
        let own = walk(&alone, line, 0)
            .0
            .into_iter()
            .filter(|&(a, _)| a < ends || !line.ends_with(b"\n"));
        found.extend(own.map(|(a, b)| (a + start, b + start)));
        start += line.len() as u64;
    }
    // After a last line break, an empty line.
    if text.ends_with(b"\n") {
        let alone = matcher(query, b"", 1 << 20);
        found.extend(
            walk(&alone, b"", 0)
                .0
                .into_iter()
                .map(|(a, b)| (a + start, b + start)),
        );
    }
    found
}

const DECK: &[u8] = b"*Heading\n** steel plate, 0.101 thick\r\n*Node\n101, 0.5, 1.0\n\
    102, 1.5, 1.0\n*Element, type=S4R, elset=Plate\n1, 101, 102\n\n\
    *Nset, nset=Part-1-1.Set-1\n101, 102\n*Material, name=STEEL\n*End Step";

const PATTERNS: [&str; 16] = [
    r"^\*\w+",
    r"\d+\.\d*",
    r"\d+",
    r"(?i)nset",
    r"$",
    r"^",
    r"\s*$",
    r"[^,]+",
    r"e*",
    r"\bset-1\b",
    r"(\d+), (\d+)",
    r"\*(\w+), (\w+)=(\S+)",
    r".",
    r"\s+",
    r"x?",
    r"\.",
];

#[test]
fn a_walk_finds_what_each_line_alone_has() {
    for pattern in PATTERNS {
        for (case_sensitive, whole_word) in [(true, false), (false, false), (false, true)] {
            let query = regex(pattern, case_sensitive, whole_word);
            let expected = line_by_line(&query, DECK);
            // Windows hold the longest line, 32 bytes, and cut the rest anywhere.
            for chunk in [33, 40, 57, 1 << 20] {
                let m = matcher(&query, DECK, chunk);
                let (found, resumes) = walk(&m, DECK, 0);
                assert_eq!(found, expected, "{query:?} in windows of {chunk}");
                // Backward, the last of them before where it starts.
                for from in 0..=DECK.len() as u64 {
                    let Some(&(a, b)) = expected.iter().rev().find(|&&(a, _)| a < from) else {
                        continue;
                    };
                    let back = m.find(&DECK, from, true, &AtomicBool::new(false), &mut |_| {});
                    assert_eq!(
                        back.unwrap(),
                        FindResult::Found(a, b),
                        "{query:?} back from {from} in windows of {chunk}"
                    );
                }
                // Going on from where it could, it finds the rest.
                for at in resumes {
                    let rest: Vec<_> = found.iter().copied().filter(|&(a, _)| a >= at).collect();
                    assert_eq!(walk(&m, DECK, at).0, rest, "{query:?} from {at}");
                }
            }
        }
    }
}

#[test]
fn a_line_longer_than_a_window_is_searched_in_pieces() {
    let mut text = vec![b'x'; 100];
    text.extend_from_slice(b"\nx\n");
    let m = matcher(&regex("x", true, false), &text, 8);
    let (found, _) = walk(&m, &text, 0);
    assert_eq!(found.len(), 101);
    assert_eq!(found[100], (101, 102));
    let backward = m.find(
        &text.as_slice(),
        101,
        true,
        &AtomicBool::new(false),
        &mut |_| {},
    );
    assert_eq!(backward.unwrap(), FindResult::Found(99, 100));
}

#[test]
fn regexes_mean_what_they_say() {
    let all = |pattern: &str, text: &str| -> Vec<String> {
        let query = regex(pattern, false, false);
        let m = matcher(&query, text.as_bytes(), 1 << 20);
        let found = walk(&m, text.as_bytes(), 0).0;
        found
            .into_iter()
            .map(|(a, b)| text[a as usize..b as usize].to_string())
            .collect()
    };
    assert_eq!(all(r"^\*\w+", "*Node\n *Not\n*nset"), ["*Node", "*nset"]);
    assert_eq!(
        all(r"a*", "baaab"),
        ["", "aaa", ""],
        "no empty match after a match"
    );
    assert_eq!(all(r"\s+$", "a  \r\nb \nc"), ["  ", " "], "a CRLF stays");
    assert_eq!(all(r"\S+", "a\r\nb"), ["a", "b"]);
    assert_eq!(all(r"\Aa", "ab\nab"), ["a", "a"], "\\A is a line's start");
    assert_eq!(
        all(r"STEEL", "Steel steel"),
        ["Steel", "steel"],
        "ignore case"
    );
    assert_eq!(
        all(r"\w+", "강철 plate"),
        ["강철", "plate"],
        "Unicode classes"
    );
    // Whole words: `0.101` is one number, but `Set-1` stands alone after a point.
    let whole = |pattern: &str, text: &str| -> Vec<String> {
        let query = regex(pattern, false, true);
        let m = matcher(&query, text.as_bytes(), 1 << 20);
        walk(&m, text.as_bytes(), 0)
            .0
            .into_iter()
            .map(|(a, b)| text[a as usize..b as usize].to_string())
            .collect()
    };
    assert_eq!(whole(r"\d+", "0.101 101 1010 x1"), ["101", "1010"]);
    assert_eq!(whole(r"set-\d", "Part-1-1.Set-1 Set-10"), ["Set-1"]);
}

#[test]
fn line_breaks_and_bad_patterns_are_refused() {
    let problem = |pattern: &str, encoding| {
        let error = Matcher::new(&regex(pattern, false, false), encoding, 0)
            .err()
            .unwrap();
        error
            .into_inner()
            .unwrap()
            .downcast::<Problem>()
            .map(|p| *p)
            .unwrap()
    };
    assert_eq!(problem(r"a\nb", Encoding::Utf8), Problem::RegexLineBreak);
    assert_eq!(problem(r"[\n]", Encoding::Utf8), Problem::RegexLineBreak);
    assert_eq!(problem(r"\r", Encoding::Utf8), Problem::RegexLineBreak);
    assert_eq!(
        problem(r"a(b", Encoding::Utf8),
        Problem::BadRegex {
            message: "unclosed group".into()
        }
    );
    assert_eq!(problem("강철", Encoding::Cp949), Problem::RegexNotAscii);
    assert!(Matcher::new(&regex(r"\w+", false, false), Encoding::Cp949, 0).is_ok());
    let empty = Query::default();
    assert!(Matcher::new(&empty, Encoding::Utf8, 0).unwrap().is_none());
}

#[test]
fn finds_go_round_inside_the_scope() {
    let text = b"GRID 1\nGRID 2\nGRID 3\nGRID 4\n";
    let find = |query: &Query, from: u64, backward: bool, chunk| {
        let m = matcher(query, text, chunk);
        let found = m
            .find(
                &text.as_slice(),
                from,
                backward,
                &AtomicBool::new(false),
                &mut |_| {},
            )
            .unwrap();
        match found {
            FindResult::Found(a, _) => Some(a),
            _ => None,
        }
    };
    for regex_too in [false, true] {
        for chunk in [8, 1 << 20] {
            let mut query = regex(r"GRID", true, false);
            query.regex = regex_too;
            assert_eq!(find(&query, 0, false, chunk), Some(0));
            assert_eq!(find(&query, 1, false, chunk), Some(7));
            assert_eq!(find(&query, 22, false, chunk), Some(0), "round the end");
            assert_eq!(find(&query, 7, true, chunk), Some(0));
            assert_eq!(find(&query, 0, true, chunk), Some(21), "round the start");
            // Lines 2 and 3 only, the last of them cut short.
            query.scope = Some((7, 18));
            assert_eq!(find(&query, 0, false, chunk), Some(7));
            assert_eq!(find(&query, 8, false, chunk), Some(14));
            assert_eq!(find(&query, 15, false, chunk), Some(7));
            assert_eq!(find(&query, 7, true, chunk), Some(14));
            query.scope = Some((7, 16));
            assert_eq!(find(&query, 8, false, chunk), Some(7), "GRID must fit");
        }
    }
}

#[test]
fn counts_say_which_match_is_selected() {
    let mut text = Vec::new();
    for i in 0..60 {
        text.extend_from_slice(format!("GRID {i} GRIDX grid\n").as_bytes());
    }
    let text = text.as_slice();
    for regex_too in [false, true] {
        // Windows hold a line, 19 bytes at most.
        for chunk in [24, 100, 1 << 20] {
            let mut query = regex(r"grid", false, true);
            query.regex = regex_too;
            let m = matcher(&query, text, chunk);
            let never = AtomicBool::new(false);
            let count = m.count(&text, &never, &mut |_| {}).unwrap().unwrap();
            assert_eq!(count.total, 120);
            assert!(chunk > 100 || count.marks.len() > 10, "marks on the way");
            let all = walk(&m, text, 0).0;
            for (i, &(a, b)) in all.iter().enumerate() {
                assert_eq!(m.index(&text, &count, (a, b)).unwrap(), Some(i as u64 + 1));
                assert_eq!(m.index(&text, &count, (a, b - 1)).unwrap(), None);
                assert_eq!(m.index(&text, &count, (a + 1, b)).unwrap(), None);
            }
            // GRIDX is not a whole word.
            assert_eq!(m.index(&text, &count, (7, 11)).unwrap(), None);
            query.scope = Some((5, 60));
            let m = matcher(&query, text, chunk);
            let count = m.count(&text, &never, &mut |_| {}).unwrap().unwrap();
            // grid at 13, then GRID and grid on the next two lines, and GRID at 54.
            assert_eq!(count.total, 6, "{regex_too} {chunk}");
            assert_eq!(m.index(&text, &count, (13, 17)).unwrap(), Some(1));
            assert_eq!(m.index(&text, &count, (54, 58)).unwrap(), Some(6));
            assert_eq!(m.index(&text, &count, (0, 4)).unwrap(), None, "outside");
        }
    }
}

#[test]
fn templates_take_groups_and_escapes() {
    use Templated::{Group, Text};
    let t = |s: &str| Text(s.into());
    assert_eq!(template("$1-$2", 3), [Group(1), t("-"), Group(2)]);
    assert_eq!(template("$$1", 2), [t("$1")]);
    assert_eq!(template("$&!", 1), [Group(0), t("!")]);
    assert_eq!(template("$0", 1), [Group(0)]);
    assert_eq!(template(r"\n\t\\x\q", 1), [t("\n\t\\x\\q")]);
    assert_eq!(template("$12", 13), [Group(12)]);
    assert_eq!(template("$12", 3), [Group(1), t("2")]);
    assert_eq!(template("$9 $", 3), [t("$9 $")]);
}

#[test]
fn case_is_kept_as_vs_code_keeps_it() {
    assert_eq!(preserve_case("STEEL", "alu"), "ALU");
    assert_eq!(preserve_case("steel", "ALU"), "alu");
    assert_eq!(preserve_case("Steel", "alu"), "Alu");
    assert_eq!(preserve_case("sTEEL", "Alu"), "alu");
    assert_eq!(preserve_case("101", "abc"), "abc", "no letters to go by");
    assert_eq!(preserve_case("Part-1", "set-2"), "Set-2");
    assert_eq!(preserve_case("FOO_bar", "baz_qux"), "BAZ_qux");
    assert_eq!(
        preserve_case("Foo-Bar_x", "a-b_c"),
        "A-b_c",
        "cut by neither alike"
    );
    assert_eq!(preserve_case("ÉCOLE", "école"), "ÉCOLE");
}

#[test]
fn replacements_keep_case_in_the_file_s_encoding() {
    let text = "Steel STEEL steel 강철".as_bytes();
    let query = Query {
        needle: "steel".into(),
        ..Query::default()
    };
    let m = matcher(&query, text, 1 << 20);
    let replacement =
        Replacement::new("alu", None, true, Encoding::Utf8, |s| s.as_bytes().to_vec());
    let mut out = Vec::new();
    m.each_match(
        &text,
        true,
        &AtomicBool::new(false),
        &mut |_| {},
        &mut |hit| {
            out.push(String::from_utf8(replacement.expand(hit)).unwrap());
            ControlFlow::Continue(())
        },
    )
    .unwrap();
    assert_eq!(out, ["Alu", "ALU", "alu"]);

    let groups = regex(r"(\w+) (\d+)", true, false);
    let text = b"GRID 101\n";
    let m = matcher(&groups, text, 1 << 20);
    let replacement = Replacement::new("$2=$1", Some(m.groups()), false, Encoding::Utf8, |s| {
        s.as_bytes().to_vec()
    });
    let swapped = m
        .at(&text.as_slice(), (0, 8), |hit| replacement.expand(hit))
        .unwrap();
    assert_eq!(swapped.as_deref(), Some(b"101=GRID".as_slice()));
    assert_eq!(
        m.at(&text.as_slice(), (0, 7), |_| ()).unwrap(),
        None,
        "not a match"
    );
}
