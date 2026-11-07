//! Find in Files: a folder searched file by file, as VS Code's search view
//! does it, for an editor without workspaces. A file open in the editor is
//! searched as it is there, unsaved changes included.

use std::fs;
use std::io;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use regex_automata::meta::Regex;
use serde::Serialize;

use crate::decode::Encoding;
use crate::problem::Problem;
use crate::query::{Matcher, Query};
use crate::search::Reader;
use crate::source::FileSource;

/// The search stops at this many matches, as VS Code's does.
pub const MAX_FILE_HITS: usize = 20_000;
/// A file whose start has a NUL byte is taken for binary and passed over.
const SNIFF: usize = 8 << 10;
/// Preview text before a match on a long line, and after it.
const BEFORE: u64 = 40;
const AFTER: u64 = 200;
/// Read at a time to count lines.
const CHUNK: usize = 1 << 20;

/// A match, with its line for the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// From 0.
    pub line: u64,
    /// Where it is in the file (the document, for one open), in bytes.
    pub start: u64,
    pub end: u64,
    /// The line, or around the match on a long one, without the indent.
    pub preview: String,
    /// The match in the preview, in UTF-16 units.
    pub from: u32,
    pub to: u32,
    /// The preview leaves out the start of the line.
    pub cut: bool,
}

/// The matches in one file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub hits: Vec<FileHit>,
}

/// How a search went.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Searched {
    pub files: u64,
    pub matches: u64,
    /// It stopped at [`MAX_FILE_HITS`].
    pub limited: bool,
    pub cancelled: bool,
}

/// Which files a search reads: a list of globs separated by commas, as VS
/// Code takes them. One without a `/` matches a name at any depth; a folder
/// matched takes in all that is in it. Case does not matter.
pub struct Globs(Option<Regex>);

impl Globs {
    pub fn new(list: &str) -> Result<Self, Problem> {
        let patterns: Vec<String> = split_globs(list)
            .into_iter()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(glob_regex)
            .collect();
        if patterns.is_empty() {
            return Ok(Self(None));
        }
        let re = regex_automata::meta::Builder::new()
            .syntax(regex_automata::util::syntax::Config::new().case_insensitive(true))
            .build(&format!("^(?:{})$", patterns.join("|")))
            .map_err(|_| Problem::BadGlob {
                glob: list.trim().into(),
            })?;
        Ok(Self(Some(re)))
    }

    /// Whether `rel`, a path inside the folder with `/` between its parts, is matched.
    pub fn matches(&self, rel: &str) -> Option<bool> {
        self.0.as_ref().map(|re| re.is_match(rel))
    }
}

/// The globs of a list, cut at the commas that are not between braces.
fn split_globs(list: &str) -> Vec<&str> {
    let (mut parts, mut depth, mut from) = (Vec::new(), 0u32, 0);
    for (i, c) in list.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(&list[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&list[from..]);
    parts
}

/// A glob as a regular expression over a relative path.
fn glob_regex(glob: &str) -> String {
    let glob = glob.trim_start_matches("./").replace('\\', "/");
    let anywhere = !glob.trim_end_matches('/').contains('/');
    let glob = glob.trim_end_matches('/');
    let mut out = String::from(if anywhere { "(?:.*/)?" } else { "" });
    let mut chars = glob.chars().peekable();
    let mut braces = 0;
    while let Some(c) = chars.next() {
        match c {
            '*' if chars.peek() == Some(&'*') => {
                chars.next();
                if chars.peek() == Some(&'/') {
                    chars.next();
                    out.push_str("(?:.*/)?");
                } else {
                    out.push_str(".*");
                }
            }
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            '{' => {
                braces += 1;
                out.push_str("(?:");
            }
            '}' if braces > 0 => {
                braces -= 1;
                out.push(')');
            }
            ',' if braces > 0 => out.push('|'),
            '[' => {
                out.push('[');
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                    if c == '\\' || c == '[' {
                        out.push('\\');
                    }
                    out.push(if c == '!' { '^' } else { c });
                }
                out.push(']');
            }
            c => out.push_str(&regex_syntax::escape(&c.to_string())),
        }
    }
    out.push_str(&")".repeat(braces));
    // A folder takes in what is in it.
    out.push_str("(?:/.*)?");
    out
}

/// What a search is for.
pub struct FileSearch<'a> {
    pub folder: &'a Path,
    pub query: &'a Query,
    pub include: &'a Globs,
    pub exclude: &'a Globs,
    /// For files that are not valid UTF-8.
    pub fallback: Encoding,
}

