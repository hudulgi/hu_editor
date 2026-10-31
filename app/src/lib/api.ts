// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Offsets are byte offsets; plain JS numbers are exact up to 9 PB.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface DocInfo {
  id: number;
  path: string;
  name: string;
  len: number;
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
  text: string;
  truncated: boolean;
  /** Highlighted ranges as indices into `text`. */
  marks: [number, number][];
}

export interface View {
  top: number;
  maxTop: number;
  end: number;
  /** 0-based line number of `top`, once the line index has reached it. */
  firstLine: number | null;
  lines: ViewLine[];
}

export type ViewTarget =
  | { kind: "scroll"; anchor: number; delta: number }
  | { kind: "fraction"; fraction: number }
  | { kind: "line"; line: number }
  | { kind: "offset"; offset: number; context: number };

export interface Mark {
  offset: number;
  len: number;
}

export type FindOutcome =
  | { kind: "found"; offset: number; len: number }
  | { kind: "notFound" }
  | { kind: "cancelled" };

export const launchPath = () => invoke<string | null>("launch_path");
export const openDocument = (path: string) => invoke<DocInfo>("open_document", { path });
export const closeDocument = (id: number) => invoke<void>("close_document", { id });
export const indexStatus = (id: number) => invoke<IndexStatus>("index_status", { id });
export const diskChanged = (id: number) => invoke<boolean>("disk_changed", { id });
export const cancelFind = (id: number) => invoke<void>("cancel_find", { id });

export const view = (id: number, target: ViewTarget, rows: number, marks: Mark[]) =>
  invoke<View>("view", { id, target, rows, marks });

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
