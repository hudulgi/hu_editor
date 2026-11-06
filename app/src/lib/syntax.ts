// Per-line highlighting for the visible lines only. Both solver formats are line
// based, so a line can be colored without looking at its neighbours. This is
// a stopgap: highlighting that needs context (which keyword block a data
// line belongs to, Nastran section) will move into the Rust core. Source code
// and config files are in languages.ts.

import { codeBadge, codeLabel, codeLangOf, FIELD_COLORS, isCodeLang, scanLine, separatedFields, type CodeLang, type LineState } from "./languages";

export type Lang = "abaqus" | "nastran" | "plain" | CodeLang;

export interface Token {
  text: string;
  cls: string | null;
}

export const LANG_LABEL = { abaqus: "Abaqus", nastran: "Nastran" };

export const langLabel = (lang: Exclude<Lang, "plain">) => (isCodeLang(lang) ? codeLabel(lang) : LANG_LABEL[lang]);

/** The small mark of a language on tabs and in the explorer, and its CSS class. */
export function langBadge(lang: Exclude<Lang, "plain">) {
  if (isCodeLang(lang)) return { text: codeBadge(lang), cls: "code" };
  return { text: lang === "abaqus" ? "A" : "N", cls: lang };
}

const NASTRAN_EXT = ["bdf", "dat", "nas", "bulk", "fem"];
/** Used for both solvers: only a file's content can tell which one it is for. */
const EITHER_SOLVER_EXT = ["blk"];

const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

export const dependsOnContent = (name: string) => EITHER_SOLVER_EXT.includes(extOf(name));

/** The language a file name alone implies; "plain" when it depends on the content. */
export function detectLang(name: string): Lang {
  const ext = extOf(name);
  if (ext === "inp") return "abaqus";
  if (NASTRAN_EXT.includes(ext)) return "nastran";
  return codeLangOf(ext) ?? "plain";
}

/** Splits a solver deck's or plain `line` into tokens whose texts concatenate back to it. */
function tokenize(line: string, lang: "abaqus" | "nastran" | "plain"): Token[] {
  if (lang === "abaqus") return abaqus(line);
  if (lang === "nastran") return nastran(line);
  return [{ text: line, cls: null }];
}

/**
 * Tokens for consecutive lines, the first starting in `state`, and the state
 * each line starts in.
 */
export function tokenizeLines(lines: string[], lang: Lang, state: LineState = null) {
  if (!isCodeLang(lang)) return { tokens: lines.map((line) => tokenize(line, lang)), states: [] as LineState[] };
  const tokens: Token[][] = [];
  const states: LineState[] = [];
  for (const line of lines) {
    states.push(state);
    const scanned = scanLine(lang, line, state);
    tokens.push(scanned.tokens);
    state = scanned.state;
  }
  return { tokens, states };
}

// `, name=value` or `, flag` after the keyword.
const PARAM = /(,\s*)([^,=]*)(?:(=)([^,]*))?/g;

function abaqus(line: string): Token[] {
  if (line.startsWith("**")) return [{ text: line, cls: "comment" }];
  if (!line.startsWith("*")) return abaqusData(line);
  const comma = line.indexOf(",");
  if (comma < 0) return [{ text: line, cls: "keyword" }];
  const tokens: Token[] = [{ text: line.slice(0, comma), cls: "keyword" }];
  for (const m of line.slice(comma).matchAll(PARAM)) {
    tokens.push({ text: m[1], cls: "punct" }, { text: m[2], cls: "param" });
    if (m[3]) tokens.push({ text: m[3], cls: "punct" }, { text: m[4], cls: "value" });
  }
  return tokens;
}

// A data line: fields between commas, which rainbow columns color.
function abaqusData(line: string): Token[] {
  const tokens: Token[] = [];
  line.split(",").forEach((field, i) => {
    if (i > 0) tokens.push({ text: ",", cls: "punct" });
    if (field) tokens.push({ text: field, cls: `rb${i % FIELD_COLORS}` });
  });
  return tokens.length ? tokens : [{ text: line, cls: null }];
}

// Executive / case control lines: `SOL 101`, `CEND`, `SUBCASE 1`, `LOAD = 2`.
const NASTRAN_CONTROL = /^\s*(SOL|CEND|BEGIN|ENDDATA|SUBCASE|INCLUDE)\b|^\s*\w+(\([^)]*\))?\s*=/i;