/// A file to read: open in the editor, as it is there, or on disk.
pub enum Source {
    Open(Box<dyn Reader + Send>, Encoding),
    Disk,
}

/// Searches the files in `search.folder` and below, in the order the
/// explorer shows them, giving each file's matches to `found` as they come.
/// `open` says whether a file is open in the editor; `progress` gets the
/// number of files searched. Hidden files and folders, linked folders and
/// binary files are passed over.
pub fn search_files(
    search: &FileSearch,
    open: &dyn Fn(&Path) -> Source,
    cancel: &AtomicBool,
    found: &mut dyn FnMut(FileMatches),
    progress: &mut dyn FnMut(u64),
) -> io::Result<Searched> {
    let mut done = Searched::default();
    if search.query.needle.is_empty() {
        return Ok(done);
    }
    // A bad pattern is said once, not for every file.
    Matcher::new(search.query, Encoding::Utf8, 0)?;
    let mut walk = |path: &Path, rel: &str| -> io::Result<ControlFlow<()>> {
        if cancel.load(Ordering::Relaxed) {
            done.cancelled = true;
            return Ok(ControlFlow::Break(()));
        }
        if search.include.matches(rel) == Some(false) {
            return Ok(ControlFlow::Continue(()));
        }
        let budget = MAX_FILE_HITS - done.matches as usize;
        let hits = match open(path) {
            Source::Open(reader, encoding) => {
                search_one(&*reader, encoding, search.query, budget, cancel)?
            }
            Source::Disk => {
                let Ok(file) = FileSource::open(path) else {
                    return Ok(ControlFlow::Continue(()));
                };
                if is_binary(&file)? {
                    None
                } else {
                    let encoding = detect(&file, search.fallback)?;
                    search_one(&file, encoding, search.query, budget, cancel)?
                }
            }
        };
        done.files += 1;
        progress(done.files);
        if let Some(hits) = hits.filter(|h| !h.is_empty()) {
            done.matches += hits.len() as u64;
            found(FileMatches {
                path: path.display().to_string(),
                hits,
            });
            if done.matches as usize >= MAX_FILE_HITS {
                done.limited = true;
                return Ok(ControlFlow::Break(()));
            }
        }
        Ok(ControlFlow::Continue(()))
    };
    // Stopped or not, what was found is given already.
    let _ = walk_dir(search.folder, "", search.exclude, &mut walk)?;
    if cancel.load(Ordering::Relaxed) {
        done.cancelled = true;
    }
    Ok(done)
}

/// Goes through the files under `dir`, folders first and by name, as the
/// explorer lists them; `rel` is `dir` inside the folder searched.
fn walk_dir(
    dir: &Path,
    rel: &str,
    exclude: &Globs,
    visit: &mut dyn FnMut(&Path, &str) -> io::Result<ControlFlow<()>>,
) -> io::Result<ControlFlow<()>> {
    let Ok(read) = fs::read_dir(dir) else {
        return Ok(ControlFlow::Continue(()));
    };
    let mut entries: Vec<(bool, String, PathBuf)> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        // Linked folders could lead round in circles.
        if kind.is_symlink() && fs::metadata(entry.path()).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if name.starts_with('.') || crate::dir::is_hidden(&meta) {
            continue;
        }
        let is_dir = kind.is_dir();
        entries.push((is_dir, name, entry.path()));
    }
    entries.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });
    for (is_dir, name, path) in entries {
        let rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if exclude.matches(&rel) == Some(true) {
            continue;
        }
        let next = if is_dir {
            walk_dir(&path, &rel, exclude, visit)?
        } else {
            visit(&path, &rel)?
        };
        if next.is_break() {
            return Ok(next);
        }
    }
    Ok(ControlFlow::Continue(()))
}

impl Reader for FileSource {
    fn len(&self) -> u64 {
        FileSource::len(self)
    }

    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        self.read_uncached(offset, buf)
    }
}

fn problem_of(error: &io::Error) -> Option<&Problem> {
    error.get_ref().and_then(|e| e.downcast_ref::<Problem>())
}

fn is_binary(file: &FileSource) -> io::Result<bool> {
    let mut start = vec![0; SNIFF.min(file.len() as usize)];
    file.read_uncached(0, &mut start)?;
    Ok(memchr::memchr(0, &start).is_some())
}

fn detect(file: &FileSource, fallback: Encoding) -> io::Result<Encoding> {
    let mut sample = vec![0; (1 << 20).min(file.len() as usize)];
    file.read_uncached(0, &mut sample)?;
    Ok(Encoding::detect(&sample, fallback))
}

