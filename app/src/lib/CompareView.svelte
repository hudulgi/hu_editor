<script lang="ts">
  // The two documents of a comparison side by side, row by row, as many rows as
  // fit: an equal line on both sides, or a hunk, its shorter side padded. Only
  // the rows on screen are fetched, so any size scrolls alike. On the right, the
  // overview of where the hunks are, which also scrolls; between the sides, the
  // buttons that copy a hunk across. A line can be edited where it is shown.

  import { onMount, tick } from "svelte";
  import * as api from "./api";
  import DropMenu, { type DropEntry } from "./DropMenu.svelte";
  import { t } from "./i18n";
  import { lineHeight, settings } from "./settings.svelte";
  import { applyMarks, tokenizeLines, type Lang, type Mark, type Token } from "./syntax";

  interface Props {
    id: number;
    langs: [Lang, Lang];
    /** Bumped when a document changed, to fetch again. */
    version: number;
    /** The hunk the keyboard works on. */
    current?: number | null;
    onmerge: (index: number, to: api.Side) => unknown;
    /** A line edited where it is shown: its text is to be `text`. */
    onedit: (side: api.Side, line: number, text: string) => unknown;
    /** A line to be shown in an editor, in the window that opened this one. */
    onshow: (side: api.Side, line: number) => unknown;
    onnotice: (message: string) => void;
    /** What the comparison now holds. */
    onstats: (view: api.CompareView) => void;
  }

  let { id, langs, version, current = $bindable(null), onmerge, onedit, onshow, onnotice, onstats }: Props = $props();

  const SIDES = ["left", "right"] as const;
  // Lines changed, only on the left, only on the right: as in the rows.
  const OVERVIEW_COLORS = ["", "#4fa3e8", "#f14c4c", "#73c991"];
  const SIGNS = { changed: "~", removed: "−", added: "+", filler: "", "": "" };

  let root: HTMLElement;
  let body = $state<HTMLElement>();
  let bodyH = $state(0);
  let lineH = $derived(lineHeight(settings.fontSize));
  let visible = $derived(Math.max(1, Math.floor(bodyH / lineH)));
  let top = $state(0);
  let view = $state<api.CompareView | null>(null);
  let total = $derived(view?.total ?? 0);
  let maxTop = $derived(Math.max(0, total - visible));
  let asked = 0;

  async function load() {
    const n = ++asked;
    const got = await api.compareView(id, top, visible + 1).catch(() => null);
    if (n !== asked || !got) return;
    view = got;
    onstats(got);
    if (top > Math.max(0, got.total - visible)) top = Math.max(0, got.total - visible);
  }

  $effect(() => {
    void [id, version, top, visible];
    load();
  });

  export function scrollTo(row: number) {
    top = Math.round(Math.max(0, Math.min(row, maxTop)));
  }

  const scrollBy = (rows: number) => scrollTo(top + rows);

  /** Whether hunk `index` has a row on screen. */
  const onScreen = (index: number | null) => index !== null && !!view?.rows.some((row) => row.hunk === index);

  /** Shows a hunk: whole if it fits, with some lines above it. */
  function reveal(hunk: api.HunkRows) {
    const fits = hunk.end - hunk.start <= visible;
    if (fits && hunk.start >= top && hunk.end <= top + visible) return;
    scrollTo(hunk.start - (fits ? Math.min(3, Math.floor((visible - (hunk.end - hunk.start)) / 2)) : 0));
  }

  async function go(found: api.HunkRows | null) {
    if (!found) return false;
    current = found.index;
    reveal(found);
    return true;
  }

  /** The next hunk after the current one if it is on screen, else the first from the top down. */
  export async function next() {
    if (onScreen(current)) return go(await api.compareHunk(id, current! + 1));
    return go(await (top === 0 ? api.compareHunk(id, 0) : api.compareHunkFrom(id, top - 1, true)));
  }

  export async function previous() {
    if (onScreen(current)) return current! > 0 && go(await api.compareHunk(id, current! - 1));
    return go(await api.compareHunkFrom(id, top, false));
  }

  export async function first() {
    return go(await api.compareHunk(id, 0));
  }

  export async function last() {
    const hunks = view?.hunks ?? 0;
    return hunks > 0 && go(await api.compareHunk(id, hunks - 1));
  }

  /** Copies the current hunk to `to`, if it is on screen. */
  export function mergeCurrent(to: api.Side) {
    if (current !== null && onScreen(current)) return onmerge(current, to);
  }

  export const focus = () => root.focus();

  // ---- Lines picked and edited -------------------------------------------------

  type Picked = { side: api.Side; line: number };
  /** The line F2 and Ctrl+E work on: the one clicked last. */
  let picked = $state<Picked | null>(null);
  /** A line being edited where it is shown, and what it was. */
  let editing = $state<(Picked & { value: string; was: string }) | null>(null);
  let menu = $state<{ items: DropEntry[]; point: { x: number; y: number } } | null>(null);

  export const pickedLine = () => picked;

  /** A click on a row: its line on that side, and its hunk. */
  function pick(row: api.CompareRow, side: api.Side) {
    const line = row[side];
    if (line) picked = { side, line: line.line };
    if (row.hunk !== null) current = row.hunk;
  }

  const lineOf = (side: api.Side, line: number) => view?.rows.find((row) => row[side]?.line === line)?.[side] ?? null;

  /** Edits a line where it is shown, the one picked unless told; one cut short for the screen cannot be. */
  export async function edit(at: Picked | null = picked) {
    const line = at && lineOf(at.side, at.line);
    if (!at || !line) return false;
    if (line.truncated) {
      onnotice(t("compare.tooLong"));
      return false;
    }
    picked = at;
    editing = { ...at, value: line.text, was: line.text };
    await tick();
    const input = root.querySelector<HTMLInputElement>("input.edit");
    input?.focus();
    input?.select();
    return true;
  }

  function commit() {
    const done = editing;
    editing = null;
    root.focus();
    if (done && done.value !== done.was) onedit(done.side, done.line, done.value);
  }

  function cancel() {
    editing = null;
    root.focus();
  }

  function editKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.isComposing) commit();
    else if (e.key === "Escape") cancel();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function openMenu(e: MouseEvent, row: api.CompareRow, side: api.Side) {
    e.preventDefault();
    pick(row, side);
    const line = row[side];
    const items: DropEntry[] = [
      { label: t("compare.editLine"), shortcut: "F2", enabled: !!line && !line.truncated, run: () => line && edit({ side, line: line.line }) },
      { label: t("compare.showInEditor"), shortcut: "Ctrl+E", enabled: !!line, run: () => line && onshow(side, line.line) },
    ];
    if (row.hunk !== null) {
      const hunk = row.hunk;
      items.push(
        "separator",
        { label: t("compare.copyRight"), shortcut: "Alt+Right", run: () => onmerge(hunk, "right") },
        { label: t("compare.copyLeft"), shortcut: "Alt+Left", run: () => onmerge(hunk, "left") },
      );
    }
    menu = { items, point: { x: e.clientX, y: e.clientY } };
  }

  function closeMenu() {
    menu = null;
    if (!editing) root.focus();
  }

  // ---- Rows --------------------------------------------------------------------

  interface Shown {
    row: api.CompareRow;
    /** The first row of its hunk on screen: the copy buttons go there. */
    first: boolean;
    sides: [Token[] | null, Token[] | null];
  }

  let shown = $derived.by<Shown[]>(() => {
    if (!view) return [];
    const rows = view.rows;
    const tokens = SIDES.map((side, s) => {
      const lang = settings.syntaxHighlight ? langs[s] : "plain";
      return tokenizeLines(rows.map((row) => row[side]?.text ?? ""), lang).tokens;
    });
    return rows.map((row, i) => ({
      row,
      first: row.hunk !== null && (i === 0 || rows[i - 1].hunk !== row.hunk),
      sides: [segments(row.left, tokens[0][i]), segments(row.right, tokens[1][i])],
    }));
  });

  function segments(line: api.CompareLine | null, tokens: Token[] | undefined): Token[] | null {
    if (!line) return null;
    const marks: Mark[] = line.marks.map(([a, b]) => [a, b, "mark"]);
    return applyMarks(tokens ?? [{ text: line.text, cls: null }], marks);
  }

  type Kind = keyof typeof SIGNS;

  /**
   * The look of a row on one side: in a hunk, a line on each side that differ
   * (changed), or a line on one side only (removed on the left, added on the
   * right) with nothing across (filler).
   */
  function kind(row: api.CompareRow, side: api.Side): Kind {
    if (row.hunk === null) return "";
    if (!row[side]) return "filler";
    if (row.left && row.right) return "changed";
    return side === "left" ? "removed" : "added";
  }

  /** Where a run of filler rows starts and ends: lines are drawn there. */
  function edges(i: number, side: api.Side) {
    const rows = view?.rows ?? [];
    const filler = (at: number) => !!rows[at] && rows[at].hunk !== null && !rows[at][side];
    if (!filler(i)) return "";
    return `${filler(i - 1) ? "" : "first"} ${filler(i + 1) ? "" : "last"}`;
  }

  let digits = $derived(String(Math.max(1, view?.rows.reduce((most, row) => Math.max(most, (row.left?.line ?? 0) + 1, (row.right?.line ?? 0) + 1), 0) ?? 1)).length);

  // ---- Scrolling ---------------------------------------------------------------

  let wheelPx = 0;

  function onWheel(e: WheelEvent) {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal: native
    e.preventDefault();
    const scale = e.deltaMode === 1 ? lineH : e.deltaMode === 2 ? visible * lineH : 1;
    wheelPx += e.deltaY * scale;
    const n = Math.trunc(wheelPx / lineH);
    wheelPx -= n * lineH;
    scrollBy(n);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    const mod = e.ctrlKey || e.metaKey;
    const keys: Record<string, () => void> = {
      ArrowDown: () => scrollBy(1),
      ArrowUp: () => scrollBy(-1),
      PageDown: () => scrollBy(visible - 1),
      PageUp: () => scrollBy(-(visible - 1)),
    };
    if (mod && e.key === "Home") scrollTo(0);
    else if (mod && e.key === "End") scrollTo(maxTop);
    else if (!mod && !e.altKey && keys[e.key]) keys[e.key]();
    else return;
    e.preventDefault();
  }

  // Both sides scroll sideways together.
  let texts: HTMLElement[] = $state([]);

  function sideways(from: HTMLElement) {
    for (const other of texts) if (other !== from && other.scrollLeft !== from.scrollLeft) other.scrollLeft = from.scrollLeft;
  }

  // ---- Overview ----------------------------------------------------------------

  let overview = $state<HTMLCanvasElement>();
  let overviewH = $state(0);
  let buckets = $state<number[]>([]);

  $effect(() => {
    void version;
    const height = Math.floor(overviewH);
    if (height > 0) api.compareOverview(id, height).then((got) => (buckets = got), () => {});
  });

  $effect(() => {
    const canvas = overview;
    if (!canvas) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * scale);
    canvas.height = Math.round(buckets.length * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    buckets.forEach((kind, i) => {
      if (!kind) return;
      context.fillStyle = OVERVIEW_COLORS[kind];
      // At least a pixel and a half: a one-line hunk in a huge file still shows.
      context.fillRect(0, Math.floor(i * scale), canvas.width, Math.max(1.5 * scale, Math.ceil(scale)));
    });
  });

  let thumb = $derived(
    total > 0 ? { top: (top / total) * overviewH, height: Math.max(6, (Math.min(visible, total) / total) * overviewH) } : null,
  );
  let dragging = $state(false);

  /** How near a hunk's mark a click in the overview goes to it, in pixels. */
  const OVERVIEW_REACH = 4;

  /** The row at this point of the overview, and the rows a pixel there covers. */
  function overviewRow(e: PointerEvent) {
    const box = overview!.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientY - box.top) / box.height));
    return { row: Math.min(total - 1, Math.floor(fraction * total)), perPixel: total / box.height };
  }

  /** Puts the row at this point of the overview in the middle of the screen. */
  function overviewAt(e: PointerEvent) {
    if (!overview || total === 0) return;
    scrollTo(overviewRow(e).row - visible / 2);
  }

  /** The pointer is near a hunk's mark: a press there goes to it, so it shows as something to click. */
  let onMark = $state(false);

  /** Whether a mark is drawn within reach of this point, from what the overview drew: a pixel each. */
  function nearMark(e: PointerEvent) {
    if (!overview || !buckets.length) return false;
    const at = Math.floor(e.clientY - overview.getBoundingClientRect().top);
    return buckets.slice(Math.max(0, at - OVERVIEW_REACH), at + OVERVIEW_REACH + 1).some((kind) => kind !== 0);
  }

  /** A press on a hunk's mark goes to that hunk, as F7 would; elsewhere it scrolls there. */
  async function overviewDown(e: PointerEvent) {
    if (!overview || total === 0) return;
    const { row, perPixel } = overviewRow(e);
    const found = await api.compareHunkNear(id, row, Math.ceil(OVERVIEW_REACH * perPixel)).catch(() => null);
    if (!(await go(found))) scrollTo(row - visible / 2);
  }

  onMount(() => {
    // Registered by hand: preventDefault needs a non-passive listener.
    body?.addEventListener("wheel", onWheel, { passive: false });
    root.focus();
    return () => body?.removeEventListener("wheel", onWheel);
  });
