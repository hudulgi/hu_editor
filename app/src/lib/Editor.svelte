<script lang="ts" module>
  /** Caret line (null until the index has reached it), column, selected bytes, box size. */
  export interface CaretInfo {
    line: number | null;
    col: number;
    selected: number;
    /** Box selection size; `rows` is null when the box reaches off screen. */
    box: { rows: number | null; cols: number } | null;
    columnMode: boolean;
    /** The field the caret is in, with rainbow columns on; see `fieldAt`. */
    field: number | null;
  }
</script>

<script lang="ts">
  // The text editor. Only the visible lines live here; the caret, the
  // selection and the viewport are byte offsets into the document, so
  // scrolling, jumping and editing all work before the line index is done.
  // The scrollbar is drawn by hand because a browser element cannot be tall
  // enough for millions of lines (~33.5 M px limit).
  //
  // Keys and text go to a hidden textarea at the caret, which also hosts IME
  // composition (Korean). Every key runs through one queue, so fast typing
  // never races the backend.

  import { onMount, tick, untrack } from "svelte";
  import * as api from "./api";
  import { displayCol, indexAt, TAB, textWidth } from "./columns";
  import { describeError, t } from "./i18n";
  import { fontStack, lineHeight, settings } from "./settings.svelte";
  import { dependsOnLinesAbove, isCodeLang } from "./languages";
  import { LineStates } from "./lineStates";
  import { applyMarks, fieldAt, fieldRange, findMatches, tokenizeLines, type Lang, type Mark } from "./syntax";

  interface Props {
    doc: api.DocInfo;
    lang: Lang;
    /** Bytes the line index has covered so far. */
    indexed: number;
    /** Lines known so far, for the gutter width. */
    lines: number;
    /** What the find bar is looking for: its matches on screen stand out, and its scope. */
    highlight?: api.Query | null;
    /** Where something covers the text (the find bar): a match found is scrolled clear of it. */
    covered?: () => DOMRect | null;
    onview?: (view: api.View) => void;
    oncaret?: (caret: CaretInfo) => void;
    /** A right click in the text, at this point. */
    oncontext?: (x: number, y: number) => void;
    /** A change made here. */
    onedit?: (result: api.EditResult) => void;
    onerror?: (message: string) => void;
  }

  let { doc, lang, indexed, lines, highlight = null, covered, onview, oncaret, oncontext, onedit, onerror }: Props = $props();

  const MIN_THUMB = 24;
  const WORD = /[\p{L}\p{N}_.]/u;

  let root: HTMLDivElement;
  let scroller: HTMLDivElement;
  let lineBox = $state<HTMLDivElement>();
  let input: HTMLTextAreaElement;
  let height = $state(0);
  let trackH = $state(0);
  let lineH = $derived(lineHeight(settings.fontSize));
  let rows = $state(1);
  // A hidden editor (another tab is showing) has no height: keep its rows
  // rather than shrinking the view to one line.
  $effect(() => {
    if (height > 0) rows = Math.max(1, Math.floor(height / lineH));
  });
  let view = $state<api.View | null>(null);
  let viewError = $state<string | null>(null);

  let caret = $state(0);
  let anchor = $state(0);
  let selStart = $derived(Math.min(anchor, caret));
  let selEnd = $derived(Math.max(anchor, caret));
  /** Column kept while moving up and down through shorter lines. */
  let preferredCol: number | null = null;
  let focused = $state(false);
  let composing = $state(false);
  let composition = $state("");
  let caretAt = $state<{ x: number; y: number } | null>(null);
  let blink = $state(0);

  // Box (column) selection. A corner is a line (its start offset) and a
  // display column, so the box stays rectangular past line ends and across
  // two-column Hangul.
  interface Box {
    anchorLine: number;
    anchorCol: number;
    caretLine: number;
    caretCol: number;
  }
  let box = $state<Box | null>(null);
  /** Alt+C: plain Shift+arrows and dragging select boxes (UltraEdit's column mode). */
  let columnMode = $state(false);
  let boxTop = $derived(box ? Math.min(box.anchorLine, box.caretLine) : 0);
  let boxBottom = $derived(box ? Math.max(box.anchorLine, box.caretLine) : 0);
  let boxLeft = $derived(box ? Math.min(box.anchorCol, box.caretCol) : 0);
  let boxRight = $derived(box ? Math.max(box.anchorCol, box.caretCol) : 0);
  let boxRects = $state<{ x: number; y: number; w: number }[]>([]);
  /** Width of one column in pixels, for the space past line ends. */
  let cellW = $state(8);

  // ---- Viewport requests ----------------------------------------------
  // One request in flight; scrolling meanwhile is merged into the next one,
  // so fast wheels and drags never queue up.

  let inflight = false;
  let pendingDelta = 0;
  let pendingJump: api.ViewTarget | null = null;
  let pendingRefresh = false;
  let waiters: (() => void)[] = [];

  function pump() {
    if (inflight) return;
    let target: api.ViewTarget;
    if (pendingJump) {
      target = pendingJump;
      pendingJump = null;
    } else if (pendingDelta !== 0 || pendingRefresh) {
      target = { kind: "scroll", anchor: view?.top ?? 0, delta: pendingDelta };
      pendingDelta = 0;
    } else {
      const done = waiters;
      waiters = [];
      done.forEach((resolve) => resolve());
      return;
    }
    pendingRefresh = false;
    inflight = true;
    const id = doc.id;
    const asked = lineStates?.generation;
    api
      .view(id, target, rows)
      .then(
        (next) => {
          if (id !== doc.id) return;
          viewIsCurrent = asked === lineStates?.generation;
          view = next;
          viewError = null;
          onview?.(next);
        },
        (e) => (viewError = describeError(e)),
      )
      .finally(() => {
        inflight = false;
        pump();
      });
  }

  /** Resolves once every requested view has arrived. */
  function settled() {
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
      pump();
    });
  }

  export function scrollLines(delta: number) {
    if (delta === 0) return;
    pendingDelta += delta;
    pump();
  }

  export function jump(target: api.ViewTarget) {
    pendingJump = target;
    pendingDelta = 0;
    pump();
  }

  export function refresh() {
    pendingRefresh = true;
    pump();
  }

  // ---- Lines and columns ----------------------------------------------
  // Columns are UTF-16 indices into a line's text; `charStarts` maps them to
  // bytes for non-ASCII lines.

  type Line = api.ViewLine;

  function rowOf(offset: number) {
    return view ? view.lines.findIndex((l) => offset >= l.offset && offset <= l.offset + l.len) : -1;
  }

  /** Column of byte `offset` (the character starting there or containing it). */
  function colOf(line: Line, offset: number) {
    const rel = offset - line.offset;
    if (!line.charStarts) return Math.min(rel, line.text.length);
    const starts = line.charStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < rel) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function offsetOf(line: Line, col: number) {
    col = Math.max(0, Math.min(col, line.text.length));
    return line.offset + (line.charStarts ? line.charStarts[col] : col);
  }

  /** Byte offset of the character before / after byte `rel` of the line. */
  function prevChar(line: Line, rel: number) {
    if (!line.charStarts) return rel - 1;
    return line.charStarts.findLast((s) => s < rel) ?? 0;
  }

  function nextChar(line: Line, rel: number) {
    if (!line.charStarts) return rel + 1;
    return line.charStarts.find((s) => s > rel) ?? line.len;
  }

  const isWord = (c: string | undefined) => c !== undefined && WORD.test(c);

  function wordStart(text: string, col: number) {
    while (col > 0 && !isWord(text[col - 1])) col--;
    while (col > 0 && isWord(text[col - 1])) col--;
    return col;
  }

  function wordEnd(text: string, col: number) {
    while (col < text.length && !isWord(text[col])) col++;
    while (col < text.length && isWord(text[col])) col++;
    return col;
  }

  /** The line at `row`, scrolling a line when `row` is just outside the view. */
  async function lineAt(row: number): Promise<Line | null> {
    if (!view) return null;
    if (row >= 0 && row < view.lines.length) return view.lines[row];
    // Found by offset after scrolling: the view may have changed size meanwhile.
    if (row < 0) {
      if (view.top === 0) return null;
      const first = view.lines[0].offset;
      scrollLines(-1);
      await settled();
      return view.lines.findLast((l) => l.offset < first) ?? null;
    }
    const last = view.lines[view.lines.length - 1];
    if (last.offset + last.len >= view.len) return null;
    scrollLines(1);
    await settled();
    return view.lines.find((l) => l.offset > last.offset) ?? null;
  }

  // ---- Caret movement -------------------------------------------------

  /** Brings the caret line into view. */
  async function revealCaret(context?: number) {
    await settled();
    if (!view || rowOf(caret) >= 0) return;
    const above = caret < view.top;
    jump({ kind: "offset", offset: caret, context: context ?? (above ? 0 : rows - 1) });
    await settled();
  }

  async function moveTo(offset: number, extend: boolean, keepColumn = false) {
    caret = offset;
    if (!extend) anchor = offset;
    if (!keepColumn) preferredCol = null;
    await revealCaret();
  }

  /** Runs `motion` from a visible caret, then moves there. */
  async function motion(target: (line: Line, row: number) => Promise<number> | number, extend: boolean, keepColumn = false) {
    await revealCaret();
    const row = rowOf(caret);
    if (!view || row < 0) return;
    await moveTo(await target(view.lines[row], row), extend, keepColumn);
  }

  async function horizontal(line: Line, row: number, dir: -1 | 1, word: boolean, extend: boolean) {
    // Without Shift, Left/Right first collapse a selection to its edge.
    if (!extend && selStart !== selEnd) return dir < 0 ? selStart : selEnd;
    const rel = caret - line.offset;
    const col = colOf(line, caret);
    if (dir < 0) {
      if (rel > 0) return word ? offsetOf(line, wordStart(line.text, col)) : line.offset + prevChar(line, rel);
      const prev = await lineAt(row - 1);
      return prev ? prev.offset + prev.len : caret;
    }
    if (rel < line.len) return word ? offsetOf(line, wordEnd(line.text, col)) : line.offset + nextChar(line, rel);
    const next = await lineAt(row + 1);
    return next ? next.offset : caret;
  }

  async function vertical(line: Line, row: number, delta: -1 | 1) {
    const col = (preferredCol ??= colOf(line, caret));
    const target = await lineAt(row + delta);
    if (!target) return delta < 0 ? line.offset : line.offset + line.len;
    return offsetOf(target, col);
  }

  async function page(line: Line, row: number, dir: -1 | 1) {
    const col = (preferredCol ??= colOf(line, caret));
    const before = view!.top;
    scrollLines(dir * Math.max(1, rows - 1));
    await settled();
    const v = view!;
    const r = v.top === before ? (dir < 0 ? 0 : v.lines.length - 1) : Math.min(row, v.lines.length - 1);
    return offsetOf(v.lines[r], col);
  }

  /** Home goes to the first non-blank character, then to the line start. */
  function home(line: Line) {
    const first = line.text.search(/\S/);
    const indent = first < 0 ? line.text.length : first;
    return offsetOf(line, colOf(line, caret) === indent ? 0 : indent);
  }

  // ---- Editing ----------------------------------------------------------

  /** Moves an offset past an edit. */
  function shift(offset: number, c: api.Change) {
    if (offset <= c.start) return offset;
    if (offset >= c.start + c.oldLen) return offset - c.oldLen + c.newLen;
    return c.start;
  }

  async function applied(result: api.EditResult) {
    onedit?.(result);
    lineStates?.invalidate(result.change.start);
    if (view) jump({ kind: "scroll", anchor: shift(view.top, result.change), delta: 0 });
    anchor = result.anchor;
    caret = result.caret;
    preferredCol = null;
    await revealCaret();
  }

  async function replace(start: number, end: number, text: string, kind: api.EditKind) {
    await applied(await api.edit(doc.id, start, end, text, kind, anchor, caret));
  }

  function insert(text: string, kind: api.EditKind) {
    return replace(selStart, selEnd, text, kind);
  }

  async function backspace(word: boolean) {
    if (selStart !== selEnd) return replace(selStart, selEnd, "", "other");
    await revealCaret();
    const row = rowOf(caret);
    if (!view || row < 0) return;
    const line = view.lines[row];
    const rel = caret - line.offset;
    if (rel > 0) {
      const from = word ? offsetOf(line, wordStart(line.text, colOf(line, caret))) : line.offset + prevChar(line, rel);
      return replace(from, caret, "", "backspace");
    }
    const prev = await lineAt(row - 1);
    // Joins with the line above: removes its line break, LF or CRLF.
    if (prev) await replace(prev.offset + prev.len, caret, "", "backspace");
  }

  async function deleteForward(word: boolean) {
    if (selStart !== selEnd) return replace(selStart, selEnd, "", "other");
    await revealCaret();
    const row = rowOf(caret);
    if (!view || row < 0) return;
    const line = view.lines[row];
    const rel = caret - line.offset;
    if (rel < line.len) {
      const to = word ? offsetOf(line, wordEnd(line.text, colOf(line, caret))) : line.offset + nextChar(line, rel);
      return replace(caret, to, "", "delete");
    }
    const next = await lineAt(row + 1);
    if (next) await replace(caret, next.offset, "", "delete");
  }

  /** What the Tab key inserts at column `col`. */
  function tabText(col: number) {
    return settings.tabSpaces ? " ".repeat(settings.tabSize - (col % settings.tabSize)) : "\t";
  }

  async function tab() {
    await revealCaret();
    const row = rowOf(caret);
    if (!view || row < 0) return;
    const col = colOf(view.lines[row], selStart);
    await insert(tabText(col), "typing");
  }

  /** The selection, or the caret's whole line like VSCode when nothing is selected. */
  async function copyRange(): Promise<[number, number] | null> {
    if (selStart !== selEnd) return [selStart, selEnd];
    await revealCaret();
    const row = rowOf(caret);
    if (!view || row < 0) return null;
    const line = view.lines[row];
    const next = await lineAt(row + 1);
    return [line.offset, next ? next.offset : line.offset + line.len];
  }

  async function copy(cut: boolean) {
    const range = await copyRange();
    if (!range) return;
    await api.copy(doc.id, ...range);
    if (cut) {
      anchor = range[0];
      caret = range[1];
      await replace(range[0], range[1], "", "other");
    }
  }

  async function history(redo: boolean) {
    const result = await (redo ? api.redo : api.undo)(doc.id);
    if (result) await applied(result);
  }

  // ---- Box selection ------------------------------------------------------

  const lineRow = (start: number) => (view ? view.lines.findIndex((l) => l.offset === start) : -1);

  /** Starts a box at the caret, unless there is one. */
  function startBox() {
    if (box) return;
    const row = rowOf(caret);
    if (!view || row < 0) return;
    const line = view.lines[row];
    const col = displayCol(line.text, colOf(line, caret));
    box = { anchorLine: line.offset, anchorCol: col, caretLine: line.offset, caretCol: col };
  }

  /** Leaves box mode, with the caret where the box's caret corner was. */
  function endBox() {
    if (!box) return;
    const row = lineRow(box.caretLine);
    const line = row >= 0 ? view!.lines[row] : null;
    anchor = caret = line ? offsetOf(line, indexAt(line.text, box.caretCol, "left")) : box.caretLine;
    preferredCol = null;
    box = null;
  }

  async function boxMove(dx: number, dy: number) {
    startBox();
    if (!box || !view) return;
    box.caretCol = Math.max(0, box.caretCol + dx);
    if (!dy) return;
    if (lineRow(box.caretLine) < 0) {
      jump({ kind: "offset", offset: box.caretLine, context: dy < 0 ? 0 : rows - 1 });
      await settled();
    }
    const row = lineRow(box.caretLine);
    const next = row >= 0 ? await lineAt(row + dy) : null;
    if (next && box) box.caretLine = next.offset;
  }

  /**
   * Replaces columns `[left, right)` of every box line with `texts` (one for
   * all lines, or one per line), leaving a zero-width box at column `col`.
   */
  async function boxEdit(
    texts: string[],
    kind: api.EditKind,
    left: number,
    right: number,
    col: number,
    rowsOf: api.BoxRows = { kind: "until", bottom: boxBottom },
  ) {
    if (!box) return;
    const top = boxTop;
    const topIsAnchor = box.anchorLine <= box.caretLine;
    const edited = await api.editBox(doc.id, top, rowsOf, left, right, texts, kind, anchor, caret);
    if (!edited) return;
    onedit?.(edited.result);
    lineStates?.invalidate(edited.result.change.start);
    if (view) jump({ kind: "scroll", anchor: shift(view.top, edited.result.change), delta: 0 });
    const [anchorLine, caretLine] = topIsAnchor ? [top, edited.lastLine] : [edited.lastLine, top];
    box = { anchorLine, caretLine, anchorCol: col, caretCol: col };
    anchor = caret = edited.result.caret;
    await settled();
  }

  function boxInsert(text: string, kind: api.EditKind) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 1) return boxEdit(lines, kind, boxLeft, boxRight, boxLeft + textWidth(lines[0]));
    // A block of lines goes in line by line from the top, like UltraEdit.
    const width = Math.max(...lines.map(textWidth));
    return boxEdit(lines, "other", boxLeft, boxRight, boxLeft + width, { kind: "count", count: lines.length });
  }

  function boxTab() {
    const left = boxLeft;
    if (settings.tabSpaces) return boxInsert(tabText(left), "typing");
    return boxEdit(["\t"], "typing", left, boxRight, left + TAB - (left % TAB));
  }

  function boxDelete(back: boolean) {
    if (boxLeft < boxRight) return boxEdit([""], "other", boxLeft, boxRight, boxLeft);
    if (back) return boxLeft > 0 ? boxEdit([""], "other", boxLeft - 1, boxLeft, boxLeft - 1) : undefined;
    return boxEdit([""], "other", boxLeft, boxLeft + 1, boxLeft);
  }

  async function boxCopy(cut: boolean) {
    if (boxLeft === boxRight) return;
    await api.copyBox(doc.id, boxTop, boxBottom, boxLeft, boxRight);
    if (cut) await boxDelete(true);
  }

  /** Line start and display column under a point; past a line's end counts columns of space. */
  function boxPoint(clientX: number, clientY: number) {
    if (!view?.lines.length || !lineBox) return null;
    const top = lineBox.getBoundingClientRect().top;
    const row = Math.max(0, Math.min(view.lines.length - 1, Math.floor((clientY - top) / lineH)));
    const line = view.lines[row];
    const el = lineBox.children[row] as HTMLElement;
    const x = insideText(clientX) - el.getBoundingClientRect().left;
    const end = xAt(el, line.text.length);
    if (x >= end) return { line: line.offset, col: textWidth(line.text) + Math.round((x - end) / cellW) };
    return { line: line.offset, col: displayCol(line.text, colOf(line, offsetAt(clientX, clientY)!)) };
  }

  /** Box keys; `false` when the key should get its normal meaning. */
  function boxKey(e: KeyboardEvent, mod: boolean): boolean {
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (e.key in arrows && e.shiftKey && !mod && (e.altKey || columnMode)) {
      const [dx, dy] = arrows[e.key];
      enqueue(() => boxMove(dx, dy));
      return true;
    }
    if (!box) return false;
    const key = e.key.toLowerCase();
    let task: (() => unknown) | null = null;
    if (e.key === "Backspace" || e.key === "Delete") task = () => boxDelete(e.key === "Backspace");
    else if (e.key === "Tab" && !mod) task = boxTab;
    else if (e.key === "Escape") task = endBox;
    else if (mod && (key === "c" || key === "x")) task = () => boxCopy(key === "x");
    // Modifiers alone, typed characters (input event), paste (paste event)
    // and the app's own shortcuts keep the box.
    else if (["Shift", "Alt", "Control", "Meta"].includes(e.key)) return true;
    else if (!mod && e.key.length === 1) return false;
    else if (mod && !["z", "y", "a"].includes(key)) return false;
    else {
      endBox();
      return false;
    }
    enqueue(task);
    return true;
  }

  // ---- Input ----------------------------------------------------------

  let queue: Promise<unknown> = Promise.resolve();

  function enqueue(task: () => unknown) {
    queue = queue.then(task).catch((e) => onerror?.(describeError(e)));
  }

  /** The Selection menu's keys, VS Code's, with Ctrl added where its own are the box's (Alt+Shift+arrows). */
  function selectionKey(e: KeyboardEvent, mod: boolean): (() => unknown) | null {
    const vertical = e.key === "ArrowUp" || e.key === "ArrowDown";
    const up = e.key === "ArrowUp";
    if (vertical && e.altKey && !mod && !e.shiftKey) return () => moveLines(up);
    if (vertical && e.altKey && mod && e.shiftKey) return () => copyLines(up);
    if (vertical && e.altKey && mod && !e.shiftKey) return () => addCursor(up ? -1 : 1);
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.altKey && mod && e.shiftKey) {
      return e.key === "ArrowRight" ? expandSelection : shrinkSelection;
    }
    if (mod && !e.altKey && !e.shiftKey && e.code === "KeyD") return duplicate;
    return null;
  }

  function onkeydown(e: KeyboardEvent) {
    // While composing, the IME owns the keys.
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const selecting = selectionKey(e, mod);
    if (selecting) {
      e.preventDefault();
      e.stopPropagation();
      selecting();
      return;
    }
    // Ctrl+Alt belongs to the app, or is AltGr typing a character.
    if (mod && e.altKey) return;
    // Alt+C toggles column mode; `code`, since Option+C types ç on a Mac.
    if (e.altKey && !mod && e.code === "KeyC") {
      columnMode = !columnMode;
      e.preventDefault();
      return;
    }
    if (boxKey(e, mod)) {
      e.preventDefault();
      e.stopPropagation();
      blink++;
      return;
    }
    const ext = e.shiftKey;
    let task: (() => unknown) | null = null;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        task = () => motion((line, row) => horizontal(line, row, dir, mod, ext), ext);
        break;
      }
      case "ArrowUp":
      case "ArrowDown": {
        const dir = e.key === "ArrowUp" ? -1 : 1;
        task = mod ? () => scrollLines(dir) : () => motion((line, row) => vertical(line, row, dir), ext, true);
        break;
      }
      case "PageUp":
      case "PageDown": {
        if (mod) return;
        const dir = e.key === "PageUp" ? -1 : 1;
        task = () => motion((line, row) => page(line, row, dir), ext, true);
        break;
      }
      case "Home":
        task = mod ? () => moveTo(0, ext) : () => motion(home, ext);
        break;
      case "End":
        task = mod ? () => moveTo(view?.len ?? 0, ext) : () => motion((line) => line.offset + line.len, ext);
        break;
      case "Backspace":
        task = () => backspace(mod);
        break;
      case "Delete":
        task = () => deleteForward(mod);
        break;
      case "Enter":
        task = () => insert("\n", "other");
        break;
      case "Tab":
        if (mod) return;
        task = tab;
        break;
      case "Escape":
        if (selStart === selEnd) return;
        task = () => (anchor = caret);
        break;
      default: {
        if (!mod || e.altKey) return;
        const key = e.key.toLowerCase();
        if (key === "a") task = selectEverything;
        else if (key === "c" || key === "x") task = () => copy(key === "x");
        else if (key === "z") task = () => history(e.shiftKey);
        else if (key === "y") task = () => history(true);
        // Ctrl+V arrives as a paste event; other shortcuts belong to the app.
        else return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
    blink++;
    enqueue(task);
  }

  /** Inserts whatever the textarea collected (typed text or an IME result). */
  function flushInput() {
    const text = input.value;
    if (!text) return;
    input.value = "";
    blink++;
    enqueue(() => (box ? boxInsert(text, "typing") : insert(text, "typing")));
  }

  function oninput(e: Event) {
    if (!composing && !(e as InputEvent).isComposing) flushInput();
  }

  function onpaste(e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain");
    if (text) paste(text);
  }

  // ---- Mouse ------------------------------------------------------------

  function caretPoint(x: number, y: number): { node: Node; offset: number } | null {
    const d = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    if (d.caretPositionFromPoint) {
      const p = d.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = d.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }

  /** Left of the text, in the margin or over the line numbers, counts as the first column in view. */
  function insideText(clientX: number) {
    return Math.max(clientX, scroller.getBoundingClientRect().left + scroller.clientLeft);
  }

  /** Document offset under a point, clamped to the visible lines. */
  function offsetAt(clientX: number, clientY: number) {
    if (!view?.lines.length || !lineBox) return null;
    const box = lineBox.getBoundingClientRect();
    const row = Math.max(0, Math.min(view.lines.length - 1, Math.floor((clientY - box.top) / lineH)));
    const line = view.lines[row];
    const el = lineBox.children[row] as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = insideText(clientX);
    const point = caretPoint(x, rect.top + lineH / 2);
    if (!point || !el.contains(point.node)) return offsetOf(line, x <= rect.left ? 0 : line.text.length);
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEnd(point.node, point.offset);
    return offsetOf(line, range.toString().length);
  }

  let dragging: "text" | "box" | null = null;
  let dragPoint = { x: 0, y: 0 };
  let autoScroll: ReturnType<typeof setInterval> | undefined;

  // Mouse events rather than pointer events: `detail` counts clicks reliably.
  function onmousedown(e: MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    input.focus({ preventScroll: true });
    blink++;
    if (e.altKey || columnMode) {
      const point = boxPoint(e.clientX, e.clientY);
      if (!point) return;
      const extend = e.shiftKey;
      enqueue(() => {
        if (box && extend) Object.assign(box, { caretLine: point.line, caretCol: point.col });
        else box = { anchorLine: point.line, anchorCol: point.col, caretLine: point.line, caretCol: point.col };
      });
      startDrag("box");
      return;
    }
    const offset = offsetAt(e.clientX, e.clientY);
    if (offset === null) return;
    const clicks = e.detail;
    const extend = e.shiftKey;
    box = null;
    enqueue(() => {
      if (clicks === 2) selectWord(offset);
      else if (clicks >= 3) selectLine(offset);
      else {
        caret = offset;
        if (!extend) anchor = offset;
        preferredCol = null;
      }
    });
    if (clicks <= 1) startDrag("text");
  }

  /** A right click outside the selection moves the caret there first, as in VS Code. */
  function oncontextmenu(e: MouseEvent) {
    e.preventDefault();
    if (!box) {
      const offset = offsetAt(e.clientX, e.clientY);
      if (offset !== null && (offset < selStart || offset > selEnd)) {
        enqueue(() => {
          caret = anchor = offset;
          preferredCol = null;
        });
      }
    }
    oncontext?.(e.clientX, e.clientY);
  }

  function startDrag(kind: "text" | "box") {
    dragging = kind;
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", endDrag, { once: true });
  }

  function onDragMove(e: MouseEvent) {
    dragPoint = { x: e.clientX, y: e.clientY };
    // Past the top or bottom edge, keep scrolling while the button is held.
    const box = scroller.getBoundingClientRect();
    const dir = e.clientY < box.top ? -1 : e.clientY > box.bottom ? 1 : 0;
    clearInterval(autoScroll);
    if (dir) {
      autoScroll = setInterval(() => {
        scrollLines(dir);
        settled().then(dragTo);
      }, 50);
    }
    dragTo();
  }

  function dragTo() {
    if (dragging === "box") {
      const point = boxPoint(dragPoint.x, dragPoint.y);
      if (point && box) Object.assign(box, { caretLine: point.line, caretCol: point.col });
      return;
    }
    const offset = offsetAt(dragPoint.x, dragPoint.y);
    if (dragging && offset !== null) caret = offset;
  }

  function endDrag() {
    dragging = null;
    clearInterval(autoScroll);
    window.removeEventListener("mousemove", onDragMove);
  }

  /** Selects the word, run of blanks, or run of punctuation at `offset`. */
  function selectWord(offset: number) {
    const row = rowOf(offset);
    if (!view || row < 0) return;
    const line = view.lines[row];
    const text = line.text;
    const col = colOf(line, offset);
    const at = col < text.length ? col : col - 1;
    if (at < 0) return;
    const kind = (c: string) => (isWord(c) ? 0 : /\s/.test(c) ? 1 : 2);
    const k = kind(text[at]);
    let a = at;
    let b = at + 1;
    while (a > 0 && kind(text[a - 1]) === k) a--;
    while (b < text.length && kind(text[b]) === k) b++;
    anchor = offsetOf(line, a);
    caret = offsetOf(line, b);
  }

  function selectLine(offset: number) {
    const row = rowOf(offset);
    if (!view || row < 0) return;
    const line = view.lines[row];
    anchor = line.offset;
    caret = view.lines[row + 1]?.offset ?? line.offset + line.len;
  }

  // ---- For the app ------------------------------------------------------

  // The browser would scroll to the hidden input; where the text stands is up to `placeCaret`.
  export function focus() {
    input?.focus({ preventScroll: true });
  }

  function selectEverything() {
    anchor = 0;
    caret = view?.len ?? 0;
  }

  // The Edit menu: what the keys do, reached without them.

  export function undo(redo = false) {
    endBox();
    enqueue(() => history(redo));
  }

  export function copySelection(cut: boolean) {
    enqueue(() => (box ? boxCopy(cut) : copy(cut)));
  }

  export function paste(text: string) {
    enqueue(() => (box ? boxInsert(text, "other") : insert(text, "other")));
  }

  export function selectAll() {
    endBox();
    enqueue(selectEverything);
  }

  export function toggleColumnMode() {
    columnMode = !columnMode;
  }

  /** Resolves once every key and edit queued so far has been applied. */
  export async function flush() {
    await queue;
    await settled();
  }

  /** Selection as `[anchor, caret]`. */
  export function selection(): [number, number] {
    return [anchor, caret];
  }

  /** The selection's line and columns, if it lies on one visible line. */
  function selectionInLine(): { line: string; from: number; to: number } | null {
    if (!view || box || selStart === selEnd) return null;
    const row = rowOf(selStart);
    if (row < 0) return null;
    const line = view.lines[row];
    const end = colOf(line, selEnd);
    // Short of the selection's end: it goes on to another line, or past what a long line shows.
    return offsetOf(line, end) === selEnd ? { line: line.text, from: colOf(line, selStart), to: end } : null;
  }

  function selectedText() {
    const sel = selectionInLine();
    return sel && sel.line.slice(sel.from, sel.to);
  }

  /**
   * What the keyboard user means to search for: the selected text, or with
   * `orWord` the word at the caret, which then gets selected. A box on one
   * line becomes a plain selection, which a search can go on from.
   */
  export function findSeed(orWord = false): string | null {
    if (!focused || !view) return null;
    if (box && boxTop === boxBottom) {
      const row = lineRow(boxTop);
      const line = row >= 0 ? view.lines[row] : null;
      if (line && indexAt(line.text, boxLeft, "left") < indexAt(line.text, boxRight, "right")) {
        anchor = offsetOf(line, indexAt(line.text, boxLeft, "left"));
        caret = offsetOf(line, indexAt(line.text, boxRight, "right"));
        box = null;
      }
    }
    if (orWord && !box && selStart === selEnd) {
      const row = rowOf(caret);
      if (row >= 0) {
        const line = view.lines[row];
        const col = colOf(line, caret);
        if (isWord(line.text[col])) selectWord(caret);
        else if (isWord(line.text[col - 1])) selectWord(offsetOf(line, col - 1));
      }
    }
    return selectedText();
  }

  /** Replaces the selection with `text` (Find and Replace). */
  export function replaceSelection(text: string) {
    return new Promise<void>((resolve) =>
      enqueue(async () => {
        await insert(text, "other");
        resolve();
      }),
    );
  }

  /** Runs a change the core makes from the selection (Toggle Comment), and takes on the selection it leaves. */
  export function editSelection(edit: (anchor: number, caret: number) => Promise<api.EditResult | null>) {
    return new Promise<void>((resolve) =>
      enqueue(async () => {
        box = null;
        try {
          const result = await edit(anchor, caret);
          if (result) await applied(result);
        } catch (e) {
          onerror?.(describeError(e));
        }
        resolve();
      }),
    );
  }

  // ---- The Selection menu ---------------------------------------------------

  /** A change the core makes from the selection, run in turn. */
  function lineWork(edit: () => Promise<api.EditResult | null>) {
    return new Promise<void>((resolve) =>
      enqueue(async () => {
        try {
          const result = await edit();
          if (result) await applied(result);
        } finally {
          resolve();
        }
      }),
    );
  }

  /** Move Line Up or Down (Alt+↑/↓). */
  export function moveLines(up: boolean) {
    box = null;
    return lineWork(() => api.moveLines(doc.id, up, anchor, caret));
  }

  /** Copy Line Up or Down (Ctrl+Shift+Alt+↑/↓). */
  export function copyLines(up: boolean) {
    box = null;
    return lineWork(() => api.copyLines(doc.id, up, anchor, caret));
  }

  /** Duplicate Selection (Ctrl+D); without one, the line goes below. */
  export function duplicate() {
    box = null;
    return lineWork(() => api.duplicateSelection(doc.id, anchor, caret));
  }

  /** Add Cursor Above or Below (Ctrl+Alt+↑/↓): carets in a column, which is a box of no width. */
  export function addCursor(dy: number) {
    enqueue(() => boxMove(0, dy));
  }

  /** What Shrink Selection goes back through: the selection before each expansion, and after it. */
  let grown: { before: [number, number]; after: [number, number] }[] = [];

  /** Expand Selection (Ctrl+Shift+Alt+→): word, field, the line's text, the line, the block, everything. */
  export function expandSelection() {
    enqueue(async () => {
      box = null;
      await revealCaret();
      const next = await expansion(selStart, selEnd);
      if (!next) return;
      const last = grown.at(-1);
      if (last && (last.after[0] !== anchor || last.after[1] !== caret)) grown = [];
      grown.push({ before: [anchor, caret], after: next });
      [anchor, caret] = next;
      preferredCol = null;
      await revealCaret();
    });
  }

  /** Shrink Selection (Ctrl+Shift+Alt+←): back to what the last expansion grew from. */
  export function shrinkSelection() {
    enqueue(async () => {
      const last = grown.pop();
      if (!last || last.after[0] !== anchor || last.after[1] !== caret) {
        grown = [];
        return;
      }
      [anchor, caret] = last.before;
      preferredCol = null;
      await revealCaret();
    });
  }

  /** The smallest step out from `[start, end)`: within its line, then the core's block, then all. */
  async function expansion(start: number, end: number): Promise<[number, number] | null> {
    if (!view) return null;
    const steps: [number, number][] = [];
    const row = rowOf(start);
    if (row >= 0) {
      const line = view.lines[row];
      const at = (col: number) => offsetOf(line, col);
      if (end <= line.offset + line.len) {
        const [a, b] = [colOf(line, start), colOf(line, end)];
        let [wa, wb] = [a, b];
        while (wa > 0 && isWord(line.text[wa - 1])) wa--;
        while (wb < line.text.length && isWord(line.text[wb])) wb++;
        if (wa < wb && [...line.text.slice(wa, wb)].every(isWord)) steps.push([at(wa), at(wb)]);
        const field = fieldRange(lang, line.text, a);
        if (field && field[0] <= a && b <= field[1]) steps.push([at(field[0]), at(field[1])]);
        steps.push([line.offset, line.offset + line.len]);
      }
      const next = view.lines[row + 1]?.offset;
      if (next !== undefined) steps.push([line.offset, next]);
    }
    const wider = (step: [number, number]) => step[0] <= start && end <= step[1] && step[1] - step[0] > end - start;
    const near = steps.filter(wider).sort((x, y) => x[1] - x[0] - (y[1] - y[0]))[0];
    if (near) return near;
    const kind = lang === "abaqus" || lang === "nastran" ? lang : "paragraph";
    const block = await api.blockAround(doc.id, kind, start, end);
    if (wider(block)) return block;
    return start > 0 || end < view.len ? [0, view.len] : null;
  }

  /** Shows the result of a change made elsewhere (Replace All), keeping the place. */
  export function applyResult(result: api.EditResult) {
    onedit?.(result);
    return keepLine(result.change);
  }

  /** After a change around the view: the text on top is gone, its line number stays. */
  function keepLine(change: api.Change) {
    lineStates?.invalidate(change.start);
    return new Promise<void>((resolve) =>
      enqueue(async () => {
        box = null;
        const first = view?.firstLine;
        const at = view ? shift(view.top, change) : 0;
        jump(first != null ? { kind: "line", line: first } : { kind: "scroll", anchor: at, delta: 0 });
        await settled();
        anchor = caret = view?.lines[0]?.offset ?? 0;
        preferredCol = null;
        resolve();
      }),
    );
  }

  /** The document was edited in the other pane: everything here stays on its text. */
  export function followEdit(change: api.Change) {
    if (view && view.top > change.start && view.top < change.start + change.oldLen) {
      keepLine(change);
      return;
    }
    lineStates?.invalidate(change.start);
    enqueue(async () => {
      box = null;
      anchor = shift(anchor, change);
      caret = shift(caret, change);
      if (view) jump({ kind: "scroll", anchor: shift(view.top, change), delta: 0 });
      await settled();
    });
  }

  /** Where this editor is, for another one to take over. */
  export function place() {
    return { anchor, caret, top: view?.top ?? 0 };
  }

  export function goToPlace(place: { anchor: number; caret: number; top: number }) {
    enqueue(async () => {
      box = null;
      anchor = place.anchor;
      caret = place.caret;
      preferredCol = null;
      jump({ kind: "scroll", anchor: place.top, delta: 0 });
      await settled();
    });
  }

  /** Selects `[from, to)` and scrolls it into view, a third down the page and clear of the find bar. */
  export function select(from: number, to: number) {
    enqueue(async () => {
      box = null;
      anchor = from;
      caret = to;
      preferredCol = null;
      await settled();
      // Scrolled sideways to the caret first.
      await tick();
      if (rowOf(from) < 0 || rowOf(to) < 0 || underCover(from, to)) {
        jump({ kind: "offset", offset: from, context: clearRows() });
        await settled();
        await tick();
        // At the start of the text there is nowhere to scroll to: make room above it instead.
        const cover = covered?.();
        if (cover && view?.top === 0 && underCover(from, to)) {
          lift = Math.ceil(cover.bottom - root.getBoundingClientRect().top);
          await tick();
          await settled();
        }
      }
    });
  }

  /** Room above the first line, so that the find bar hides no match there, as
   * VS Code makes; gone once the text scrolls or nothing covers it. */
  let lift = $state(0);
  $effect(() => {
    if (!covered || (view && view.top !== 0)) lift = 0;
  });

  /** Whether `[from, to)`, on screen, is under what covers the text. */
  function underCover(from: number, to: number) {
    const cover = covered?.();
    const row = rowOf(from);
    const el = row >= 0 ? (lineBox?.children[row] as HTMLElement | undefined) : undefined;
    if (!cover || !view || !el) return false;
    const line = view.lines[row];
    const rect = el.getBoundingClientRect();
    const left = rect.left + xAt(el, colOf(line, from));
    const right = rect.left + xAt(el, colOf(line, Math.min(to, line.offset + line.len)));
    return rect.top < cover.bottom && rect.bottom > cover.top && left < cover.right && right > cover.left;
  }

  /** Lines above a match brought into view: a third of the page, or all that the cover hides. */
  function clearRows() {
    const third = Math.floor(rows / 3);
    const cover = covered?.();
    if (!cover) return third;
    const hidden = Math.ceil((cover.bottom - scroller.getBoundingClientRect().top) / lineH);
    return Math.min(rows - 1, Math.max(third, hidden));
  }

  /** The same bytes are now read in another encoding: shows them, with the
   * caret at a line start, a character boundary in any encoding. */
  export function reread() {
    lineStates?.invalidate(0);
    enqueue(async () => {
      box = null;
      refresh();
      await settled();
      const row = rowOf(caret);
      anchor = caret = row >= 0 && view ? view.lines[row].offset : (view?.top ?? 0);
      preferredCol = null;
    });
  }

  export function gotoLine(line: number) {
    enqueue(async () => {
      jump({ kind: "line", line });
      await settled();
      if (!view || view.firstLine === null) return;
      const target = view.lines[line - view.firstLine] ?? view.lines[view.lines.length - 1];
      anchor = caret = target.offset;
      preferredCol = null;
    });
  }

  // ---- Effects ----------------------------------------------------------

  // A new document starts at the top (not a renamed one: Save As keeps the id).
  let docId = $derived(doc.id);
  $effect(() => {
    void docId;
    untrack(() => {
      view = null;
      viewError = null;
      box = null;
      anchor = caret = 0;
      preferredCol = null;
      jump({ kind: "fraction", fraction: 0 });
    });
  });

  // Resizing changes how many lines to fetch.
  $effect(() => {
    void rows;
    untrack(refresh);
  });

  // Line numbers appear once the background index gets there.
  $effect(() => {
    void indexed;
    untrack(() => {
      if (view && view.firstLine === null) refresh();
    });
  });

  // Width of a column, for the space past line ends.
  $effect(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    context.font = `${settings.fontSize}px ${fontStack()}`;
    cellW = context.measureText("0".repeat(100)).width / 100;
  });

  // Place the caret (and the textarea, so the IME window follows it).
  $effect(() => {
    void view;
    void caret;
    void composition;
    void lineH;
    void cellW;
    void settings.fontFamily;
    untrack(() => tick().then(placeCaret));
  });

  $effect(() => {
    void view;
    void box?.anchorLine;
    void box?.anchorCol;
    void box?.caretLine;
    void box?.caretCol;
    void lineH;
    void cellW;
    void settings.fontFamily;
    untrack(() => tick().then(placeBox));
  });

  /** Highlight rectangles of the box on visible lines (or carets when it has no width). */
  function placeBox() {
    if (!box || !view || !lineBox) {
      boxRects = [];
      return;
    }
    const rects: typeof boxRects = [];
    view.lines.forEach((line, row) => {
      if (line.offset < boxTop || line.offset > boxBottom) return;
      const el = lineBox!.children[row] as HTMLElement;
      const left = xAtCol(el, line, boxLeft);
      const right = boxRight > boxLeft ? xAtCol(el, line, boxRight) : left;
      rects.push({ x: left, y: row * lineH, w: Math.max(2, right - left) });
    });
    boxRects = rects;
    // The textarea (IME window) follows the box's caret corner.
    const row = lineRow(box.caretLine);
    if (row >= 0) {
      caretAt = { x: xAtCol(lineBox.children[row] as HTMLElement, view.lines[row], box.caretCol), y: row * lineH };
    }
  }

  /** Horizontal position of display column `col`, counting columns of space past the end. */
  function xAtCol(el: HTMLElement, line: Line, col: number) {
    const width = textWidth(line.text);
    if (col >= width) return xAt(el, line.text.length) + (col - width) * cellW;
    return xAt(el, indexAt(line.text, col, "left"));
  }

  function placeCaret() {
    if (box) return;
    const row = rowOf(caret);
    const el = row >= 0 ? (lineBox?.children[row] as HTMLElement | undefined) : undefined;
    if (!view || !el) {
      caretAt = null;
      return;
    }
    const x = xAt(el, colOf(view.lines[row], caret));
    caretAt = { x, y: row * lineH };
    // Keep the caret in view horizontally.
    if (x < scroller.scrollLeft + 4) scroller.scrollLeft = Math.max(0, x - 40);
    else if (x > scroller.scrollLeft + scroller.clientWidth - 16) scroller.scrollLeft = x - scroller.clientWidth + 40;
  }

  /** Horizontal position of column `col` in a rendered line. */
  function xAt(el: HTMLElement, col: number) {
    if (col === 0) return 0;
    let left = col;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (left <= node.length) {
        const range = document.createRange();
        range.setStart(el, 0);
        range.setEnd(node, left);
        return range.getBoundingClientRect().right - el.getBoundingClientRect().left;
      }
      left -= node.length;
    }
    return el.scrollWidth;
  }

  $effect(() => {
    void caret;
    void anchor;
    void view;
    void box?.anchorLine;
    void box?.anchorCol;
    void box?.caretLine;
    void box?.caretCol;
    void columnMode;
    void settings.rainbowColumns;
    untrack(() => {
      // In a box, the position is its caret corner.
      const row = box ? lineRow(box.caretLine) : rowOf(caret);
      const line = row >= 0 && view ? view.lines[row] : null;
      const boxRows = box && lineRow(boxTop) >= 0 && lineRow(boxBottom) >= 0 ? lineRow(boxBottom) - lineRow(boxTop) + 1 : null;
      oncaret?.({
        line: line && view?.firstLine != null ? view.firstLine + row : null,
        col: box ? box.caretCol + 1 : line ? colOf(line, caret) + 1 : 1,
        selected: box ? 0 : selEnd - selStart,
        box: box ? { rows: boxRows, cols: boxRight - boxLeft } : null,
        columnMode,
        field: settings.rainbowColumns && line && !box ? fieldAt(lang, line.text, colOf(line, caret)) : null,
      });
    });
  });

  // ---- Rendering helpers -------------------------------------------------

  let shownLang = $derived(settings.syntaxHighlight ? lang : "plain");
  // For languages whose lines depend on the ones above.
  let lineStates = $derived(isCodeLang(shownLang) && dependsOnLinesAbove(shownLang) ? new LineStates(doc.id, shownLang) : null);
  let viewIsCurrent = true;
  /** Bumped when a state turned out different from the guess the lines were drawn with. */
  let statesFound = $state(0);

  let highlighted = $derived.by(() => {
    void statesFound;
    if (!view) return { tokens: [], states: [] };
    const lines = view.lines.map((line) => line.text);
    return tokenizeLines(lines, shownLang, lineStates?.peek(view.top) ?? null);
  });

  // Whatever is on screen, once it is sure, helps with where the view goes next.
  $effect(() => {
    const shown = view;
    const { states } = highlighted;
    const known = lineStates;
    if (!known || !shown) return;
    untrack(() => {
      if (known.knows(shown.top)) {
        // Lines read before an edit say nothing about the text now.
        if (viewIsCurrent) {
          shown.lines.forEach((line, i) => {
            if (states[i] !== undefined) known.note(line.offset, states[i]);
          });
        }
        return;
      }
      known.find(shown.top).then((found) => {
        if (found && known === lineStates) statesFound++;
      });
    });
  });

  // A regular expression's matches on screen come from the core, which has
  // the regex engine; a literal needle's are found here.
  let coreMarks = $state<[number, number][]>([]);
  $effect(() => {
    const query = highlight;
    const shown = view;
    if (!query?.regex || !query.needle || !shown) {
      coreMarks = [];
      return;
    }
    let stale = false;
    const asked = { ...query, scope: query.scope ? [query.scope[0], query.scope[1]] : null } satisfies api.Query;
    api.matchesIn(doc.id, asked, shown.top, shown.end).then(
      (marks) => !stale && (coreMarks = marks),
      () => !stale && (coreMarks = []),
    );
    return () => (stale = true);
  });

  function marksOf(line: Line): Mark[] {
    const marks: Mark[] = [];
    const end = line.offset + line.len;
    const scope = highlight?.scope;
    if (scope && scope[0] <= end && scope[1] > line.offset) {
      marks.push([colOf(line, Math.max(scope[0], line.offset)), colOf(line, Math.min(scope[1], end)), "scope"]);
    }
    const found = (a: number, b: number) => (a === selStart && b === selEnd ? "found" : "match");
    if (highlight?.regex) {
      for (const [a, b] of coreMarks) {
        if (a < line.offset || a > end) continue;
        marks.push([colOf(line, a), colOf(line, Math.min(b, end)), found(a, b)]);
      }
    } else if (highlight?.needle) {
      for (const [a, b] of findMatches(line.text, highlight.needle, highlight)) {
        const [from, to] = [offsetOf(line, a), offsetOf(line, b)];
        if (scope && (from < scope[0] || to > scope[1])) continue;
        marks.push([a, b, found(from, to)]);
      }
    }
    if (box) {
      if (line.offset >= boxTop && line.offset <= boxBottom) {
        marks.push([indexAt(line.text, boxLeft, "left"), indexAt(line.text, boxRight, "left"), "boxed"]);
      }
      return marks;
    }
    const a = Math.max(selStart, line.offset);
    const b = Math.min(selEnd, line.offset + line.len);
    if (a < b) marks.push([colOf(line, a), colOf(line, b), "sel"]);
    return marks;
  }

  /** The selection runs on past the end of this line. */
  function selectsBreak(line: Line) {
    return !box && selStart <= line.offset + line.len && selEnd > line.offset + line.len;
  }

  let wheelPx = 0;
  function onWheel(e: WheelEvent) {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal: native
    e.preventDefault();
    const scale = e.deltaMode === 1 ? lineH : e.deltaMode === 2 ? rows * lineH : 1;
    wheelPx += e.deltaY * scale;
    const n = Math.trunc(wheelPx / lineH);
    wheelPx -= n * lineH;
    scrollLines(n);
  }

  onMount(() => {
    // Registered by hand: preventDefault needs a non-passive listener.
    root.addEventListener("wheel", onWheel, { passive: false });
    focus();
    return () => {
      root.removeEventListener("wheel", onWheel);
      endDrag();
    };
  });

  // ---- Scrollbar ----------------------------------------------------------
  // Thumb position is `top / maxTop`; its size the share of bytes on screen.

  let dragTop = $state<number | null>(null);
  let dragFrom = { y: 0, top: 0 };
  let thumbH = $derived(
    !view || view.len === 0
      ? trackH
      : Math.min(trackH, Math.max(MIN_THUMB, (trackH * (view.end - view.top)) / view.len)),
  );
  let thumbRange = $derived(Math.max(0, trackH - thumbH));
  let thumbTop = $derived(
    dragTop ?? (view && view.maxTop > 0 ? (view.top / view.maxTop) * thumbRange : 0),
  );

  function thumbDown(e: PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragFrom = { y: e.clientY, top: thumbTop };
    dragTop = thumbTop;
  }

  function thumbMove(e: PointerEvent) {
    if (dragTop === null) return;
    dragTop = Math.min(thumbRange, Math.max(0, dragFrom.top + e.clientY - dragFrom.y));
    jump({ kind: "fraction", fraction: thumbRange > 0 ? dragTop / thumbRange : 0 });
  }

  function trackDown(e: PointerEvent) {
    const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    const page = Math.max(1, rows - 1);
    scrollLines(y < thumbTop ? -page : page);
  }

  let gutterCh = $derived(
    Math.max(4, String(Math.max(lines, (view?.firstLine ?? 0) + rows)).length) + 1,
  );
  let caretRow = $derived(rowOf(caret));
