//! File system browsing for the explorer: the top-level locations, folder
//! listings, and the chain of folders leading to a path; and what the
//! explorer changes: new files and folders, renames, copies and moves.
//! Nothing here ever replaces what is already there.

use std::fs::{self, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::problem::Problem;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// File size in bytes; 0 for directories.
    pub size: u64,
    /// A dot file, or marked hidden by the OS.
    pub hidden: bool,
}

/// A top-level location in the explorer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub name: String,
    pub path: String,
    pub group: RootGroup,
    pub kind: RootKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootGroup {
    /// Home, Desktop, Documents, Downloads.
    Quick,
    /// Drive letters on Windows; `/` and mounted volumes elsewhere.
    Drives,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootKind {
    Home,
    Desktop,
    Documents,
    Downloads,
    Drive,
    Network,
    Removable,
}

/// Quick-access folders that exist, then drives.
pub fn roots() -> Vec<Root> {
    let quick = [
        (RootKind::Home, "Home", dirs::home_dir()),
        (RootKind::Desktop, "Desktop", dirs::desktop_dir()),
        (RootKind::Documents, "Documents", dirs::document_dir()),
        (RootKind::Downloads, "Downloads", dirs::download_dir()),
    ];
    let mut roots: Vec<Root> = quick
        .into_iter()
        .filter_map(|(kind, name, dir)| {
            let dir = dir.filter(|d| d.is_dir())?;
            Some(Root {
                name: name.into(),
                path: dir.display().to_string(),
                group: RootGroup::Quick,
                kind,
            })
        })
        .collect();
    roots.extend(drives());
    roots
}

#[cfg(windows)]
fn drives() -> Vec<Root> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;

    // Only the drive type is queried: volume labels can stall for seconds on
    // a disconnected network drive.
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| {
            let letter = char::from(b'A' + i);
            let path = format!("{letter}:\\");
            let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
            let kind = match unsafe { GetDriveTypeW(wide.as_ptr()) } {
                DRIVE_REMOTE => RootKind::Network,
                DRIVE_REMOVABLE | DRIVE_CDROM => RootKind::Removable,
                _ => RootKind::Drive,
            };
            Root {
                name: format!("{letter}:"),
                path,
                group: RootGroup::Drives,
                kind,
            }
        })
        .collect()
}

#[cfg(not(windows))]
fn drives() -> Vec<Root> {
    let mut roots = vec![Root {
        name: "/".into(),
        path: "/".into(),
        group: RootGroup::Drives,
        kind: RootKind::Drive,
    }];
    #[cfg(target_os = "macos")]
    if let Ok(volumes) = list(Path::new("/Volumes"), false) {
        // The boot volume is a link back to `/`.
        let is_boot = |path: &str| fs::canonicalize(path).is_ok_and(|p| p == Path::new("/"));
        roots.extend(
            volumes
                .into_iter()
                .filter(|v| v.is_dir && !is_boot(&v.path))
                .map(|v| Root {
                    name: v.name,
                    path: v.path,
                    group: RootGroup::Drives,
                    kind: RootKind::Removable,
                }),
        );
    }
    roots
}

/// Lists `dir` in no particular order, with hidden entries (dot files, and
/// files the OS marks hidden) if asked. Entries that cannot be read, such as
/// broken links, are skipped.
pub fn list(dir: &Path, show_hidden: bool) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        // Follow links so a linked folder expands like a folder.
        let meta = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => fs::metadata(entry.path()),
            _ => entry.metadata(),
        };
        let Ok(meta) = meta else { continue };
        let hidden = name.starts_with('.') || is_hidden(&meta);
        if hidden && !show_hidden {
            continue;
        }
        entries.push(Entry {
            name,
            path: entry.path().display().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            hidden,
        });
    }
    Ok(entries)
}

/// The folders from the root down to `path`, ending with `path` itself.
/// Empty for a relative path.
pub fn chain(path: &Path) -> Vec<String> {
    if !path.is_absolute() {
        return Vec::new();
    }
    let mut chain: Vec<String> = path.ancestors().map(|p| p.display().to_string()).collect();
    chain.reverse();
    chain
}

/// Creates an empty file; one already there is an error, never emptied.
pub fn create_file(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(exists(path));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(drop)
}

pub fn create_dir(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(exists(path));
    }
    fs::create_dir(path)
}