function nastran(line: string): Token[] {
  if (line.startsWith("$")) return [{ text: line, cls: "comment" }];
  if (NASTRAN_CONTROL.test(line)) {
    const word = /^\s*[\w]+/.exec(line)?.[0] ?? "";
    return [
      { text: word, cls: "keyword" },
      { text: line.slice(word.length), cls: null },
    ];
  }
  if (line.includes(",")) return nastranFree(line);

  // Fixed format: an 8-column name field, then 8 data fields of 8 columns
  // (small field) or 4 of 16 (large field, `GRID*` / `*` continuation), then
  // the continuation field. Alternate shading shows the column boundaries.
  const name = line.slice(0, 8);
  const large = name.trimEnd().endsWith("*");
  const width = large ? 16 : 8;
  const fields = large ? 4 : 8;
  const tokens: Token[] = [{ text: name, cls: /^[A-Za-z]/.test(name) ? "card" : "cont" }];
  for (let i = 0, pos = 8; pos < line.length; i++, pos += width) {
    if (i === fields) {
      tokens.push({ text: line.slice(pos), cls: "cont" });
      break;
    }
    tokens.push({ text: line.slice(pos, pos + width), cls: `${i % 2 ? "fb" : "fa"} rb${(i + 1) % FIELD_COLORS}` });
  }
  return tokens;
}

function nastranFree(line: string): Token[] {
  const parts = line.split(",");
  const tokens: Token[] = [{ text: parts[0], cls: /^[A-Za-z]/.test(parts[0]) ? "card" : "cont" }];
  parts.slice(1).forEach((part, i) => {
    tokens.push({ text: ",", cls: "punct" }, { text: part, cls: `${i % 2 ? "fb" : "fa"} rb${(i + 1) % FIELD_COLORS}` });
  });
  return tokens;
}

const commasBefore = (line: string, col: number) => line.slice(0, col).split(",").length - 1;

/**
 * The field, counted from 1, that UTF-16 index `col` of `line` is in, for what
 * has fields: CSV, Abaqus data lines, Nastran cards. Null for anything else.
 */
export function fieldAt(lang: Lang, line: string, col: number): number | null {
  if (lang === "csv" || lang === "tsv") {
    const fields = separatedFields(line, lang === "csv" ? "," : "\t");
    return fields.findIndex((field) => col <= field.end) + 1 || fields.length;
  }
  if (lang === "abaqus") return line.startsWith("*") ? null : commasBefore(line, col) + 1;
  if (lang !== "nastran" || line.startsWith("$") || NASTRAN_CONTROL.test(line)) return null;
  if (line.includes(",")) return commasBefore(line, col) + 1;
  // Fixed: the name, then fields of 8 columns (16 for large field), then the continuation.
  if (col < 8) return 1;
  const large = line.slice(0, 8).trimEnd().endsWith("*");
  return large ? Math.min(6, 2 + Math.floor((col - 8) / 16)) : Math.min(10, 2 + Math.floor((col - 8) / 8));
}

/** A highlighted range of a line, in UTF-16 indices, and its class. */
export type Mark = [start: number, end: number, cls: string];

/** Splits tokens at mark boundaries and adds the classes of the marks covering each piece. */
export function applyMarks(tokens: Token[], marks: Mark[]): Token[] {
  if (!marks.length) return tokens;
  const out: Token[] = [];
  let start = 0;
  for (const token of tokens) {
    const end = start + token.text.length;
    const cuts = [start, end];
    for (const [a, b] of marks) {
      if (a > start && a < end) cuts.push(a);
      if (b > start && b < end) cuts.push(b);
    }
    cuts.sort((x, y) => x - y);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      if (a === b) continue;
      const covering = marks.filter(([ma, mb]) => ma <= a && b <= mb).map(([, , cls]) => cls);
      const cls = [token.cls, ...covering].filter(Boolean).join(" ") || null;
      out.push({ text: token.text.slice(a - start, b - start), cls });
    }
    start = end;
  }
  return out;
}

// Case folds ASCII only, like the search in the core.
const foldCase = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Whether a search for `needle` matches exactly `text`. */
export const isMatch = (text: string, needle: string, caseSensitive: boolean) =>
  caseSensitive ? text === needle : foldCase(text) === foldCase(needle);

/** Non-overlapping matches of `needle` in a line, in UTF-16 indices. */
export function findMatches(line: string, needle: string, caseSensitive: boolean): [number, number][] {
  const [hay, sought] = caseSensitive ? [line, needle] : [foldCase(line), foldCase(needle)];
  const found: [number, number][] = [];
  for (let at = hay.indexOf(sought); at >= 0; at = hay.indexOf(sought, at + sought.length)) {
    found.push([at, at + sought.length]);
  }
  return found;
}
