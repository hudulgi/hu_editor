// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Offsets are byte offsets; plain JS numbers are exact up to 9 PB.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface DocState {
  len: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface DocInfo {
  id: number;
  /** Null for a new document that has no file yet. */
  path: string | null;
  name: string;
  encoding: "utf8" | "cp949";
  eol: "lf" | "crlf";
  state: DocState;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** Not in the listing (hidden), shown because a revealed path runs through it. */
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
export const listDir = (path: string) => invoke<DirEntry[]>("list_dir", { path });
/** Folders from the root down to `path`, ending with `path`; empty for a relative path. */
export const pathChain = (path: string) => invoke<string[]>("path_chain", { path });
export const pathKind = (path: string) => invoke<"file" | "dir" | null>("path_kind", { path });
export const openDocument = (path: string) => invoke<DocInfo>("open_document", { path });
/** A new, empty document without a file (its name is up to the caller). */
export const newDocument = () => invoke<DocInfo>("new_document");
export const closeDocument = (id: number) => invoke<void>("close_document", { id });
export const indexStatus = (id: number) => invoke<IndexStatus>("index_status", { id });
export const diskChanged = (id: number) => invoke<boolean>("disk_changed", { id });
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

export function replaceAll(
  id: number,
  needle: string,
  replacement: string,
  caseSensitive: boolean,
  anchor: number,
  caret: number,
  onProgress: (searched: number) => void,
) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<ReplaceOutcome>("replace_all", {
    id,
    needle,
    replacement,
    caseSensitive,
    anchor,
    caret,
    onProgress: channel,
  });
}

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

export function save(id: number, onProgress: (written: number) => void) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<DocState>("save", { id, onProgress: channel });
}

export function find(
  id: number,
  needle: string,
  from: number,
  caseSensitive: boolean,
  backward: boolean,
  onProgress: (searched: number) => void,
) {
  const channel = new Channel<number>();
  channel.onmessage = onProgress;
  return invoke<FindOutcome>("find", {
    id,
    needle,
    from,
    caseSensitive,
    backward,
    onProgress: channel,
  });
}
