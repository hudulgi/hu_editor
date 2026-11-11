// What windows tell each other: about the documents several of them show (the
// backend holds each document once, until the last window lets go of it), and
// Exit, which closes them all.

import type * as api from "./api";
import type { Lang } from "./syntax";

/** A document just opened, ready for a tab. */
export interface Loaded {
  doc: api.DocInfo;
  lang: Lang;
  chosenEncoding: boolean;
}

export type DocNews =
  | { kind: "edited"; id: number; change: api.Change; state: api.DocState }
  | { kind: "saved"; id: number; state: api.DocState; path: string | null; name: string; lang: Lang }
  | { kind: "encoding"; id: number; encoding: api.Encoding; chosen: boolean }
  | { kind: "replaced"; id: number; loaded: Loaded; goto: number | null }
  | { kind: "moved"; id: number; path: string; name: string; lang: Lang };

export const DOC_NEWS = "hu://doc";
/** Exit: every window closes, each asking about its own unsaved changes. */
export const QUIT = "hu://quit";

/** One side of a compare window as the window opening it gives it: a document open there, or a file to open. */
export interface CompareSide {
  path: string;
  loaded: Loaded | null;
}

/** What a compare window shows. */
export interface CompareStart {
  left: CompareSide;
  right: CompareSide;
}
