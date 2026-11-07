// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Offsets are byte offsets; plain JS numbers are exact up to 9 PB.

import { Channel, invoke } from "@tauri-apps/api/core";

export type Encoding = "utf8" | "cp949" | "shiftJis" | "gbk" | "big5" | "windows1252";

export interface DocState {
  len: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Bumped by every change to the text. */
  version: number;
}

export interface DocInfo {
  id: number;
  /** Null for a new document that has no file yet. */
  path: string | null;
  name: string;
  encoding: Encoding;
  eol: "lf" | "crlf";
  state: DocState;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** A dot file or marked hidden by the OS, listed on request or because a revealed path runs through it. */
  hidden?: boolean;
}

export interface Root {
  name: string;
  path: string;
  group: "quick" | "drives";
  kind: "home" | "desktop" | "documents" | "downloads" | "drive" | "network" | "removable";
}

export interface IndexStatus {
  scanned: number;
  len: number;
  /** Lines known so far; the final count once `complete`. */
  lines: number;
  complete: boolean;
  error: string | null;
}

export interface ViewLine {
  offset: number;
  /** Bytes of content, without the line terminator. */
  len: number;
  text: string;
  /** Byte offset in the line of each UTF-16 unit of `text`, plus `len`; null for ASCII. */
  charStarts: number[] | null;
  truncated: boolean;
}

export interface View {
  top: number;
  maxTop: number;
  end: number;
  /** Document length. */
  len: number;
  /** 0-based line number of `top`, once the line index has reached it. */
  firstLine: number | null;
  lines: ViewLine[];
}

export type ViewTarget =
  | { kind: "scroll"; anchor: number; delta: number }
  | { kind: "fraction"; fraction: number }
  | { kind: "line"; line: number }
  | { kind: "offset"; offset: number; context: number };

/** `[start, start + oldLen)` became `[start, start + newLen)`. */
export interface Change {
  start: number;
  oldLen: number;
  newLen: number;
}

export interface EditResult {
  change: Change;
  /** Selection afterwards. */
  anchor: number;
  caret: number;
  state: DocState;
}

/** Consecutive typing, backspacing or deleting undoes as one step. */
export type EditKind = "typing" | "backspace" | "delete" | "other";

/** Lines of a box selection, from its top line. */
export type BoxRows = { kind: "until"; bottom: number } | { kind: "count"; count: number };

export interface BoxEdit {
  result: EditResult;
  /** Where the box's last line starts after the edit. */
  lastLine: number;
}

export type ReplaceOutcome =
  | { kind: "replaced"; count: number; result: EditResult | null }
  | { kind: "cancelled" };

export type FindOutcome =
  | { kind: "found"; offset: number; len: number }
  | { kind: "notFound" }
  | { kind: "cancelled" };

export const launchPath = () => invoke<string | null>("launch_path");
export const roots = () => invoke<Root[]>("roots");
export const listDir = (path: string, showHidden: boolean) => invoke<DirEntry[]>("list_dir", { path, showHidden });
/** Folders from the root down to `path`, ending with `path`; empty for a relative path. */
export const pathChain = (path: string) => invoke<string[]>("path_chain", { path });
export const pathKind = (path: string) => invoke<"file" | "dir" | null>("path_kind", { path });
/** Opens `path` to read in `encoding`; without one, in the one detected, with `fallback` for what is not UTF-8. */
export const openDocument = (path: string, encoding: Encoding | null, fallback: Encoding) =>
  invoke<DocInfo>("open_document", { path, encoding, fallback });
/** Reads the same bytes in `encoding`, or back in the one detected; returns the encoding in use. */
export const setEncoding = (id: number, encoding: Encoding | null, fallback: Encoding) =>
  invoke<Encoding>("set_encoding", { id, encoding, fallback });
/** The settings file's text; null before the first change. */
export const loadSettings = () => invoke<string | null>("load_settings");
export const saveSettings = (text: string) => invoke<void>("save_settings", { text });
/** A new, empty document without a file (its name is up to the caller); no `eol` means the platform's. */
export const newDocument = (encoding: Encoding, eol: "crlf" | "lf" | null) =>
  invoke<DocInfo>("new_document", { encoding, eol });
