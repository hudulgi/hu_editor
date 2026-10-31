//! File system browsing for the explorer: the top-level locations, folder
//! listings, and the chain of folders leading to a path.

use std::fs::{self, Metadata};
use std::io;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// File size in bytes; 0 for directories.
    pub size: u64,
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
    if let Ok(volumes) = list(Path::new("/Volumes")) {
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

/// Lists `dir` in no particular order, leaving out hidden entries (dot
/// files, and files the OS marks hidden). Entries that cannot be read, such
/// as broken links, are skipped.
pub fn list(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // Follow links so a linked folder expands like a folder.
        let meta = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => fs::metadata(entry.path()),
            _ => entry.metadata(),
        };
        let Ok(meta) = meta else { continue };
        if is_hidden(&meta) {
            continue;
        }
        entries.push(Entry {
            name,
            path: entry.path().display().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
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

#[cfg(windows)]
fn is_hidden(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

/// Finder hides system folders such as `/usr` and `/private` with a flag.
#[cfg(target_os = "macos")]
fn is_hidden(meta: &Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const UF_HIDDEN: u32 = 0x8000;
    meta.st_flags() & UF_HIDDEN != 0
}

#[cfg(not(any(windows, target_os = "macos")))]
fn is_hidden(_meta: &Metadata) -> bool {
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

        let mut entries = list(root.path()).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let summary: Vec<_> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir, e.size))
            .collect();
        assert_eq!(summary, [("includes", true, 0), ("model.inp", false, 9)]);
        assert_eq!(Path::new(&entries[1].path), root.path().join("model.inp"));
        assert!(list(&root.path().join("missing")).is_err());
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
