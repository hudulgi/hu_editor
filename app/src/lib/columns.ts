// Display columns for box selection: Hangul, CJK and full-width forms take
// two cells in a monospaced font, and tabs run to the next stop. Mirrors
// `char_width` and `column_range` in crates/hu-core/src/decode.rs.

export const TAB = 8;

export function charWidth(code: number): number {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
}

/** Walks the characters of `text`: UTF-16 index, display column, width. */
function* cells(text: string) {
  let col = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    const width = code === 9 ? TAB - (col % TAB) : charWidth(code);
    yield { index: i, col, width };
    col += width;
    i += code > 0xffff ? 2 : 1;
  }
}

/** Display column where UTF-16 index `index` of `text` starts. */
export function displayCol(text: string, index: number): number {
  let end = 0;
  for (const cell of cells(text)) {
    if (cell.index >= index) return cell.col;
    end = cell.col + cell.width;
  }
  return end;
}

export const textWidth = (text: string) => displayCol(text, text.length);

/**
 * UTF-16 index for display column `target`. A left edge takes the first
 * character overlapping it or after it, a right edge the first character at
 * or after it, so a box widens to whole characters.
 */
export function indexAt(text: string, target: number, edge: "left" | "right"): number {
  for (const { index, col, width } of cells(text)) {
    if (edge === "left" ? col + width > target : col >= target) return index;
  }
  return text.length;
}
