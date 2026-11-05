// User settings: a reactive object read anywhere in the app, kept in the
// settings file. Window layout and the last session stay in localStorage;
// they are state, not choices.

import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "./api";
import type { Encoding } from "./api";

export type Language = "en" | "ko";

export interface Settings {
  language: Language;
  restoreSession: boolean;
  showHidden: boolean;
  /** Empty: the built-in list of monospaced fonts. */
  fontFamily: string;
  fontSize: number;
  lineNumbers: boolean;
  highlightLine: boolean;
  /** The Tab key inserts spaces up to the next multiple of `tabSize`; otherwise a tab character. */
  tabSpaces: boolean;
  tabSize: number;
  syntaxHighlight: boolean;
  fieldShading: boolean;
  newFileEncoding: Encoding;
  /** "os": the platform's line break. */
  newFileEol: "os" | "crlf" | "lf";
  /** For files that are not valid UTF-8, until an encoding is chosen for them. */
  fallbackEncoding: Encoding;
  /** For `.blk` files whose content does not tell. */
  blkDefault: "nastran" | "abaqus";
}

const ENCODINGS: readonly Encoding[] = ["utf8", "cp949", "shiftJis", "gbk", "big5", "windows1252"];
const DEFAULT_FONTS = `"Cascadia Mono", Consolas, "D2Coding", Menlo, monospace`;

function defaults(): Settings {
  return {
    language: navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en",
    restoreSession: true,
    showHidden: false,
    fontFamily: "",
    fontSize: 13,
    lineNumbers: true,
    highlightLine: true,
    tabSpaces: true,
    tabSize: 8,
    syntaxHighlight: true,
    fieldShading: true,
    newFileEncoding: "utf8",
    newFileEol: "os",
    fallbackEncoding: "cp949",
    blkDefault: "nastran",
  };
}

export const settings = $state<Settings>(defaults());

/** Why the settings file could not be written, if it could not. */
export const settingsFile = $state<{ error: string | null }>({ error: null });

const clamp = (value: number, low: number, high: number, otherwise: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : otherwise;

export const clampFontSize = (value: number) => clamp(value, 8, 32, 13);
export const clampTabSize = (value: number) => clamp(value, 1, 16, 8);

/** Takes what is usable from a settings file; anything else keeps its default. */
function usable(saved: Partial<Settings>): Partial<Settings> {
  const base = defaults();
  const out: Partial<Settings> = {};
  for (const key of Object.keys(base) as (keyof Settings)[]) {
    if (typeof saved[key] === typeof base[key]) Object.assign(out, { [key]: saved[key] });
  }
  if (out.language !== "en" && out.language !== "ko") delete out.language;
  if (out.newFileEol && !["os", "crlf", "lf"].includes(out.newFileEol)) delete out.newFileEol;
  if (out.blkDefault && !["nastran", "abaqus"].includes(out.blkDefault)) delete out.blkDefault;
  if (out.newFileEncoding && !ENCODINGS.includes(out.newFileEncoding)) delete out.newFileEncoding;
  if (out.fallbackEncoding && (!ENCODINGS.includes(out.fallbackEncoding) || out.fallbackEncoding === "utf8")) {
    delete out.fallbackEncoding;
  }
  if (out.fontSize !== undefined) out.fontSize = clampFontSize(out.fontSize);
  if (out.tabSize !== undefined) out.tabSize = clampTabSize(out.tabSize);
  return out;
}

/** Reads the settings file; a missing or damaged one leaves the defaults. */
export async function loadSettings() {
  try {
    const text = await api.loadSettings();
    if (text) Object.assign(settings, usable(JSON.parse(text)));
  } catch (e) {
    console.error("settings not loaded:", e);
  }
  applyToPage();
  watch();
}

const SETTINGS_NEWS = "hu://settings";

/** From now on, a change reaches the page at once, and the file and the other windows soon after. */
function watch() {
  const thisWindow = getCurrentWindow().label;
  let saved = JSON.stringify(settings);
  let timer: ReturnType<typeof setTimeout>;
  let writing = Promise.resolve();
  listen<{ from: string; text: string }>(SETTINGS_NEWS, ({ payload }) => {
    if (payload.from === thisWindow) return;
    Object.assign(settings, usable(JSON.parse(payload.text)));
    saved = JSON.stringify(settings);
  });
  $effect.root(() => {
    $effect(() => {
      applyToPage();
      const text = JSON.stringify(settings);
      if (text === saved) return;
      saved = text;
      clearTimeout(timer);
      timer = setTimeout(() => {
        emit(SETTINGS_NEWS, { from: thisWindow, text: JSON.stringify(settings) });
        writing = writing
          .then(() => api.saveSettings(JSON.stringify(settings, null, 2)))
          .catch((e) => {
            settingsFile.error = String(e);
          });
      }, 200);
    });
  });
}

export function resetSettings() {
  Object.assign(settings, defaults());
}

/** Pixels per line for a font size. */
export const lineHeight = (fontSize: number) => Math.round(fontSize * 1.54);

/** The CSS font-family of the editor. */
export function fontStack() {
  const name = settings.fontFamily.replace(/["\\]/g, "").trim();
  return name ? `"${name}", ${DEFAULT_FONTS}` : DEFAULT_FONTS;
}

/** Sets the CSS variables the styles read. */
export function applyToPage() {
  const style = document.documentElement.style;
  style.setProperty("--mono", fontStack());
  style.setProperty("--font-size", `${settings.fontSize}px`);
  style.setProperty("--line-h", `${lineHeight(settings.fontSize)}px`);
  document.documentElement.lang = settings.language;
}
