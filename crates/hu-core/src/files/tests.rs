use std::fs;

use super::*;

fn query(needle: &str) -> Query {
    Query {
        needle: needle.into(),
        ..Query::default()
    }
}

type Found = Vec<(String, Vec<(u64, String, u32, u32)>)>;

/// The files found, inside `folder`, with each match's line, preview and place in it.
fn run(
    folder: &Path,
    query: &Query,
    include: &str,
    exclude: &str,
    open: &dyn Fn(&Path) -> Source,
) -> (Found, Searched) {
    let (include, exclude) = (Globs::new(include).unwrap(), Globs::new(exclude).unwrap());
    let search = FileSearch {
        folder,
        query,
        include: &include,
        exclude: &exclude,
        fallback: Encoding::Cp949,
    };
    let mut found = Vec::new();
    let done = search_files(
        &search,
        open,
        &AtomicBool::new(false),
        &mut |m| {
            let rel = Path::new(&m.path)
                .strip_prefix(folder)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            found.push((
                rel,
                m.hits
                    .into_iter()
                    .map(|h| (h.line, h.preview, h.from, h.to))
                    .collect(),
            ));
        },
        &mut |_| {},
    )
    .unwrap();
    (found, done)
}

fn on_disk(_: &Path) -> Source {
    Source::Disk
}

fn names(found: &Found) -> Vec<&str> {
    found.iter().map(|(name, _)| name.as_str()).collect()
}

fn deck() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let write = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    };
    write("deck.inp", b"*Node\n101, 0.\n*Element\n");
    write("sub/inc.inp", b"    GRID 101\r\n");
    write("sub/notes.txt", b"101 notes");
    write(".hidden/x.inp", b"101");
    write("bin.dat", b"101\0");
    write("results/out.INP", b"101");
    write("kor.inp", &encoding_rs::EUC_KR.encode("** 강철 101\n").0);
    dir
}

#[test]
fn a_folder_is_searched_as_the_explorer_lists_it() {
    let dir = deck();
    let (found, done) = run(dir.path(), &query("101"), "", "", &on_disk);
    // Folders first, then files, by name; nothing hidden, nothing binary.
    assert_eq!(
        names(&found),
        [
            "results/out.INP",
            "sub/inc.inp",
            "sub/notes.txt",
            "deck.inp",
            "kor.inp"
        ]
    );
    assert_eq!(
        done,
        Searched {
            files: 6,
            matches: 5,
            limited: false,
            cancelled: false
        }
    );
    let lines: Vec<_> = found.iter().map(|(_, hits)| hits[0].clone()).collect();
    assert_eq!(
        lines[1],
        (0, "GRID 101".into(), 5, 8),
        "without its indent or CR"
    );
    assert_eq!(lines[3], (1, "101, 0.".into(), 0, 3));
    assert_eq!(
        lines[4],
        (0, "** 강철 101".into(), 6, 9),
        "in its own encoding, in UTF-16 units"
    );
}

#[test]
fn globs_choose_the_files() {
    let dir = deck();
    let only = |include: &str, exclude: &str| {
        let (found, _) = run(dir.path(), &query("101"), include, exclude, &on_disk);
        names(&found)
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        only("*.inp", ""),
        ["results/out.INP", "sub/inc.inp", "deck.inp", "kor.inp"],
        "at any depth, in any case"
    );
    assert_eq!(
        only("*.inp", "results, kor*"),
        ["sub/inc.inp", "deck.inp"],
        "a folder excluded takes what is in it"
    );
    assert_eq!(only("sub/*.txt", ""), ["sub/notes.txt"]);
    assert_eq!(
        only("*.{txt,INP}", "sub"),
        ["results/out.INP", "deck.inp", "kor.inp"]
    );
    assert_eq!(only("**/inc.*", ""), ["sub/inc.inp"]);
    assert_eq!(only("[dk]*.inp", ""), ["deck.inp", "kor.inp"]);
    assert_eq!(
        only("?eck.inp, ./sub/", ""),
        ["sub/inc.inp", "sub/notes.txt", "deck.inp"]
    );
    let globs = Globs::new("*.inp").unwrap();
    assert_eq!(globs.matches("a/b.inp"), Some(true));
    assert_eq!(globs.matches("a/b.inpx"), Some(false));
    assert_eq!(
        Globs::new(" , ").unwrap().matches("x"),
        None,
        "nothing asked"
    );
}

