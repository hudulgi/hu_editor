// Finds what a line starts inside of (a block comment, a multi-line string) for
// a line anywhere in a file, when only the lines on screen are at hand: reads the
// file from the nearest line whose state is known, and remembers what it passes.

import * as api from "./api";
import { scanLine, type CodeLang, type LineState } from "./languages";

/** Further into a file than this, what is on screen starts afresh: huge files are not read just to color them. */
const MAX_SCAN = 16 << 20;
const MAX_BATCH = 2000;
/** A rough guess, only to size the requests. */
const BYTES_PER_LINE = 40;
/** How often to remember a state while reading, so that coming back is short. */
const KEEP_EVERY = 64;
const MAX_KEPT = 20000;

export class LineStates {
  /** By ascending offset; every offset is the start of a line. */
  private known: { offset: number; state: LineState }[] = [{ offset: 0, state: null }];
  /** Counts the edits, so that what was read before one is not taken for current. */
  generation = 0;

  constructor(
    private id: number,
    private lang: CodeLang,
  ) {}

  /** The last known position at or before `offset`. */
  private nearest(offset: number) {
    let low = 0;
    let high = this.known.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.known[middle].offset <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** The state at a line start, as known now: a guess from the nearest line above if not known exactly. */
  peek(offset: number): LineState {
    return offset > MAX_SCAN ? null : this.known[this.nearest(offset)].state;
  }

  knows(offset: number) {
    return offset > MAX_SCAN || this.known[this.nearest(offset)].offset === offset;
  }

  note(offset: number, state: LineState) {
    if (offset > MAX_SCAN) return;
    const at = this.nearest(offset);
    if (this.known[at].offset === offset) {
      this.known[at].state = state;
      return;
    }
    this.known.splice(at + 1, 0, { offset, state });
    if (this.known.length > MAX_KEPT) this.known = this.known.filter((_, i) => i === 0 || i % 2 === 0);
  }

  /** The text from `offset` on changed: what is known past it no longer holds. */
  invalidate(offset: number) {
    this.generation++;
    this.known.length = this.nearest(offset) + 1;
  }

  /** Finds the state at the line start `offset`; false if the file changed meanwhile. */
  async find(offset: number): Promise<boolean> {
    if (this.knows(offset)) return true;
    const generation = this.generation;
    let { offset: from, state } = this.known[this.nearest(offset)];
    while (from < offset) {
      const rows = Math.max(64, Math.min(MAX_BATCH, Math.ceil((offset - from) / BYTES_PER_LINE)));
      const view = await api.view(this.id, { kind: "offset", offset: from, context: 0 }, rows);
      if (generation !== this.generation) return false;
      let count = 0;
      for (let i = 0; i < view.lines.length; i++) {
        const line = view.lines[i];
        // Near the end of the file a view starts earlier, to fill the rows.
        if (line.offset < from) continue;
        if (line.offset >= offset) break;
        state = scanLine(this.lang, line.text, state).state;
        const next = view.lines[i + 1];
        if (next && ++count % KEEP_EVERY === 0) this.note(next.offset, state);
      }
      if (view.end >= view.len || view.end > offset || view.end <= from) break;
      this.note(view.end, state);
      from = view.end;
    }
    this.note(offset, state);
    return true;
  }
}
