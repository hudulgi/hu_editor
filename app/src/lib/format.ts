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
