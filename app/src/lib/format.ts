const number = new Intl.NumberFormat("en-US");

export const formatNumber = (n: number) => number.format(n);

export function formatSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const isWindows = navigator.userAgent.includes("Windows");

/** Whether two paths name the same file (case-insensitively on Windows). */
export const samePath = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Name of the folder containing `path`. */
export function parentName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 2] ?? "";
}

/** Last component of a Windows or POSIX path. */
export function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const SEPARATOR = isWindows ? "\\" : "/";

/** The folder `path` is in: `C:\` for `C:\deck.inp`, `/` for `/deck.inp`. */
export function dirName(path: string) {
  if (/^([A-Za-z]:)?[\\/]*$/.test(path)) return path;
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return trimmed;
  const head = trimmed.slice(0, cut);
  // A root keeps its separator.
  return head === "" || /^[A-Za-z]:$/.test(head) ? trimmed.slice(0, cut + 1) : head;
}

/** `name` in the folder `dir`. */
export const joinPath = (dir: string, name: string) => (/[\\/]$/.test(dir) ? dir + name : dir + SEPARATOR + name);

/** Where `path` is after `from` moved to `to`, if it was `from` or in it. */
export function movedPath(path: string, from: string, to: string) {
  if (samePath(path, from)) return to;
  const prefix = path.slice(0, from.length);
  return samePath(prefix, from) && /^[\\/]/.test(path.slice(from.length)) ? to + path.slice(from.length) : null;
}

/**
 * `path` as seen from the folder `from`, as an `*INCLUDE` wants it; null
 * across Windows drives, where there is no way from one to the other.
 */
export function relativePath(from: string, path: string) {
  const parts = (p: string) => p.split(/[\\/]+/).filter(Boolean);
  const [a, b] = [parts(from), parts(path)];
  let common = 0;
  while (common < a.length && common < b.length && samePath(a[common], b[common])) common++;
  if (isWindows && common === 0) return null;
  const up = Array<string>(a.length - common).fill("..");
  return [...up, ...b.slice(common)].join(SEPARATOR) || ".";
}