#[test]
fn an_open_file_is_searched_as_it_is_in_the_editor() {
    let dir = deck();
    let deck = dir.path().join("deck.inp");
    let open = |path: &Path| {
        if path == deck {
            Source::Open(Box::new(b"unsaved 101\nand 101" as &[u8]), Encoding::Utf8)
        } else {
            Source::Disk
        }
    };
    let (found, _) = run(dir.path(), &query("101"), "deck.inp", "", &open);
    assert_eq!(
        found[0].1,
        [
            (0, "unsaved 101".into(), 8, 11),
            (1, "and 101".into(), 4, 7)
        ]
    );
}

#[test]
fn lines_and_previews_on_long_lines() {
    let dir = tempfile::tempdir().unwrap();
    let mut text = String::new();
    for i in 0..2000 {
        text.push_str(&format!("line {i}\n"));
    }
    text.push_str(&"x".repeat(300));
    text.push_str("é 101 and the rest\n");
    fs::write(dir.path().join("long.inp"), &text).unwrap();
    let (found, _) = run(dir.path(), &query("101"), "", "", &on_disk);
    let (line, preview, from, to) = found[0].1.last().unwrap().clone();
    assert_eq!(line, 2000);
    assert!(preview.ends_with("xé 101 and the rest"), "{preview}");
    assert_eq!(
        &preview.encode_utf16().collect::<Vec<_>>()[from as usize..to as usize],
        "101".encode_utf16().collect::<Vec<_>>()
    );
    assert!(preview.len() < 100, "only around the match");
    // A regex, its whole words, over lines counted across reads.
    let mut regex = query(r"line \d+0$");
    regex.regex = true;
    let (found, _) = run(dir.path(), &regex, "", "", &on_disk);
    assert_eq!(found[0].1.len(), 199, "10 to 1990");
    assert_eq!(found[0].1[198].0, 1990);
}

#[test]
fn a_search_stops_at_its_limit_or_when_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.inp"), "1\n".repeat(MAX_FILE_HITS + 10)).unwrap();
    fs::write(dir.path().join("b.inp"), "1\n").unwrap();
    let (found, done) = run(dir.path(), &query("1"), "", "", &on_disk);
    assert_eq!(found.len(), 1);
    assert_eq!(
        done,
        Searched {
            files: 1,
            matches: MAX_FILE_HITS as u64,
            limited: true,
            cancelled: false
        }
    );
    let (none, nothing) = (Globs::new("").unwrap(), Globs::new("").unwrap());
    let search = FileSearch {
        folder: dir.path(),
        query: &query("1"),
        include: &none,
        exclude: &nothing,
        fallback: Encoding::Utf8,
    };
    let done = search_files(
        &search,
        &on_disk,
        &AtomicBool::new(true),
        &mut |_| panic!("nothing"),
        &mut |_| {},
    )
    .unwrap();
    assert!(done.cancelled);
    // A regex past ASCII passes over a file not in UTF-8; a bad one says so.
    let dir = deck();
    let mut korean = query("강철");
    korean.regex = true;
    assert!(run(dir.path(), &korean, "", "", &on_disk).0.is_empty());
    korean.needle = "(".into();
    let bad = search_files(
        &FileSearch {
            folder: dir.path(),
            query: &korean,
            ..search
        },
        &on_disk,
        &AtomicBool::new(false),
        &mut |_| {},
        &mut |_| {},
    );
    assert!(bad.is_err());
}

#[test]
fn replacing_in_a_file_saves_it() {
    let dir = deck();
    let path = dir.path().join("sub/inc.inp");
    let count = replace_in_file(&path, &query("grid"), "node", true, Encoding::Cp949).unwrap();
    assert_eq!(count, 1);
    assert_eq!(fs::read(&path).unwrap(), b"    NODE 101\r\n");
    assert_eq!(
        replace_in_file(&path, &query("grid"), "x", false, Encoding::Cp949).unwrap(),
        0
    );
}

#[cfg(unix)]
#[test]
fn linked_folders_are_not_followed() {
    let dir = deck();
    std::os::unix::fs::symlink(dir.path(), dir.path().join("sub/loop")).unwrap();
    let (found, _) = run(dir.path(), &query("101"), "", "", &on_disk);
    assert_eq!(
        names(&found),
        [
            "results/out.INP",
            "sub/inc.inp",
            "sub/notes.txt",
            "deck.inp",
            "kor.inp"
        ]
    );
}