/// The matches in one text, no more than `budget`; `None` if cancelled.
fn search_one(
    source: &dyn Reader,
    encoding: Encoding,
    query: &Query,
    budget: usize,
    cancel: &AtomicBool,
) -> io::Result<Option<Vec<FileHit>>> {
    let matcher = match Matcher::new(query, encoding, source.len()) {
        Ok(Some(matcher)) => matcher,
        Ok(None) => return Ok(Some(Vec::new())),
        // A regex past ASCII cannot read a file in another encoding: it is passed over.
        Err(e) if problem_of(&e) == Some(&Problem::RegexNotAscii) => return Ok(Some(Vec::new())),
        Err(e) => return Err(e),
    };
    let mut lines = Lines::new(source);
    let mut hits = Vec::new();
    let mut failed = None;
    let finished = matcher.each_match(source, false, cancel, &mut |_| {}, &mut |hit| {
        match lines.hit(hit.start, hit.end, encoding) {
            Ok(found) => hits.push(found),
            Err(e) => {
                failed = Some(e);
                return ControlFlow::Break(());
            }
        }
        if hits.len() >= budget {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    if let Some(e) = failed {
        return Err(e);
    }
    Ok(finished.then_some(hits))
}

/// Counts lines up to each match, reading the text once.
struct Lines<'a> {
    source: &'a dyn Reader,
    /// Counted up to here.
    pos: u64,
    line: u64,
    line_start: u64,
    buf: Vec<u8>,
}

impl<'a> Lines<'a> {
    fn new(source: &'a dyn Reader) -> Self {
        Self {
            source,
            pos: 0,
            line: 0,
            line_start: 0,
            buf: Vec::new(),
        }
    }

    fn hit(&mut self, start: u64, end: u64, encoding: Encoding) -> io::Result<FileHit> {
        while self.pos < start {
            let n = (start - self.pos).min(CHUNK as u64) as usize;
            self.buf.resize(n, 0);
            self.source.read_at(self.pos, &mut self.buf)?;
            for i in memchr::memchr_iter(b'\n', &self.buf) {
                self.line += 1;
                self.line_start = self.pos + i as u64 + 1;
            }
            self.pos += n as u64;
        }
        // The rest of the line, as much as is shown.
        let len = self.source.len();
        let limit = (end + AFTER).min(len);
        self.buf.resize((limit - start) as usize, 0);
        self.source.read_at(start, &mut self.buf)?;
        let line_end = memchr::memchr(b'\n', &self.buf).map_or(limit, |i| start + i as u64);
        let line_end = line_end.max(end);
        let cut = start - self.line_start > BEFORE * 3;
        let mut from = if cut { start - BEFORE } else { self.line_start };
        if cut && encoding == Encoding::Utf8 {
            // At a character's first byte.
            let mut b = [0];
            while from < start {
                self.source.read_at(from, &mut b)?;
                if b[0] & 0xc0 != 0x80 {
                    break;
                }
                from += 1;
            }
        }
        let read = |a: u64, b: u64| -> io::Result<String> {
            let mut bytes = vec![0; (b - a) as usize];
            self.source.read_at(a, &mut bytes)?;
            Ok(encoding.decode(&bytes).into_owned())
        };
        let before = read(from, start)?;
        let matched = read(start, end.min(line_end))?;
        let after = read(end.min(line_end), line_end)?;
        let after = after.trim_end_matches('\r');
        let indent = before.len() - before.trim_start().len();
        let before = &before[indent..];
        let units = |s: &str| s.encode_utf16().count() as u32;
        Ok(FileHit {
            line: self.line,
            start,
            end,
            preview: format!("{before}{matched}{after}"),
            from: units(before),
            to: units(before) + units(&matched),
            cut,
        })
    }
}

/// Replace in Files, for a file not open in the editor: its matches are
/// replaced and it is saved. Returns how many were replaced.
pub fn replace_in_file(
    path: &Path,
    query: &Query,
    replacement: &str,
    preserve_case: bool,
    fallback: Encoding,
) -> io::Result<usize> {
    let doc = crate::Document::open_as(path, None, fallback)?;
    let never = AtomicBool::new(false);
    let replaced = doc.replace_all(
        query,
        replacement,
        preserve_case,
        (0, 0),
        &never,
        &mut |_| {},
    )?;
    let count = replaced.map_or(0, |(count, _)| count);
    if count > 0 {
        doc.save(&never, &mut |_| {})?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests;