</script>

<div class="compare-view" bind:this={root} tabindex="-1" role="grid" aria-readonly="true" {onkeydown} style:--digits="{digits}ch">
  <div class="body" bind:this={body} bind:clientHeight={bodyH}>
    {#each SIDES as side, s (side)}
      <div class="side {side}" class:no-shading={!settings.fieldShading}>
        {#if settings.lineNumbers}
          <div class="gutter" aria-hidden="true">
            {#each shown as one, i (i)}
              <div class="ln" class:current={one.row.hunk !== null && one.row.hunk === current}>{one.row[side] ? one.row[side].line + 1 : ""}</div>
            {/each}
          </div>
        {/if}
        <div class="signs" aria-hidden="true">
          {#each shown as one, i (i)}
            {@const k = kind(one.row, side)}
            <div class="sign {k}">{SIGNS[k]}</div>
          {/each}
        </div>
        <div class="text" bind:this={texts[s]} onscroll={(e) => sideways(e.currentTarget)}>
          <div class="lines">
            {#each shown as one, i (i)}
              {@const segs = one.sides[s]}
              {@const line = one.row[side]}
              {@const edited = !!line && editing?.side === side && editing.line === line.line}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="line {kind(one.row, side)} {edges(i, side)}"
                class:current={one.row.hunk !== null && one.row.hunk === current}
                class:picked={!!line && picked?.side === side && picked.line === line.line}
                role="row"
                tabindex="-1"
                onclick={() => pick(one.row, side)}
                ondblclick={() => line && edit({ side, line: line.line })}
                oncontextmenu={(e) => openMenu(e, one.row, side)}
              >{#if edited && editing}<input
                    class="edit"
                    bind:value={editing.value}
                    spellcheck="false"
                    aria-label={t("compare.editLine")}
                    onkeydown={editKeydown}
                    onblur={commit}
                    onclick={(e) => e.stopPropagation()}
                    ondblclick={(e) => e.stopPropagation()}
                  />{:else if segs}{#each segs as seg, k (k)}<span class={seg.cls}>{seg.text}</span>{/each}{#if line?.truncated}<span class="truncated">⋯</span>{/if}{/if}</div>
            {/each}
          </div>
        </div>
      </div>
      {#if s === 0}
        <div class="middle">
          {#each shown as one, i (i)}
            {#if one.first}
              <div class="copy" style:top="{i * lineH}px">
                <button title={t("compare.copyRight")} aria-label={t("compare.copyRight")} tabindex="-1" onclick={() => onmerge(one.row.hunk!, "right")}>›</button>
                <button title={t("compare.copyLeft")} aria-label={t("compare.copyLeft")} tabindex="-1" onclick={() => onmerge(one.row.hunk!, "left")}>‹</button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/each}
    <div
      class="overview"
      bind:clientHeight={overviewH}
      role="scrollbar"
      aria-controls="compare-rows"
      aria-valuenow={top}
      aria-valuemin={0}
      aria-valuemax={maxTop}
      tabindex="-1"
      onpointerdown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging = true;
        overviewDown(e);
      }}
      onpointermove={(e) => {
        if (dragging) overviewAt(e);
        else onMark = nearMark(e);
      }}
      onpointerup={(e) => {
        dragging = false;
        onMark = nearMark(e);
      }}
      onpointerleave={() => (onMark = false)}
      class:on-mark={onMark}
    >
      <canvas bind:this={overview}></canvas>
      {#if thumb}
        <div class="thumb" class:dragging style:top="{thumb.top}px" style:height="{thumb.height}px"></div>
      {/if}
    </div>
  </div>
</div>

{#if menu}
  <DropMenu items={menu.items} point={menu.point} onclose={closeMenu} />
{/if}

<style>
  .compare-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
    font-family: var(--mono);
    font-size: var(--font-size);
    line-height: var(--line-h);
    --changed: rgba(38, 125, 210, 0.2);
    --changed-mark: rgba(70, 160, 255, 0.45);
    --removed: rgba(255, 0, 0, 0.14);
    --added: rgba(155, 185, 85, 0.16);
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .side {
    display: flex;
    flex: 1;
    min-width: 0;
  }
  .gutter {
    flex: none;
    width: var(--digits);
    padding: 0 10px 0 8px;
    text-align: right;
    color: var(--gutter);
    user-select: none;
    overflow: hidden;
  }
  .ln,
  .sign,
  .line {
    height: var(--line-h);
  }
  /* What a row is, apart from its color: ~ changed, − only on the left, + only on the right. */
  .signs {
    flex: none;
    width: 1.5ch;
    text-align: center;
    user-select: none;
  }
  .sign.changed {
    color: #4fa3e8;
  }
  .sign.removed {
    color: #f14c4c;
  }
  .sign.added {
    color: #73c991;
  }
  .ln.current {
    color: var(--fg);
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .lines {
    min-width: max-content;
  }
  .line {
    padding-left: 4px;
    white-space: pre;
    tab-size: 8;
    overflow: clip;
    cursor: default;
  }
  .line.changed {
    background: var(--changed);
  }
  .changed :global(.mark) {
    background: var(--changed-mark);
  }
  .line.removed {
    background: var(--removed);
  }
  .line.added {
    background: var(--added);
  }
  /* Nothing here: what is across has no line on this side. */
  .line.filler {
    background: repeating-linear-gradient(-45deg, transparent 0 4px, rgba(255, 255, 255, 0.1) 4px 6px);
  }
  .line.filler.first {
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3);
  }
  .line.filler.last {
    box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.3);
  }
  .line.filler.first.last {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.3),
      inset 0 -1px 0 rgba(255, 255, 255, 0.3);
  }
  /* A bar of its own, so as not to take the place of the filler's lines. */
  /* The line F2 and Ctrl+E work on. */
  .line.picked {
    outline: 1px solid rgba(255, 255, 255, 0.2);
    outline-offset: -1px;
  }
  .edit {
    box-sizing: border-box;
    width: 100%;
    min-width: 30ch;
    height: var(--line-h);
    margin: 0 0 0 -3px;
    padding: 0 2px;
    border: 1px solid var(--accent);
    border-radius: 0;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    line-height: inherit;
  }
  .line.current {
    position: relative;
  }
  .line.current::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: var(--accent);
  }
  .middle {
    position: relative;
    flex: none;
    width: 40px;
    border-inline: 1px solid var(--border);
    background: var(--panel);
  }
  .copy {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    gap: 2px;
    height: var(--line-h);
  }
  .copy button {
    width: 17px;
    height: calc(var(--line-h) - 2px);
    margin-top: 1px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--muted);
    font-family: var(--ui);
    font-size: 15px;
    line-height: 1;
  }
  .copy button:hover {
    background: #45494e;
    color: var(--fg);
  }
  .overview {
    position: relative;
    flex: none;
    width: 16px;
    border-left: 1px solid var(--border);
    cursor: default;
    touch-action: none;
  }
  .overview.on-mark {
    cursor: pointer;
  }
  .overview canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .thumb {
    position: absolute;
    left: 1px;
    right: 1px;
    border-radius: 2px;
    background: rgba(121, 121, 121, 0.35);
    pointer-events: none;
  }
  .thumb.dragging {
    background: rgba(160, 160, 160, 0.5);
  }
</style>
