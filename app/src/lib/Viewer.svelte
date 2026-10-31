<script lang="ts">
  // Read-only viewport. Only the visible lines exist on the frontend; the
  // position is a byte offset (`view.top`), so scrolling works before the
  // line index is done. The scrollbar is drawn by hand because a browser
  // element cannot be tall enough for millions of lines (~33.5 M px limit).

  import { onMount, untrack } from "svelte";
  import * as api from "./api";
  import { applyMarks, tokenize, type Lang } from "./syntax";

  interface Props {
    doc: api.DocInfo;
    lang: Lang;
    /** Bytes the line index has covered so far. */
    indexed: number;
    /** Lines known so far, for the gutter width. */
    lines: number;
    onview?: (view: api.View) => void;
  }

  let { doc, lang, indexed, lines, onview }: Props = $props();

  const LINE_H = 20;
  const MIN_THUMB = 24;

  let root: HTMLDivElement;
  let text: HTMLDivElement;
  let height = $state(0);
  let trackH = $state(0);
  let rows = $derived(Math.max(1, Math.floor(height / LINE_H)));
  let view = $state<api.View | null>(null);
  let error = $state<string | null>(null);
  let marks: api.Mark[] = [];

  // One request in flight at a time; scrolling in the meantime is merged
  // into the next request, so fast wheels and drags never queue up.
  let inflight = false;
  let pendingDelta = 0;
  let pendingJump: api.ViewTarget | null = null;
  let pendingRefresh = false;

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
      return;
    }
    pendingRefresh = false;
    inflight = true;
    const id = doc.id;
    api
      .view(id, target, rows, marks)
      .then(
        (next) => {
          if (id !== doc.id) return;
          view = next;
          error = null;
          onview?.(next);
        },
        (e) => (error = String(e)),
      )
      .finally(() => {
        inflight = false;
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

  export function gotoLine(line: number) {
    jump({ kind: "line", line });
  }

  export function topOffset() {
    return view?.top ?? 0;
  }

  export function focus() {
    root.focus();
  }

  /** Highlights `[offset, offset + len)`, scrolling to it unless already in view. */
  export function reveal(offset: number, len: number) {
    marks = [{ offset, len }];
    if (view && offset >= view.top && offset + len <= view.end) refresh();
    else jump({ kind: "offset", offset, context: Math.floor(rows / 3) });
  }

  export function clearMarks() {
    if (!marks.length) return;
    marks = [];
    refresh();
  }

  // A new document starts at the top.
  $effect(() => {
    void doc.id;
    untrack(() => {
      view = null;
      error = null;
      marks = [];
      jump({ kind: "fraction", fraction: 0 });
    });
  });

  // Resizing changes how many lines to fetch.
  $effect(() => {
    void rows;
    untrack(refresh);
  });

  // Line numbers appear once the background index passes the top line.
  $effect(() => {
    const scanned = indexed;
    untrack(() => {
      if (view && view.firstLine === null && scanned >= view.top) refresh();
    });
  });

  let wheelPx = 0;
  function onWheel(e: WheelEvent) {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal: native
    e.preventDefault();
    const scale = e.deltaMode === 1 ? LINE_H : e.deltaMode === 2 ? rows * LINE_H : 1;
    wheelPx += e.deltaY * scale;
    const n = Math.trunc(wheelPx / LINE_H);
    wheelPx -= n * LINE_H;
    scrollLines(n);
  }

  onMount(() => {
    // Registered by hand: preventDefault needs a non-passive listener.
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  });

  function onkeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, rows - 1);
    if (e.key === "ArrowDown") scrollLines(1);
    else if (e.key === "ArrowUp") scrollLines(-1);
    else if (e.key === "PageDown") scrollLines(page);
    else if (e.key === "PageUp") scrollLines(-page);
    else if (e.key === "Home" && mod) jump({ kind: "fraction", fraction: 0 });
    else if (e.key === "End" && mod) jump({ kind: "fraction", fraction: 1 });
    else if (e.key === "Home") text.scrollLeft = 0;
    else return;
    e.preventDefault();
  }

  // Scrollbar: thumb position is `top / maxTop`, its size the share of
  // bytes on screen.
  let dragTop = $state<number | null>(null);
  let dragFrom = { y: 0, top: 0 };
  let thumbH = $derived(
    !view || doc.len === 0
      ? trackH
      : Math.min(trackH, Math.max(MIN_THUMB, (trackH * (view.end - view.top)) / doc.len)),
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

  function thumbUp() {
    dragTop = null;
  }

  function trackDown(e: PointerEvent) {
    const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    const page = Math.max(1, rows - 1);
    scrollLines(y < thumbTop ? -page : page);
  }

  let gutterCh = $derived(
    Math.max(4, String(Math.max(lines, (view?.firstLine ?? 0) + rows)).length) + 1,
  );
</script>

<div
  class="viewer"
  bind:this={root}
  tabindex="0"
  role="textbox"
  aria-readonly="true"
  aria-multiline="true"
  {onkeydown}
>
  <div class="gutter" style:width="{gutterCh}ch">
    {#if view}
      {#each view.lines as line, i (line.offset)}
        <div class="ln">{view.firstLine === null ? "" : view.firstLine + i + 1}</div>
      {/each}
    {/if}
  </div>
  <div class="text" bind:this={text} bind:clientHeight={height}>
    {#if view}
      {#each view.lines as line (line.offset)}
        <div class="line">{#each applyMarks(tokenize(line.text, lang), line.marks) as seg}<span class={seg.cls}>{seg.text}</span>{/each}{#if line.truncated}<span class="truncated">⋯</span>{/if}</div>
      {/each}
    {/if}
  </div>
  <div class="vscroll" role="presentation" bind:clientHeight={trackH} onpointerdown={trackDown}>
    <div
      class="thumb"
      class:dragging={dragTop !== null}
      role="presentation"
      style:top="{thumbTop}px"
      style:height="{thumbH}px"
      onpointerdown={thumbDown}
      onpointermove={thumbMove}
      onpointerup={thumbUp}
      onpointercancel={thumbUp}
    ></div>
  </div>
  {#if error}
    <div class="error">{error}</div>
  {/if}
</div>

<style>
  .viewer {
    position: relative;
    display: flex;
    height: 100%;
    outline: none;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 20px;
    background: var(--bg);
    color: var(--fg);
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
    height: 20px;
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    white-space: pre;
    tab-size: 8;
  }
  .line {
    min-width: max-content;
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
  .text :global(.comment) {
    color: #6a9955;
  }
  .text :global(.keyword) {
    color: #569cd6;
    font-weight: 600;
  }
  .text :global(.param) {
    color: #9cdcfe;
  }
  .text :global(.value) {
    color: #ce9178;
  }
  .text :global(.card) {
    color: #4ec9b0;
    font-weight: 600;
  }
  .text :global(.cont),
  .text :global(.punct),
  .text :global(.truncated) {
    color: #808080;
  }
  .text :global(.fb) {
    background: rgba(255, 255, 255, 0.06);
  }
  .text :global(.mark) {
    background: rgba(234, 92, 0, 0.6);
    color: #fff;
  }
</style>