/** One window lets go of a document; it closes with the last. */
export const closeDocument = (id: number) => invoke<void>("close_document", { id });
/** Another window is going to show the document. */
export const retainDocument = (id: number) => invoke<void>("retain_document", { id });
export const documentWindows = (id: number) => invoke<number>("document_windows", { id });
/** Opens another window, which gets `start` from `windowStart`. */
export const openWindow = (start: unknown) => invoke<void>("open_window", { start });
/** What this window was opened to show; null for the first window. */
export const windowStart = <T>() => invoke<T | null>("window_start");
export const indexStatus = (id: number) => invoke<IndexStatus>("index_status", { id });
export const diskChanged = (id: number) => invoke<boolean>("disk_changed", { id });
/** Which solver the document's content looks written for, if it says. */
export const detectDialect = (id: number) => invoke<"abaqus" | "nastran" | null>("detect_dialect", { id });
/** Stops the running search, replace or count. */
export const cancelFind = (id: number) => invoke<void>("cancel_find", { id });

export const view = (id: number, target: ViewTarget, rows: number) =>
  invoke<View>("view", { id, target, rows });

export const edit = (
  id: number,
  start: number,
  end: number,
  text: string,
  kind: EditKind,
  anchor: number,
  caret: number,
) => invoke<EditResult>("edit", { id, start, end, text, kind, anchor, caret });

export const undo = (id: number) => invoke<EditResult | null>("undo", { id });
export const redo = (id: number) => invoke<EditResult | null>("redo", { id });
/** Puts `[start, end)` on the clipboard. */
export const copy = (id: number, start: number, end: number) => invoke<void>("copy", { id, start, end });
/** The text on the clipboard, for the Paste menu item; Ctrl+V brings its own. */
export const readClipboard = () => invoke<string>("read_clipboard");

export const writeClipboard = (text: string) => invoke<void>("write_clipboard", { text });

// ---- The explorer's changes: nothing already there is ever replaced ----------

/** An open document whose file was renamed or moved; it saves there now. */
export interface MovedDoc {
  id: number;
  path: string;
  name: string;
}

/** What a paste did, up to where it may have stopped. */
export interface Pasted {
  /** Where each pasted file or folder is now. */
  to: string[];
  /** Open documents that moved with them. */
  docs: MovedDoc[];
  error: string | null;
}

export const createFile = (path: string) => invoke<void>("create_file", { path });
export const createDir = (path: string) => invoke<void>("create_dir", { path });
export const renamePath = (from: string, to: string) => invoke<MovedDoc[]>("rename_path", { from, to });
/** Copies, or with `cut` moves, into the folder `into`; a copy takes a free name. */
export const paste = (paths: string[], into: string, cut: boolean) => invoke<Pasted>("paste", { paths, into, cut });
/** To the Recycle Bin (the Trash). */
export const deletePath = (path: string) => invoke<void>("delete_path", { path });
/** Shows it selected in File Explorer (the Finder). */
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const openTerminal = (dir: string) => invoke<void>("open_terminal", { dir });

/** Replaces display columns `[left, right)` of the box's lines with `texts` (one for all, or one per line). */
export const editBox = (
  id: number,
  top: number,
  rows: BoxRows,
  left: number,
  right: number,
  texts: string[],
  kind: EditKind,
  anchor: number,
  caret: number,
) => invoke<BoxEdit | null>("edit_box", { id, top, rows, left, right, texts, kind, anchor, caret });

export const copyBox = (id: number, top: number, bottom: number, left: number, right: number) =>
  invoke<void>("copy_box", { id, top, bottom, left, right });

/** What counts as a match. */
export interface Matching {
  caseSensitive: boolean;
  /** Not where the needle goes on into a longer word or number. */
  wholeWord: boolean;
}

/** What the find bar asks for. */
export interface Query extends Matching {
  needle: string;
  /** The needle is a regular expression, matched within a line. */
  regex: boolean;
  /** Find in Selection: only matches inside `[start, end)`. */
  scope: [number, number] | null;
}

export interface MatchCount {
  total: number;
  /** From 1; null if the selection is not one of them. */
  index: number | null;
}

