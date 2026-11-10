// Highlighting for source code and config files. Unlike solver decks, a line can
// depend on the ones before it (block comments, multi-line strings), so scanning
// a line takes the state left by the line above and gives the next line's. See
// lineStates.ts for how that state is found for a line in the middle of a file.

import type { Token } from "./syntax";

export type CodeLang =
  | "python"
  | "shell"
  | "batch"
  | "powershell"
  | "java"
  | "c"
  | "javascript"
  | "rust"
  | "go"
  | "fortran"
  | "fortranFixed"
  | "toml"
  | "yaml"
  | "json"
  | "ini"
  | "xml"
  | "markdown"
  | "csv"
  | "tsv";

/** What the next line starts inside of; plain data, null for nothing. */
export type LineState =
  | null
  /** A comment or string, until `until`. */
  | { until: string; cls: string; escape: string | null }
  /** A shell here-document, until a line that is just `heredoc`. */
  | { heredoc: string; indented: boolean }
  /** A YAML block scalar, while lines are indented further than this. */
  | { blockIndent: number }
  /** A Markdown code block, until a line starting with `fence`. */
  | { fence: string }
  /** Between the attributes of an XML tag. */
  | { tag: true };

const LANGUAGES: Record<CodeLang, { label: string; badge: string; extensions: string[] }> = {
  python: { label: "Python", badge: "Py", extensions: ["py", "pyw", "pyi"] },
  shell: { label: "Shell", badge: "Sh", extensions: ["sh", "bash", "zsh", "ksh", "bashrc", "zshrc", "profile"] },
  batch: { label: "Batch", badge: "Bt", extensions: ["bat", "cmd"] },
  powershell: { label: "PowerShell", badge: "PS", extensions: ["ps1", "psm1", "psd1"] },
  java: { label: "Java", badge: "Ja", extensions: ["java"] },
  c: { label: "C/C++", badge: "C", extensions: ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx"] },
  javascript: { label: "JavaScript", badge: "JS", extensions: ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"] },
  rust: { label: "Rust", badge: "Rs", extensions: ["rs"] },
  go: { label: "Go", badge: "Go", extensions: ["go"] },
  fortran: { label: "Fortran", badge: "F", extensions: ["f90", "f95", "f03", "f08"] },
  fortranFixed: { label: "Fortran", badge: "F", extensions: ["f", "for", "ftn", "f77", "fpp"] },
  toml: { label: "TOML", badge: "TM", extensions: ["toml"] },
  yaml: { label: "YAML", badge: "YM", extensions: ["yaml", "yml"] },
  json: { label: "JSON", badge: "{}", extensions: ["json", "jsonc", "geojson"] },
  ini: { label: "INI", badge: "In", extensions: ["ini", "cfg", "conf", "properties", "env"] },
  xml: { label: "XML/HTML", badge: "<>", extensions: ["xml", "xsd", "xsl", "svg", "html", "htm", "xhtml", "vue", "svelte"] },
  markdown: { label: "Markdown", badge: "MD", extensions: ["md", "markdown"] },
  csv: { label: "CSV", badge: "CS", extensions: ["csv"] },
  tsv: { label: "TSV", badge: "TS", extensions: ["tsv", "tab"] },
};

const BY_EXTENSION = new Map<string, CodeLang>(
  (Object.keys(LANGUAGES) as CodeLang[]).flatMap((lang) => LANGUAGES[lang].extensions.map((ext) => [ext, lang] as [string, CodeLang])),
);

export const codeLangOf = (extension: string) => BY_EXTENSION.get(extension) ?? null;
export const isCodeLang = (lang: string): lang is CodeLang => lang in LANGUAGES;
export const codeLabel = (lang: CodeLang) => LANGUAGES[lang].label;
export const codeBadge = (lang: CodeLang) => LANGUAGES[lang].badge;

/** The extensions of each language by its name, as file types of a dialog: one per name (both Fortrans in one), by name. */
export function codeFileTypes() {
  const byName = new Map<string, string[]>();
  for (const { label, extensions } of Object.values(LANGUAGES)) byName.set(label, [...(byName.get(label) ?? []), ...extensions]);
  return [...byName].map(([name, extensions]) => ({ name, extensions })).sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Languages whose lines can depend on the lines before. */
export const dependsOnLinesAbove = (lang: CodeLang) => !["batch", "ini", "fortran", "fortranFixed", "csv", "tsv"].includes(lang);

// ---- Scanning ---------------------------------------------------------------

class Tokens {
  list: Token[] = [];

  push(text: string, cls: string | null) {
    if (!text) return;
    const last = this.list.at(-1);
    if (last && last.cls === cls) last.text += text;
    else this.list.push({ text, cls });
  }
}

/** The index right after the first `close` at or after `from`, or -1. */
function endOf(line: string, from: number, close: string, escape: string | null) {
  for (let i = from; i <= line.length - close.length; i++) {
    if (escape && line[i] === escape) i++;
    else if (line.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

interface StringRule {
  open: string;
  /** The same as `open` if not given. */
  close?: string;
  multiline?: boolean;
  /** The escape character; a backslash if not given. */
  escape?: string | null;
}

interface Special {
  length: number;
  cls: string | null;
  /** The next line starts in this state (the rest of this line reads as usual). */
  next?: LineState;
}

interface Spec {
  lineComments?: string[];
  /** A line comment must not touch a word, as in `a#b` in a shell. */
  commentApart?: boolean;
  blockComments?: [string, string][];
  /** Tried in order: longer openings first. */
  strings?: StringRule[];
  keywords?: Set<string>;
  types?: Set<string>;
  constants?: Set<string>;
  ignoreCase?: boolean;
  /** Words starting with a capital are types. */
  capitalizedTypes?: boolean;
  word?: RegExp;
  /** Anything the rules above do not cover, tried at each position. */
  special?: (line: string, i: number) => Special | null;
  /** The class of a string, ending at `end`. */
  stringClass?: (line: string, end: number) => string;
}

const words = (text: string) => new Set(text.trim().split(/\s+/));

const WORD = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER = /0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eEdD][+-]?\d+)?[a-zA-Z_]*/y;

function matchAt(pattern: RegExp, line: string, i: number) {
  pattern.lastIndex = i;
  return pattern.exec(line);
}

const atLineStart = (line: string, i: number) => line.slice(0, i).trim() === "";

/** Reads `line` from `start` by the rules of `spec`; returns the state for the next line. */
function scanCode(spec: Spec, line: string, start: number, out: Tokens): LineState {
  let next: LineState = null;
  let i = start;
  scanning: while (i < line.length) {
    for (const marker of spec.lineComments ?? []) {
      if (line.startsWith(marker, i) && (!spec.commentApart || i === 0 || /[\s;(]/.test(line[i - 1]))) {
        out.push(line.slice(i), "comment");
        return next;
      }
    }
    for (const [open, close] of spec.blockComments ?? []) {
      if (!line.startsWith(open, i)) continue;
      const end = endOf(line, i + open.length, close, null);
      if (end < 0) {
        out.push(line.slice(i), "comment");
        return { until: close, cls: "comment", escape: null };
      }
      out.push(line.slice(i, end), "comment");
      i = end;
      continue scanning;
    }
    const special = spec.special?.(line, i);
    if (special) {
      out.push(line.slice(i, i + special.length), special.cls);
      if (special.next) next = special.next;
      i += special.length;
      continue;
    }
    for (const rule of spec.strings ?? []) {
      if (!line.startsWith(rule.open, i)) continue;
      const close = rule.close ?? rule.open;
      const escape = rule.escape === undefined ? "\\" : rule.escape;
      const end = endOf(line, i + rule.open.length, close, escape);
      if (end < 0) {
        out.push(line.slice(i), "value");
        return rule.multiline ? { until: close, cls: "value", escape } : next;
      }
      out.push(line.slice(i, end), spec.stringClass?.(line, end) ?? "value");
      i = end;
      continue scanning;
    }
    const before = line[i - 1];
    if (/\d/.test(line[i]) && !(before && /[\p{L}\p{N}_$]/u.test(before))) {
      const number = matchAt(NUMBER, line, i)!;
      out.push(number[0], "number");
      i += number[0].length;
      continue;
    }
    const word = matchAt(spec.word ?? WORD, line, i);
    if (word) {
      out.push(word[0], classOfWord(spec, word[0], line, i + word[0].length));
      i += word[0].length;
      continue;
    }
    const length = line.codePointAt(i)! > 0xffff ? 2 : 1;
    out.push(line.slice(i, i + length), null);
    i += length;
  }
  return next;
}

function classOfWord(spec: Spec, word: string, line: string, end: number) {
  const key = spec.ignoreCase ? word.toLowerCase() : word;
  if (spec.keywords?.has(key) || spec.constants?.has(key)) return "keyword";
  if (spec.types?.has(key)) return "card";
  if (spec.capitalizedTypes && /^\p{Lu}/u.test(word)) return "card";
  if (/^\s*\(/.test(line.slice(end, end + 64))) return "fn";
  return null;
}

/** Continues a comment or string from the line above; returns where this line goes on, or -1. */
function resume(line: string, state: LineState, out: Tokens): number {
  if (!state || !("until" in state)) return 0;
  const end = endOf(line, 0, state.until, state.escape);
  out.push(end < 0 ? line : line.slice(0, end), state.cls);
  return end;
}

type Scanner = (line: string, state: LineState, out: Tokens) => LineState;

const code =
  (spec: Spec): Scanner =>
  (line, state, out) => {
    const start = resume(line, state, out);
    return start < 0 ? state : scanCode(spec, line, start, out);
  };

// ---- The C family -------------------------------------------------------------

const C_COMMENTS = { lineComments: ["//"], blockComments: [["/*", "*/"]] as [string, string][] };
const C_STRINGS: StringRule[] = [{ open: '"' }, { open: "'" }];

const java = code({
  ...C_COMMENTS,
  strings: [{ open: '"""', multiline: true }, ...C_STRINGS],
  keywords: words(`abstract assert break case catch class const continue default do else enum extends final finally
    for goto if implements import instanceof interface native new package private protected public record return sealed
    static strictfp super switch synchronized this throw throws transient try var volatile while yield`),
  types: words("boolean byte char double float int long short void"),
  constants: words("true false null"),
  capitalizedTypes: true,
  special: (line, i) => {
    const annotation = line[i] === "@" ? matchAt(/@[\p{L}_][\p{L}\p{N}_.]*/uy, line, i) : null;
    return annotation ? { length: annotation[0].length, cls: "card" } : null;
  },
});

const c = code({
  ...C_COMMENTS,
  strings: C_STRINGS,
  keywords: words(`alignas alignof auto break case catch class const constexpr continue decltype default delete do else
    enum explicit export extern for friend goto if inline mutable namespace new noexcept operator override private
    protected public register return sizeof static struct switch template this throw try typedef typeid typename union
    using virtual volatile while`),
  types: words(`bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t
    ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t std string vector`),
  constants: words("true false nullptr NULL"),
  special: (line, i) => {
    if (line[i] === "#" && atLineStart(line, i)) {
      const directive = matchAt(/#\s*\w+/y, line, i)!;
      return directive ? { length: directive[0].length, cls: "keyword" } : null;
    }
    // The file in #include <file>.
    if (line[i] === "<" && /^\s*#\s*include\b/.test(line)) {
      const file = matchAt(/<[^>]*>/y, line, i);
      if (file) return { length: file[0].length, cls: "value" };
    }
    return null;
  },
});

const javascript = code({
  ...C_COMMENTS,
  strings: [{ open: "`", multiline: true }, ...C_STRINGS],
  word: /[\p{L}_$][\p{L}\p{N}_$]*/uy,
  keywords: words(`abstract as async await break case catch class const continue debugger declare default delete do else
    enum export extends finally for from function get if implements import in instanceof interface let namespace new of
    private protected public readonly return set static super switch this throw try type typeof var void while with yield`),
  types: words("any bigint boolean never number object string symbol unknown"),
  constants: words("true false null undefined NaN Infinity"),
  capitalizedTypes: true,
});

const rust = code({
  ...C_COMMENTS,
  strings: [{ open: '"', multiline: true }],
  keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod
    move mut pub ref return self Self static struct super trait type unsafe use where while`),
  types: words(`bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize`),
  constants: words("true false"),
  capitalizedTypes: true,
  special: (line, i) => {
    if (line[i] === "'") {
      // A character, which may be a quote; a lifetime is left alone.
      const char = matchAt(/'(?:\\.[^']*|[^\\'])'/y, line, i);
      return char ? { length: char[0].length, cls: "value" } : null;
    }
    if (line[i] === "#" && atLineStart(line, i)) {
      const attribute = matchAt(/#!?\[.*\]/y, line, i);
      return attribute ? { length: attribute[0].length, cls: "card" } : null;
    }
    const macro = /\p{L}/u.test(line[i]) && !/[\p{L}\p{N}_]/u.test(line[i - 1] ?? "") ? matchAt(/[\p{L}_][\p{L}\p{N}_]*!/uy, line, i) : null;
    return macro ? { length: macro[0].length, cls: "fn" } : null;
  },
});

const go = code({
  ...C_COMMENTS,
  strings: [{ open: "`", multiline: true, escape: null }, ...C_STRINGS],
  keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map
    package range return select struct switch type var`),
  types: words(`any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string
    uint uint8 uint16 uint32 uint64 uintptr`),
  constants: words("true false nil iota"),
});

// ---- Scripts ------------------------------------------------------------------

const python = code({
  lineComments: ["#"],
  strings: [
    { open: '"""', multiline: true },
    { open: "'''", multiline: true },
    { open: '"' },
    { open: "'" },
  ],
  keywords: words(`and as assert async await break class continue def del elif else except finally for from global if
    import in is lambda match nonlocal not or pass raise return try while with yield self cls`),
  types: words(`bool bytes bytearray complex dict float frozenset int list object set str tuple type range BaseException
    Exception`),
  constants: words("True False None"),
  special: (line, i) => {
    if (line[i] !== "@" || !atLineStart(line, i)) return null;
    const decorator = matchAt(/@[\p{L}_][\p{L}\p{N}_.]*/uy, line, i);
    return decorator ? { length: decorator[0].length, cls: "fn" } : null;
  },
});

const SHELL_VARIABLE = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|\d|[?@#*$!-])/y;
const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/y;

const shellCode: Spec = {
  lineComments: ["#"],
  commentApart: true,
  strings: [
    { open: "'", multiline: true, escape: null },
    { open: '"', multiline: true },
  ],
  word: /[\p{L}_][\p{L}\p{N}_-]*/uy,
  keywords: words(`if then else elif fi for while until do done case esac function in select time return exit break
    continue local export readonly declare typeset unset`),
  types: words(`echo printf read cd pwd source eval exec set shift test trap wait alias umask kill getopts`),
  constants: words("true false"),
  special: (line, i) => {
    if (line[i] === "$") {
      const variable = matchAt(SHELL_VARIABLE, line, i);
      return variable ? { length: variable[0].length, cls: "param" } : null;
    }
    if (line[i] === "\\" && i + 1 < line.length) return { length: 2, cls: null };
    if (line[i] === "<" && line[i - 1] !== "<" && line[i - 1] !== "$") {
      const heredoc = matchAt(HEREDOC, line, i);
      if (heredoc) return { length: heredoc[0].length, cls: "keyword", next: { heredoc: heredoc[3], indented: heredoc[1] === "-" } };
    }
    return null;
  },
};

const shell: Scanner = (line, state, out) => {
  if (state && "heredoc" in state) {
    const text = state.indented ? line.replace(/^\t+/, "") : line;
    if (text !== state.heredoc) {
      out.push(line, "value");
      return state;
    }
    out.push(line, "keyword");
    return null;
  }
  const start = resume(line, state, out);
  return start < 0 ? state : scanCode(shellCode, line, start, out);
};

const batchCode = code({
  strings: [{ open: '"', escape: null }],
  ignoreCase: true,
  word: /[\p{L}_][\p{L}\p{N}_.-]*/uy,
  keywords: words(`if else for in do goto call set setlocal endlocal echo exit shift pause not exist defined errorlevel
    equ neq lss leq gtr geq cd pushd popd start title cls copy del move mkdir rmdir type`),
  special: (line, i) => {
    if (line[i] !== "%" && line[i] !== "!") return null;
    const variable = matchAt(line[i] === "%" ? /%(?:~[a-zA-Z]*\d|\d|\*|[^%\s]+%)/y : /![^!\s]+!/y, line, i);
    return variable ? { length: variable[0].length, cls: "param" } : null;
  },
});

const batch: Scanner = (line, state, out) => {
  if (/^\s*@?rem(\s|$)/i.test(line) || /^\s*::/.test(line)) out.push(line, "comment");
  else if (/^\s*:/.test(line)) out.push(line, "fn");
  else return batchCode(line, state, out);
  return null;
};

const powershell = code({
  lineComments: ["#"],
  blockComments: [["<#", "#>"]],
  strings: [
    { open: '@"', close: '"@', multiline: true, escape: null },
    { open: "@'", close: "'@", multiline: true, escape: null },
    { open: '"', multiline: true, escape: "`" },
    { open: "'", multiline: true, escape: null },
  ],
  ignoreCase: true,
  word: /[\p{L}_][\p{L}\p{N}_-]*/uy,
  keywords: words(`begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for
    foreach from function if in param process return switch throw trap try until using while`),
  constants: words("true false null"),
  special: (line, i) => {
    if (line[i] === "$") {
      const variable = matchAt(/\$(?:\{[^}]*\}|[\p{L}_][\p{L}\p{N}_]*(?::[\p{L}_][\p{L}\p{N}_]*)?|[?$^])/uy, line, i);
      return variable ? { length: variable[0].length, cls: "param" } : null;
    }
    const cmdlet = /\p{Lu}/u.test(line[i]) ? matchAt(/\p{Lu}\p{Ll}+-\p{Lu}[\p{L}\p{N}]*/uy, line, i) : null;
    return cmdlet ? { length: cmdlet[0].length, cls: "fn" } : null;
  },
});

const FORTRAN: Spec = {
  lineComments: ["!"],
  strings: [
    { open: "'", escape: null },
    { open: '"', escape: null },
  ],
  ignoreCase: true,
  keywords: words(`allocate allocatable assign backspace block call case close common contains continue cycle data
    deallocate default dimension do else elseif elsewhere end endblock enddo endfile endif endmodule endprogram endselect
    endsubroutine endfunction endtype entry equivalence exit external format function goto if implicit in include inout
    inquire intent interface intrinsic module namelist none nullify only open optional out parameter pause pointer
    print private procedure program public read recursive result return rewind save select stop subroutine target then
    to type use where while write`),
  types: words("byte character complex double integer logical precision real"),
  special: (line, i) => {
    if (line[i] !== ".") return null;
    const operator = matchAt(/\.[A-Za-z]+\./y, line, i);
    return operator ? { length: operator[0].length, cls: "keyword" } : null;
  },
};

const fortran = code(FORTRAN);

/** Fixed form: besides `!`, a C or * in the first column starts a comment. */
const fortranFixed: Scanner = (line, state, out) => {
  if (/^[cC*]/.test(line)) {
    out.push(line, "comment");
    return null;
  }
  return fortran(line, state, out);
};

// ---- Data ---------------------------------------------------------------------

const TOML_VALUE: Spec = {
  lineComments: ["#"],
  strings: [
    { open: '"""', multiline: true },
    { open: "'''", multiline: true, escape: null },
    { open: '"' },
    { open: "'", escape: null },
  ],
  constants: words("true false inf nan"),
  special: (line, i) => {
    if (!/\d/.test(line[i]) || /[\w-]/.test(line[i - 1] ?? "")) return null;
    const date = matchAt(/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/y, line, i);
    return date ? { length: date[0].length, cls: "number" } : null;
  },
};

const TOML_KEY = /^\s*(?:[\w-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[\w-]+|"[^"]*"|'[^']*'))*\s*(?==)/;

const toml: Scanner = (line, state, out) => {
  let start = resume(line, state, out);
  if (start < 0) return state;
  if (!state) {
    const head = /^\s*\[\[?[^\]#]*\]\]?/.exec(line) ?? TOML_KEY.exec(line);
    if (head) {
      out.push(head[0], head[0].trimStart().startsWith("[") ? "card" : "param");
      start = head[0].length;
    }
  }
  return scanCode(TOML_VALUE, line, start, out);
};

const YAML_FLOW: Spec = {
  strings: [{ open: '"' }, { open: "'", escape: null }],
  lineComments: ["#"],
  commentApart: true,
  constants: words("true false null"),
};

const YAML_SCALAR = /^(?:true|false|yes|no|on|off|null|~|[-+]?\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|0x[\da-fA-F]+)$/i;

/** The value after a key or list marker; `indent` is that key's. */
function yamlValue(text: string, indent: number, out: Tokens): LineState {
  const lead = /^\s*/.exec(text)![0];
  out.push(lead, null);
  let rest = text.slice(lead.length);
  // Anchors, aliases and tags in front.
  for (let mark = /^[&*!]\S*\s*/.exec(rest); mark; mark = /^[&*!]\S*\s*/.exec(rest)) {
    out.push(mark[0], "keyword");
    rest = rest.slice(mark[0].length);
  }
  const block = /^([|>][-+\d]*)(\s*)(#.*)?$/.exec(rest);
  if (block) {
    out.push(block[1], "keyword");
    out.push(block[2], null);
    out.push(block[3] ?? "", "comment");
    return { blockIndent: indent };
  }
  const first = rest[0];
  if (first === '"' || first === "'" || first === "[" || first === "{") {
    scanCode(YAML_FLOW, rest, 0, out);
    return null;
  }
  const comment = /(^|\s)#/.exec(rest);
  const at = comment ? comment.index + comment[1].length : rest.length;
  const scalar = rest.slice(0, at);
  const cls = YAML_SCALAR.test(scalar.trim()) ? (/^[-+\d.~]|^0x/i.test(scalar.trim()) ? "number" : "keyword") : null;
  out.push(scalar, cls);
  out.push(rest.slice(at), "comment");
  return null;
}

const YAML_KEY = /^(\s*(?:-\s+)*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{}&*!|>%@`][^#]*?)(\s*:)(?=\s|$)/;

const yaml: Scanner = (line, state, out) => {
  const indent = /^ */.exec(line)![0].length;
  if (state && "blockIndent" in state) {
    if (line.trim() === "" || indent > state.blockIndent) {
      out.push(line, "value");
      return state;
    }
  }
  if (/^\s*#/.test(line)) {
    out.push(line, "comment");
    return null;
  }
  const marker = /^(---|\.\.\.)(\s|$)/.exec(line);
  if (marker) {
    out.push(marker[1], "keyword");
    return yamlValue(line.slice(marker[1].length), -1, out);
  }
  // Only so far: keys are short, and this pattern can take long over a long line.
  const key = YAML_KEY.exec(line.slice(0, 1024));
  if (key) {
    out.push(key[1], "punct");
    out.push(key[2], "param");
    out.push(key[3], "punct");
    return yamlValue(line.slice(key[0].length), key[1].length, out);
  }
  const item = /^(\s*(?:-\s+)+)/.exec(line);
  if (item) {
    out.push(item[1], "punct");
    return yamlValue(line.slice(item[1].length), indent, out);
  }
  return yamlValue(line, indent, out);
};

const json = code({
  ...C_COMMENTS,
  strings: [{ open: '"' }],
  constants: words("true false null"),
  stringClass: (line, end) => (/^\s*:/.test(line.slice(end, end + 64)) ? "param" : "value"),
});

const ini: Scanner = (line, _state, out) => {
  if (/^\s*[;#]/.test(line)) {
    out.push(line, "comment");
    return null;
  }
  const section = /^\s*\[[^\]]*\]/.exec(line);
  if (section) {
    out.push(section[0], "card");
    out.push(line.slice(section[0].length), null);
    return null;
  }
  const entry = /^([^=:]+)([=:])(.*)$/.exec(line);
  if (entry) {
    out.push(entry[1], "param");
    out.push(entry[2], "punct");
    out.push(entry[3], "value");
  } else {
    out.push(line, null);
  }
  return null;
};

const XML_NAME = /[\p{L}_:][\p{L}\p{N}_:.-]*/uy;

const xml: Scanner = (line, state, out) => {
  let i = resume(line, state, out);
  if (i < 0) return state;
  let inTag = state !== null && "tag" in state;
  while (i < line.length) {
    const char = line[i];
    if (inTag) {
      if (char === '"' || char === "'") {
        const end = endOf(line, i + 1, char, null);
        out.push(end < 0 ? line.slice(i) : line.slice(i, end), "value");
        if (end < 0) return { tag: true };
        i = end;
      } else if (char === ">" || line.startsWith("/>", i) || line.startsWith("?>", i)) {
        const length = char === ">" ? 1 : 2;
        out.push(line.slice(i, i + length), "punct");
        i += length;
        inTag = false;
      } else {
        const name = matchAt(XML_NAME, line, i);
        out.push(name ? name[0] : char, name ? "param" : null);
        i += name ? name[0].length : 1;
      }
      continue;
    }
    if (line.startsWith("<!--", i) || line.startsWith("<![CDATA[", i)) {
      const comment = line.startsWith("<!--", i);
      const close = comment ? "-->" : "]]>";
      const cls = comment ? "comment" : "value";
      const end = endOf(line, i + 4, close, null);
      if (end < 0) {
        out.push(line.slice(i), cls);
        return { until: close, cls, escape: null };
      }
      out.push(line.slice(i, end), cls);
      i = end;
      continue;
    }
    const tag = char === "<" ? matchAt(/<[/?!]?[\p{L}_:][\p{L}\p{N}_:.-]*/uy, line, i) : null;
    if (tag) {
      out.push(tag[0], "keyword");
      i += tag[0].length;
      inTag = true;
      continue;
    }
    const entity = char === "&" ? matchAt(/&#?\w+;/y, line, i) : null;
    out.push(entity ? entity[0] : char, entity ? "param" : null);
    i += entity ? entity[0].length : 1;
  }
  return inTag ? { tag: true } : null;
};

const markdown: Scanner = (line, state, out) => {
  if (state && "fence" in state) {
    const closes = line.trimStart().startsWith(state.fence);
    out.push(line, closes ? "keyword" : "value");
    return closes ? null : state;
  }
  const fence = /^\s*(`{3,}|~{3,})/.exec(line);
  if (fence) {
    out.push(line, "keyword");
    return { fence: fence[1] };
  }
  if (/^#{1,6}\s/.test(line)) {
    out.push(line, "keyword");
    return null;
  }
  if (/^\s*>/.test(line)) {
    out.push(line, "comment");
    return null;
  }
  const marker = /^\s*(?:[-*+]|\d+[.)])\s/.exec(line);
  const start = marker ? marker[0].length : 0;
  out.push(line.slice(0, start), "keyword");
  let at = start;
  for (const span of line.slice(start).matchAll(/`[^`]+`|\[[^\]]*\]\([^)]*\)/g)) {
    const from = start + span.index;
    out.push(line.slice(at, from), null);
    if (span[0][0] === "`") {
      out.push(span[0], "value");
    } else {
      const split = span[0].indexOf("](") + 1;
      out.push(span[0].slice(0, split), "param");
      out.push(span[0].slice(split), "value");
    }
    at = from + span[0].length;
  }
  out.push(line.slice(at), null);
  return null;
};

/** How many colors the fields of a line go through. */
export const FIELD_COLORS = 8;

/**
 * The fields of a CSV line, where a quoted field may hold the separator. A
 * field's class tells which it is; the colors show only with rainbow columns on.
 */
export function separatedFields(line: string, separator: string): { start: number; end: number }[] {
  const fields: { start: number; end: number }[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === separator) {
      fields.push({ start, end: i });
      start = i + 1;
    }
  }
  fields.push({ start, end: line.length });
  return fields;
}

const separated =
  (separator: string): Scanner =>
  (line, _state, out) => {
    separatedFields(line, separator).forEach(({ start, end }, i) => {
      if (i > 0) out.push(separator, "punct");
      out.push(line.slice(start, end), `rb${i % FIELD_COLORS}`);
    });
    return null;
  };

const SCANNERS: Record<CodeLang, Scanner> = {
  python,
  shell,
  batch,
  powershell,
  java,
  c,
  javascript,
  rust,
  go,
  fortran,
  fortranFixed,
  toml,
  yaml,
  json,
  ini,
  xml,
  markdown,
  csv: separated(","),
  tsv: separated("\t"),
};

/** Splits `line` into tokens whose texts concatenate back to it, and gives the next line's state. */
export function scanLine(lang: CodeLang, line: string, state: LineState): { tokens: Token[]; state: LineState } {
  const out = new Tokens();
  const next = SCANNERS[lang](line, state, out);
  return { tokens: out.list.length ? out.list : [{ text: line, cls: null }], state: next };
}

/** What Toggle Line Comment and Toggle Block Comment write, as VS Code has them. */
export interface Comments {
  line: string | null;
  block: [string, string] | null;
  /** A line comment goes at the line's start, not after its indent: a solver reads it from column 1. */
  atStart: boolean;
}

const C_LIKE: [string, string] = ["/*", "*/"];
const MARKUP: [string, string] = ["<!--", "-->"];
const COMMENTS: Partial<Record<string, [string | null, [string, string] | null]>> = {
  python: ["#", ['"""', '"""']],
  shell: ["#", null],
  batch: ["REM", null],
  powershell: ["#", ["<#", "#>"]],
  java: ["//", C_LIKE],
  c: ["//", C_LIKE],
  javascript: ["//", C_LIKE],
  rust: ["//", C_LIKE],
  go: ["//", C_LIKE],
  fortran: ["!", null],
  fortranFixed: ["!", null],
  toml: ["#", null],
  yaml: ["#", null],
  json: ["//", C_LIKE],
  ini: [";", null],
  xml: [null, MARKUP],
  markdown: [null, MARKUP],
};

export function commentsOf(lang: string): Comments {
  if (lang === "abaqus") return { line: "**", block: null, atStart: true };
  if (lang === "nastran") return { line: "$", block: null, atStart: true };
  const [line, block] = COMMENTS[lang] ?? [null, null];
  return { line, block, atStart: false };
}
