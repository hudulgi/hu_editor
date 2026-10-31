// Per-line highlighting for the visible lines only. Both formats are line
// based, so a line can be colored without looking at its neighbours. This is
// a stopgap: highlighting that needs context (which keyword block a data
// line belongs to, Nastran section) will move into the Rust core.

export type Lang = "abaqus" | "nastran" | "plain";

export interface Token {
  text: string;
  cls: string | null;
}

export const LANG_LABEL: Record<Lang, string> = {
  abaqus: "Abaqus",
  nastran: "Nastran",
  plain: "Plain text",
};

const NASTRAN_EXT = ["bdf", "dat", "nas", "blk", "bulk", "fem"];

export function detectLang(name: string): Lang {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "inp") return "abaqus";
  if (NASTRAN_EXT.includes(ext)) return "nastran";
  return "plain";
}

/** Splits `line` into tokens whose texts concatenate back to `line`. */
export function tokenize(line: string, lang: Lang): Token[] {
  if (lang === "abaqus") return abaqus(line);
  if (lang === "nastran") return nastran(line);
  return [{ text: line, cls: null }];
}

// `, name=value` or `, flag` after the keyword.
const PARAM = /(,\s*)([^,=]*)(?:(=)([^,]*))?/g;

function abaqus(line: string): Token[] {
  if (line.startsWith("**")) return [{ text: line, cls: "comment" }];
  if (!line.startsWith("*")) return [{ text: line, cls: null }];
  const comma = line.indexOf(",");
  if (comma < 0) return [{ text: line, cls: "keyword" }];
  const tokens: Token[] = [{ text: line.slice(0, comma), cls: "keyword" }];
  for (const m of line.slice(comma).matchAll(PARAM)) {
    tokens.push({ text: m[1], cls: "punct" }, { text: m[2], cls: "param" });
    if (m[3]) tokens.push({ text: m[3], cls: "punct" }, { text: m[4], cls: "value" });
  }
  return tokens;
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
    tokens.push({ text: line.slice(pos, pos + width), cls: i % 2 ? "fb" : "fa" });
  }
  return tokens;
}

function nastranFree(line: string): Token[] {
  const parts = line.split(",");
  const tokens: Token[] = [{ text: parts[0], cls: /^[A-Za-z]/.test(parts[0]) ? "card" : "cont" }];
  parts.slice(1).forEach((part, i) => {
    tokens.push({ text: ",", cls: "punct" }, { text: part, cls: i % 2 ? "fb" : "fa" });
  });
  return tokens;
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