export function replaceAll(
  id: number,
  query: Query,
  replacement: string,
  preserveCase: boolean,
  anchor: number,
  caret: number,
  onProgress: (searched: number) => void,
) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<ReplaceOutcome>("replace_all", {
    id,
    query,
    replacement,
    preserveCase,
    anchor,
    caret,
    onProgress: channel,
  });
}

/** How many matches there are and which one is selected; null if stopped by a newer count. */
export function countMatches(id: number, query: Query, anchor: number, caret: number, onProgress: (read: number) => void) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<MatchCount | null>("count_matches", { id, query, anchor, caret, onProgress: channel });
}

/** Where the matches starting in `[from, to)` are, to mark them on screen. */
export const matchesIn = (id: number, query: Query, from: number, to: number) =>
  invoke<[number, number][]>("matches_in", { id, query, from, to });

/** What the selection would be replaced with, if it is a match. */
export const replacementFor = (
  id: number,
  query: Query,
  replacement: string,
  preserveCase: boolean,
  anchor: number,
  caret: number,
) => invoke<string | null>("replacement_for", { id, query, replacement, preserveCase, anchor, caret });

export interface SavedAs {
  path: string;
  name: string;
  state: DocState;
}

/** Saves to `path`, where the document saves from now on. */
export function saveAs(id: number, path: string, onProgress: (written: number) => void) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<SavedAs>("save_as", { id, path, onProgress: channel });
}

/** Writes the text to `path` converted to `encoding`; open it again to go on. */
export function saveConverted(id: number, path: string, encoding: Encoding, onProgress: (read: number) => void) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<void>("save_converted", { id, path, encoding, onProgress: channel });
}

export function save(id: number, onProgress: (written: number) => void) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<DocState>("save", { id, onProgress: channel });
}

/** The next match after the selection, or the one before it `backward`, going round the end. */
export function find(
  id: number,
  query: Query,
  anchor: number,
  caret: number,
  backward: boolean,
  onProgress: (searched: number) => void,
) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<FindOutcome>("find", { id, query, anchor, caret, backward, onProgress: channel });
}

/** Toggle Line Comment with `marker`; `atStart` at each line's start, as a deck wants it. */
export const toggleLineComment = (id: number, marker: string, atStart: boolean, anchor: number, caret: number) =>
  invoke<EditResult | null>("toggle_line_comment", { id, marker, atStart, anchor, caret });

/** Toggle Block Comment between `open` and `close`. */
export const toggleBlockComment = (id: number, open: string, close: string, anchor: number, caret: number) =>
  invoke<EditResult | null>("toggle_block_comment", { id, open, close, anchor, caret });

// ---- Find in Files ------------------------------------------------------------

/** A match, with its line for the list. */
export interface FileHit {
  /** From 0. */
  line: number;
  /** In bytes, in the file (in the document, for one open). */
  start: number;
  end: number;
  /** The line, or around the match on a long one, without the indent. */
  preview: string;
  /** The match in the preview. */
  from: number;
  to: number;
  /** The preview leaves out the start of the line. */
  cut: boolean;
}

export interface FileMatches {
  path: string;
  hits: FileHit[];
}

export interface Searched {
  files: number;
  matches: number;
  /** It stopped at the most it shows. */
  limited: boolean;
  cancelled: boolean;
}

/** Searches the files under `folder`, each file's matches coming to `onFound` as they are found. */
export function searchFiles(
  folder: string,
  query: Query,
  include: string,
  exclude: string,
  fallback: Encoding,
  onFound: (found: FileMatches) => void,
  onProgress: (files: number) => void,
) {
  const found = new Channel<FileMatches>();
  found.onmessage = onFound;
  const progress = new Channel<number>();
  progress.onmessage = onProgress;
  return invoke<Searched>("search_files", { folder, query, include, exclude, fallback, onFound: found, onProgress: progress });
}

export const cancelSearchFiles = () => invoke<void>("cancel_search_files");

/** What Replace in Files did to one file. */
export interface FileReplaced {
  path: string;
  count: number;
  error: string | null;
  /** A file open in the editor is replaced there, unsaved, with this change. */
  doc: number | null;
  result: EditResult | null;
}

export const replaceInFiles = (paths: string[], query: Query, replacement: string, preserveCase: boolean, fallback: Encoding) =>
  invoke<FileReplaced[]>("replace_in_files", { paths, query, replacement, preserveCase, fallback });
