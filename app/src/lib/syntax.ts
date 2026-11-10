// Per-line highlighting for the visible lines only. Both solver formats are line
// based, so a line can be colored without looking at its neighbours. This is
// a stopgap: highlighting that needs context (which keyword block a data
// line belongs to, Nastran section) will move into the Rust core. Source code
// and config files are in languages.ts.

import type { Matching } from "./api";
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

export const ABAQUS_EXT = ["inp"];
export const NASTRAN_EXT = ["bdf", "dat", "nas", "bulk", "fem"];
/** Used for both solvers: only a file's content can tell which one it is for. */
export const EITHER_SOLVER_EXT = ["blk"];

const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

export const dependsOnContent = (name: string) => EITHER_SOLVER_EXT.includes(extOf(name));

/** The language a file name alone implies; "plain" when it depends on the content. */
export function detectLang(name: string): Lang {
  const ext = extOf(name);
  if (ABAQUS_EXT.includes(ext)) return "abaqus";
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

/**
 * The field column `col` is in, as `fieldAt` counts them, without the spaces
 * around it: for Expand Selection. Null where a line has no fields, or the
 * field is empty.
 */
export function fieldRange(lang: Lang, line: string, col: number): [number, number] | null {
  const commas = (): [number, number] => {
    const end = line.indexOf(",", col);
    return [line.lastIndexOf(",", col - 1) + 1, end < 0 ? line.length : end];
  };
  let range: [number, number];
  if (lang === "csv" || lang === "tsv") {
    const fields = separatedFields(line, lang === "csv" ? "," : "\t");
    const field = fields.find((f) => col <= f.end) ?? fields[fields.length - 1];
    range = [field.start, field.end];
  } else if (lang === "abaqus") range = commas();
  else if (lang !== "nastran" || line.startsWith("$") || NASTRAN_CONTROL.test(line)) return null;
  else if (line.includes(",")) range = commas();
  else if (col < 8) range = [0, 8];
  else {
    const width = line.slice(0, 8).trimEnd().endsWith("*") ? 16 : 8;
    const start = 8 + Math.floor((col - 8) / width) * width;
    range = [start, start + width];
  }
  let [a, b] = [range[0], Math.min(range[1], line.length)];
  while (a < b && /\s/.test(line[a])) a++;
  while (b > a && /\s/.test(line[b - 1])) b--;
  return a < b ? [a, b] : null;
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

// Like the core, which sees bytes: every character past ASCII is a word character.
const isWordChar = (c: string | undefined) => c !== undefined && (/[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) >= 0x80);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/**
 * Whether the `edge` character of a match goes on into `next`, beside it,
 * with `beyond` after that. A point next to a digit is a decimal point, part
 * of the number, unless a name is on its other side (`Part-1-1.Set-1`).
 */
function joins(edge: string, next: string | undefined, beyond: string | undefined) {
  if (next === "." && isDigit(edge)) return !(isWordChar(beyond) && !isDigit(beyond));
  return isWordChar(edge) && isWordChar(next);
}

/** Whether `line.slice(from, to)` is a whole word there, in the core's sense. */
function standsAlone(line: string, from: number, to: number) {
  return !joins(line[from], line[from - 1], line[from - 2]) && !joins(line[to - 1], line[to], line[to + 1]);
}

/** Whether a search for `needle` matches exactly `line.slice(from, to)`. */
export function isMatchAt(line: string, from: number, to: number, needle: string, matching: Matching) {
  const text = line.slice(from, to);
  const same = matching.caseSensitive ? text === needle : foldCase(text) === foldCase(needle);
  return same && (!matching.wholeWord || standsAlone(line, from, to));
}

/** Non-overlapping matches of `needle` in a line, in UTF-16 indices. */
export function findMatches(line: string, needle: string, matching: Matching): [number, number][] {
  const [hay, sought] = matching.caseSensitive ? [line, needle] : [foldCase(line), foldCase(needle)];
  const found: [number, number][] = [];
  let free = 0;
  // Overlapping ones too: one inside a longer word must not hide one beside it.
  for (let at = hay.indexOf(sought); at >= 0; at = hay.indexOf(sought, at + 1)) {
    if (at < free || (matching.wholeWord && !standsAlone(line, at, at + sought.length))) continue;
    found.push([at, at + sought.length]);
    free = at + sought.length;
  }
  return found;
}
