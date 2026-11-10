// The file types offered by the open and save dialogs. Any text file opens, so
// these only narrow what the dialog shows; the languages come from where they
// are highlighted.

import { t } from "./i18n";
import { codeFileTypes } from "./languages";
import { ABAQUS_EXT, EITHER_SOLVER_EXT, LANG_LABEL, NASTRAN_EXT } from "./syntax";

export interface FileType {
  name: string;
  extensions: string[];
}

/** What the solvers write that is text: Nastran's output, log and punch file, Abaqus's messages and status. */
const SOLVER_OUTPUT_EXT = ["f06", "f04", "pch", "msg", "sta"];
const TEXT_EXT = ["txt", "log"];

/** For opening: all files first, as any of them may be text. */
export const openTypes = (): FileType[] => [
  { name: t("filter.all"), extensions: ["*"] },
  { name: t("filter.solver"), extensions: [...ABAQUS_EXT, ...NASTRAN_EXT, ...EITHER_SOLVER_EXT] },
  { name: LANG_LABEL.abaqus, extensions: [...ABAQUS_EXT, ...EITHER_SOLVER_EXT] },
  { name: LANG_LABEL.nastran, extensions: [...NASTRAN_EXT, ...EITHER_SOLVER_EXT] },
  { name: t("filter.output"), extensions: SOLVER_OUTPUT_EXT },
  { name: t("filter.text"), extensions: TEXT_EXT },
  ...codeFileTypes(),
];

/**
 * For saving as `path`: first the narrowest type of its extension, that
 * extension first. Windows picks the first type and adds its first extension
 * to a name typed without one, so all files cannot come first: Windows would
 * add ".*". A name of no known type gets no types, and so nothing added.
 */
export function saveTypes(path: string): FileType[] {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1].toLowerCase() ?? "";
  const types = openTypes();
  const own = types
    .filter((type) => ext && type.extensions.includes(ext))
    .reduce<FileType | null>((best, type) => (best && best.extensions.length <= type.extensions.length ? best : type), null);
  if (!own) return [];
  return [{ ...own, extensions: [ext, ...own.extensions.filter((one) => one !== ext)] }, ...types.filter((type) => type !== own)];
}