</script>

<div
  class="editor"
  class:focused
  class:column-mode={columnMode}
  class:no-shading={!settings.fieldShading}
  class:no-gutter={!settings.lineNumbers}
  class:rainbow={settings.rainbowColumns}
  style:padding-top={lift ? `${lift}px` : null}
  bind:this={root}
>
  {#if settings.lineNumbers}
    <div class="gutter" style:width="{gutterCh}ch">
      {#if view}
        {#each view.lines as line, i (line.offset)}
          <div class="ln" class:current={settings.highlightLine && i === caretRow}>{view.firstLine === null ? "" : view.firstLine + i + 1}</div>
        {/each}
      {/if}
    </div>
  {/if}
  <div
    class="text"
    role="presentation"
    bind:this={scroller}
    bind:clientHeight={height}
    {onmousedown}
    {oncontextmenu}
  >
    {#each boxRects as rect, i (i)}
      <div class="box" class:bar={boxLeft === boxRight} style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.w}px"></div>
    {/each}
    <div class="lines" bind:this={lineBox}>
      {#if view}
        {#each view.lines as line, i (line.offset)}
          <div class="line" class:current={settings.highlightLine && !box && i === caretRow && selStart === selEnd}>{#each applyMarks(highlighted.tokens[i] ?? [{ text: line.text, cls: null }], marksOf(line)) as seg}<span class={seg.cls}>{seg.text}</span>{/each}{#if line.truncated}<span class="truncated">⋯</span>{/if}{#if selectsBreak(line)}<span class="sel eol"></span>{/if}</div>
        {/each}
      {/if}
    </div>
    {#if caretAt}
      {#key blink}
        <div class="caret" class:hidden={!focused || composing || box} style:left="{caretAt.x}px" style:top="{caretAt.y}px"></div>
      {/key}
    {/if}
    <textarea
      class="input"
      class:composing
      bind:this={input}
      style:left="{caretAt?.x ?? 0}px"
      style:top="{caretAt?.y ?? 0}px"
      style:width="{composing ? composition.length * 2 + 1 : 1}ch"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-label={t("editor.label")}
      {onkeydown}
      {oninput}
      {onpaste}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      oncompositionstart={() => (composing = true)}
      oncompositionupdate={(e) => (composition = e.data)}
      oncompositionend={() => {
        composing = false;
        composition = "";
        flushInput();
      }}
    ></textarea>
  </div>
  <!-- Using the scrollbar must leave the keyboard in the editor. -->
  <div
    class="vscroll"
    role="presentation"
    bind:clientHeight={trackH}
    onpointerdown={trackDown}
    onmousedown={(e) => e.preventDefault()}
  >
    <div
      class="thumb"
      class:dragging={dragTop !== null}
      role="presentation"
      style:top="{thumbTop}px"
      style:height="{thumbH}px"
      onpointerdown={thumbDown}
      onpointermove={thumbMove}
      onpointerup={() => (dragTop = null)}
      onpointercancel={() => (dragTop = null)}
    ></div>
  </div>
  {#if viewError}
    <div class="error">{viewError}</div>
  {/if}
</div>

<style>
  .editor {
    position: relative;
    display: flex;
    box-sizing: border-box;
    height: 100%;
    font-family: var(--mono);
    font-size: var(--font-size);
    line-height: var(--line-h);
    background: var(--bg);
    color: var(--fg);
    --selection: #0a6cc4;
  }
  .editor:not(.focused) {
    --selection: #55657c;
  }
  .gutter {
    flex: none;
    padding: 0 12px 0 8px;
    text-align: right;
    color: var(--gutter);
    user-select: none;
    overflow: hidden;
  }
  .ln,
  .line {
    height: var(--line-h);
  }
  .ln.current {
    color: var(--fg);
  }
  .text {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    cursor: text;
  }
  /* A border rather than padding: what is placed in the text counts from inside
     it, the text scrolls clear of it, and it still takes the mouse. */
  .no-gutter .text {
    border-left: 12px solid transparent;
  }
  .lines {
    min-width: max-content;
  }
  /* On the lines only: template whitespace around them must not render. */
  .line {
    white-space: pre;
    tab-size: 8;
    overflow: clip;
  }
  .text {
    isolation: isolate;
  }
  .box {
    position: absolute;
    height: var(--line-h);
    z-index: -1;
    background: var(--selection);
    pointer-events: none;
  }
  .box.bar {
    z-index: 1;
    background: #aeafad;
  }
  .editor:not(.focused) .box.bar {
    background: var(--selection);
  }
  .column-mode .text {
    cursor: crosshair;
  }
  .line.current {
    box-shadow: inset 0 0 0 1px #282828;
  }
  .caret {
    position: absolute;
    width: 2px;
    height: var(--line-h);
    background: #aeafad;
    pointer-events: none;
    animation: blink 1.06s steps(1) infinite;
  }
  .caret.hidden {
    display: none;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .input {
    position: absolute;
    height: var(--line-h);
    margin: 0;
    padding: 0;
    border: none;
    outline: none;
    resize: none;
    overflow: hidden;
    background: transparent;
    color: transparent;
    caret-color: transparent;
    font: inherit;
    line-height: var(--line-h);
    white-space: pre;
    opacity: 0;
    z-index: -1;
  }
  .input.composing {
    opacity: 1;
    z-index: 2;
    background: var(--bg);
    color: var(--fg);
    text-decoration: underline;
  }
  .vscroll {
    flex: none;
    position: relative;
    width: 14px;
    border-left: 1px solid var(--border);
  }
  .thumb {
    position: absolute;
    left: 3px;
    right: 3px;
    border-radius: 4px;
    background: rgba(121, 121, 121, 0.4);
  }
  .thumb:hover,
  .thumb.dragging {
    background: rgba(160, 160, 160, 0.6);
  }
  .error {
    position: absolute;
    top: 8px;
    right: 24px;
    padding: 6px 10px;
    border-radius: 4px;
    background: #5a1d1d;
    color: #f8d7da;
    font-family: var(--ui);
  }
  /* Rainbow columns: a color for each field, around again after eight. */
  .rainbow .lines :global(.rb0) {
    color: #9cdcfe;
  }
  .rainbow .lines :global(.rb1) {
    color: #ce9178;
  }
  .rainbow .lines :global(.rb2) {
    color: #b5cea8;
  }
  .rainbow .lines :global(.rb3) {
    color: #c586c0;
  }
  .rainbow .lines :global(.rb4) {
    color: #dcdcaa;
  }
  .rainbow .lines :global(.rb5) {
    color: #4fc1ff;
  }
  .rainbow .lines :global(.rb6) {
    color: #f48771;
  }
  .rainbow .lines :global(.rb7) {
    color: #d4d4d4;
  }
  /* Fill the line's height, so that highlighted lines touch: the padding moves
     no text and the line clips what is too much. (An inline-block would restart
     the tab stops inside it.) */
  .lines :global(.scope),
  .lines :global(.sel),
  .lines :global(.match),
  .lines :global(.found) {
    padding-block: var(--line-h);
  }
  /* Find in Selection's scope, under the selection and the matches in it. */
  .lines :global(.scope) {
    background: rgba(58, 61, 65, 0.8);
  }
  /* White text: syntax colors are not readable on backgrounds this strong. */
  .lines :global(.sel) {
    background: var(--selection);
    color: #fff;
  }
  /* A selected line break, which also makes a selected empty line show. Not
     text in the line: columns and clicks count its characters. */
  .lines :global(.eol)::after {
    content: " ";
  }
  /* The box itself is drawn behind the lines. */
  .lines :global(.boxed) {
    background: none;
    color: #fff;
  }
  .lines :global(.match) {
    background: #8a6100;
    color: #fff;
  }
  .lines :global(.found) {
    background: #ffa028;
    color: #000;
  }
</style>