/// Renames `from` to `to`, never over something else already there. A
/// change of case alone is a rename too, where the file system ignores case.
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    if fs::symlink_metadata(to).is_ok() && !same_entry(from, to) {
        return Err(exists(to));
    }
    fs::rename(from, to)
}

/// Copies `from`, a file or a folder with everything in it, into the folder
/// `into`. If its name is taken there, the copy is "name copy.ext", then
/// "name copy 2.ext" and so on. Returns where the copy is.
pub fn copy_into(from: &Path, into: &Path) -> io::Result<PathBuf> {
    if is_within(into, from) {
        return Err(into_itself(from));
    }
    let to = free_name(into, from);
    copy_all(from, &to, true)?;
    Ok(to)
}

/// Moves `from` into the folder `into`, keeping its name, which must be free
/// there; to another drive, as a copy and a delete. Returns where it is.
pub fn move_into(from: &Path, into: &Path) -> io::Result<PathBuf> {
    let to = into.join(from.file_name().unwrap_or_default());
    if same_entry(from, &to) {
        return Ok(from.to_path_buf());
    }
    if is_within(into, from) {
        return Err(into_itself(from));
    }
    if fs::symlink_metadata(&to).is_ok() {
        return Err(exists(&to));
    }
    match fs::rename(from, &to) {
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            copy_all(from, &to, true)?;
            remove(from)?;
        }
        done => done?,
    }
    Ok(to)
}

/// Deletes for good, what is inside a folder too. The app moves to the
/// trash instead; this is for the tests.
pub fn remove(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// Where `path` is after `from` moved to `to`, if it was `from` or inside it.
pub fn moved(path: &Path, from: &Path, to: &Path) -> Option<PathBuf> {
    if !is_within(path, from) {
        return None;
    }
    let inside = path.components().skip(from.components().count());
    Some(inside.fold(to.to_path_buf(), |out, part| out.join(part)))
}

/// Whether `path` is `folder` or inside it.
fn is_within(path: &Path, folder: &Path) -> bool {
    let (mut path, folder) = (path.components(), folder.components());
    folder
        .filter(|part| *part != Component::CurDir)
        .all(|part| path.next().is_some_and(|other| same_name(part, other)))
}

/// Whether two paths are one entry: a link to it is not.
fn same_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
            (Ok(a), Ok(b)) => (a.dev(), a.ino()) == (b.dev(), b.ino()),
            _ => false,
        }
    }
    // Windows ignores case in names.
    #[cfg(not(unix))]
    {
        a.components().count() == b.components().count() && is_within(a, b)
    }
}

fn same_name(a: Component, b: Component) -> bool {
    if cfg!(windows) {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// `from`'s name in `into`, or the first of "name copy.ext", "name copy 2.ext", … that is free.
fn free_name(into: &Path, from: &Path) -> PathBuf {
    let name = from.file_name().unwrap_or_default();
    let taken = |path: &Path| fs::symlink_metadata(path).is_ok();
    let first = into.join(name);
    if !taken(&first) {
        return first;
    }
    // A folder's name has no extension; neither has ".profile".
    let path = Path::new(name);
    let is_dir = fs::metadata(from).is_ok_and(|m| m.is_dir());
    let (stem, ext) = match (path.file_stem(), path.extension()) {
        (Some(stem), Some(ext)) if !is_dir => (
            stem.to_string_lossy(),
            format!(".{}", ext.to_string_lossy()),
        ),
        _ => (name.to_string_lossy(), String::new()),
    };
    (1..)
        .map(|n| match n {
            1 => into.join(format!("{stem} copy{ext}")),
            n => into.join(format!("{stem} copy {n}{ext}")),
        })
        .find(|path| !taken(path))
        .expect("some name is free")
}

/// Copies a file or a whole folder. A link inside a folder is copied as a link;
/// `from` itself is followed, as the explorer lists it.
fn copy_all(from: &Path, to: &Path, follow: bool) -> io::Result<()> {
    let meta = if follow {
        fs::metadata(from)?
    } else {
        fs::symlink_metadata(from)?
    };
    if meta.is_symlink() {
        return copy_link(from, to);
    }
    if !meta.is_dir() {
        return fs::copy(from, to).map(drop);
    }
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        copy_all(&entry.path(), &to.join(entry.file_name()), false)?;
    }
    Ok(())
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}

#[cfg(windows)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    let target = fs::read_link(from)?;
    if fs::metadata(from).is_ok_and(|m| m.is_dir()) {
        std::os::windows::fs::symlink_dir(target, to)
    } else {
        std::os::windows::fs::symlink_file(target, to)
    }
}

