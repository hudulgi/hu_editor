// The app's words. `t` reads the language setting, so text in templates and
// derived values follows a change at once.

import { ENCODING_LABEL } from "../encodings";
import { formatNumber } from "../format";
import { settings } from "../settings.svelte";
import type { Encoding } from "../api";
import { en } from "./en";
import { ko } from "./ko";

export type MessageKey = keyof typeof en;

const MESSAGES = { en, ko };

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text: string = MESSAGES[settings.language][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/**
 * An error from the backend in the user's language. The editor's own problems
 * arrive as JSON with a code; OS errors arrive as text, already in the OS's
 * language.
 */
export function describeError(error: unknown): string {
  const text = String(error);
  if (!text.startsWith("{")) return text;
  let problem: Record<string, string | number>;
  try {
    problem = JSON.parse(text);
  } catch {
    return text;
  }
  const key = `error.${problem.code}` as MessageKey;
  if (!(key in en)) return text;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(problem)) {
    params[name] = typeof value === "number" ? formatNumber(value) : value;
  }
  if (problem.encoding) params.encoding = ENCODING_LABEL[problem.encoding as Encoding];
  return t(key, params);
}