fn exists(path: &Path) -> io::Error {
    let name = path.file_name().unwrap_or(path.as_os_str());
    Problem::Exists {
        name: name.to_string_lossy().into_owned(),
    }
    .into()
}

fn into_itself(path: &Path) -> io::Error {
    let name = path.file_name().unwrap_or(path.as_os_str());
    Problem::IntoItself {
        name: name.to_string_lossy().into_owned(),
    }
    .into()
}

#[cfg(windows)]
pub(crate) fn is_hidden(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

/// Finder hides system folders such as `/usr` and `/private` with a flag.
#[cfg(target_os = "macos")]
pub(crate) fn is_hidden(meta: &Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const UF_HIDDEN: u32 = 0x8000;
    meta.st_flags() & UF_HIDDEN != 0
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn is_hidden(_meta: &Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_files_and_folders_without_hidden_ones() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("model.inp"), b"*Heading\n").unwrap();
        fs::write(root.path().join(".DS_Store"), b"").unwrap();
        fs::create_dir(root.path().join("includes")).unwrap();

        let mut entries = list(root.path(), false).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let summary: Vec<_> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir, e.size))
            .collect();
        assert_eq!(summary, [("includes", true, 0), ("model.inp", false, 9)]);
        assert_eq!(Path::new(&entries[1].path), root.path().join("model.inp"));
        assert!(list(&root.path().join("missing"), false).is_err());

        let shown = list(root.path(), true).unwrap();
        let dot = shown.iter().find(|e| e.name == ".DS_Store").unwrap();
        assert!(dot.hidden);
        assert_eq!(shown.len(), 3);
        assert!(!shown.iter().any(|e| e.name == "model.inp" && e.hidden));
    }

    #[test]
    fn roots_include_home_and_a_drive() {
        let roots = roots();
        assert!(
            roots
                .iter()
                .any(|r| r.kind == RootKind::Home && r.group == RootGroup::Quick)
        );
        assert!(roots.iter().any(|r| r.group == RootGroup::Drives));
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = list(dir, true)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        names.sort();
        names
    }

    fn problem(error: io::Error) -> Problem {
        error
            .get_ref()
            .and_then(|e| e.downcast_ref::<Problem>())
            .cloned()
            .expect("a problem of our own")
    }

    fn exists(name: &str) -> Problem {
        Problem::Exists { name: name.into() }
    }

    #[test]
    fn new_files_and_folders_never_replace_what_is_there() {
        let root = tempfile::tempdir().unwrap();
        let deck = root.path().join("deck.inp");
        create_file(&deck).unwrap();
        assert_eq!(fs::read(&deck).unwrap(), b"");
        fs::write(&deck, b"*Heading\n").unwrap();
        assert_eq!(problem(create_file(&deck).unwrap_err()), exists("deck.inp"));
        assert_eq!(fs::read(&deck).unwrap(), b"*Heading\n", "not emptied");
        assert_eq!(problem(create_dir(&deck).unwrap_err()), exists("deck.inp"));
        create_dir(&root.path().join("mesh")).unwrap();
        assert_eq!(
            problem(create_file(&root.path().join("mesh")).unwrap_err()),
            exists("mesh")
        );
        assert_eq!(names(root.path()), ["deck.inp", "mesh"]);
    }

    #[test]
    fn renames_never_replace_but_may_change_case() {
        let root = tempfile::tempdir().unwrap();
        let (deck, other) = (root.path().join("deck.inp"), root.path().join("other.inp"));
        fs::write(&deck, b"deck").unwrap();
        fs::write(&other, b"other").unwrap();
        assert_eq!(
            problem(rename(&deck, &other).unwrap_err()),
            exists("other.inp")
        );
        assert_eq!(fs::read(&other).unwrap(), b"other");
        rename(&deck, &root.path().join("Deck.inp")).unwrap();
        assert_eq!(names(root.path()), ["Deck.inp", "other.inp"]);
        rename(&root.path().join("Deck.inp"), &root.path().join("main.inp")).unwrap();
        assert_eq!(fs::read(root.path().join("main.inp")).unwrap(), b"deck");
    }

    #[test]
    fn copies_take_a_free_name() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        fs::write(dir.join("deck.inp"), b"deck").unwrap();
        fs::write(dir.join(".profile"), b"p").unwrap();
        assert_eq!(
            copy_into(&dir.join("deck.inp"), dir).unwrap(),
            dir.join("deck copy.inp")
        );
        assert_eq!(
            copy_into(&dir.join("deck.inp"), dir).unwrap(),
            dir.join("deck copy 2.inp")
        );
        assert_eq!(
            copy_into(&dir.join(".profile"), dir).unwrap(),
            dir.join(".profile copy")
        );
        assert_eq!(fs::read(dir.join("deck copy 2.inp")).unwrap(), b"deck");

        // A folder with all in it; its name has no extension.
        let model = dir.join("model.v2");
        fs::create_dir_all(model.join("include")).unwrap();
        fs::write(model.join("include").join("mesh.inp"), b"mesh").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("include/mesh.inp", model.join("link.inp")).unwrap();
        let other = dir.join("other");
        fs::create_dir(&other).unwrap();
        assert_eq!(copy_into(&model, &other).unwrap(), other.join("model.v2"));
        assert_eq!(
            fs::read(other.join("model.v2/include/mesh.inp")).unwrap(),
            b"mesh"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::read_link(other.join("model.v2/link.inp")).unwrap(),
            Path::new("include/mesh.inp"),
            "a link stays a link"
        );
        assert_eq!(copy_into(&model, dir).unwrap(), dir.join("model.v2 copy"));

        let into_itself = |into: &Path| problem(copy_into(&model, into).unwrap_err());
        let itself = Problem::IntoItself {
            name: "model.v2".into(),
        };
        assert_eq!(into_itself(&model), itself);
        assert_eq!(into_itself(&model.join("include")), itself);
    }

    #[test]
    fn moves_keep_the_name_and_replace_nothing() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let (a, b) = (dir.join("a"), dir.join("b"));
        fs::create_dir_all(a.join("inner")).unwrap();
        fs::create_dir(&b).unwrap();
        fs::write(dir.join("deck.inp"), b"deck").unwrap();
        fs::write(b.join("deck.inp"), b"other").unwrap();

        assert_eq!(
            move_into(&dir.join("deck.inp"), dir).unwrap(),
            dir.join("deck.inp"),
            "where it is: nothing to do"
        );
        assert_eq!(
            problem(move_into(&dir.join("deck.inp"), &b).unwrap_err()),
            exists("deck.inp")
        );
        assert_eq!(fs::read(b.join("deck.inp")).unwrap(), b"other");
        assert_eq!(
            move_into(&dir.join("deck.inp"), &a).unwrap(),
            a.join("deck.inp")
        );
        assert_eq!(names(dir), ["a", "b"]);
        let itself = Problem::IntoItself { name: "a".into() };
        assert_eq!(
            problem(move_into(&a, &a.join("inner")).unwrap_err()),
            itself
        );
        assert_eq!(move_into(&a, &b).unwrap(), b.join("a"));
        assert_eq!(fs::read(b.join("a/deck.inp")).unwrap(), b"deck");

        remove(&b).unwrap();
        assert!(names(dir).is_empty());
    }

    #[test]
    fn paths_follow_a_move() {
        let (from, to) = (Path::new("/w/model"), Path::new("/x/mesh"));
        assert_eq!(
            moved(Path::new("/w/model/a/deck.inp"), from, to),
            Some(PathBuf::from("/x/mesh/a/deck.inp"))
        );
        assert_eq!(moved(from, from, to), Some(to.to_path_buf()));
        assert_eq!(
            moved(Path::new("/w/model2/deck.inp"), from, to),
            None,
            "a name that only starts the same"
        );
        assert_eq!(moved(Path::new("/w"), from, to), None);
    }

    #[cfg(unix)]
    #[test]
    fn chain_runs_from_the_root() {
        assert_eq!(
            chain(Path::new("/a/b/deck.inp")),
            ["/", "/a", "/a/b", "/a/b/deck.inp"]
        );
        assert!(chain(Path::new("deck.inp")).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn chain_runs_from_the_drive() {
        assert_eq!(
            chain(Path::new(r"C:\a\deck.inp")),
            [r"C:\", r"C:\a", r"C:\a\deck.inp"]
        );
    }
}
