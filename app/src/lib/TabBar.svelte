<script lang="ts" module>
  import { langBadge, type Lang } from "./syntax";

  export interface TabItem {
    id: number;
    name: string;
    lang: Lang;
    /** Null for a new document. */
    path: string | null;
    dirty: boolean;
    /** Folder name, shown when another tab has the same file name. */
    hint: string | null;
    /** The next file opened as a preview takes its place. */
    preview: boolean;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { t } from "./i18n";

  interface Props {
    tabs: TabItem[];
    active: number | null;
    /** The keyboard is in this pane. */
    focused: boolean;
    onselect: (id: number) => void;
    onclose: (id: number) => void;
    /** A tab is being dragged, over this point. */
    ondrag: (x: number, y: number) => void;
    /** A dragged tab was let go at this point; no point if it did not get anywhere. */
    ondrop: (id: number, point: { x: number; y: number } | null) => void;
    /** A double click: the tab stops being a preview. */
    onpin: (id: number) => void;
    /** No new files open in this pane. */
    locked: boolean;
    onsplit: (down: boolean) => void;
    onunlock: () => void;
    onmore: (button: HTMLElement) => void;
  }

  let { tabs, active, focused, onselect, onclose, ondrag, ondrop, onpin, locked, onsplit, onunlock, onmore }: Props = $props();

  let strip: HTMLDivElement;

  // Keep the active tab in view.
  $effect(() => {
    void active;
    void tabs.length;
    tick().then(() => strip.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });

  /** A vertical wheel scrolls the strip sideways. */
  function onwheel(e: WheelEvent) {
    if (e.deltaY === 0) return;
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  }

  // Pointer events, not HTML drag and drop: Tauri takes those for files on Windows.
  const DRAG_START = 6;

  function onpointerdown(down: PointerEvent, id: number) {
    if (down.button !== 0) return;
    let dragging = false;
    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) >= DRAG_START) dragging = true;
      if (dragging) ondrag(e.clientX, e.clientY);
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (dragging) ondrop(id, e.type === "pointerup" ? { x: e.clientX, y: e.clientY } : null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onmousedown(e: MouseEvent, id: number) {
    // Keep the focus in the editor, which the app moves to the selected tab.
    e.preventDefault();
    // Middle click closes, like a browser.
    if (e.button === 1) onclose(id);
    else if (e.button === 0) onselect(id);
  }
</script>

<div class="bar" class:focused>
<div class="strip" class:focused role="tablist" bind:this={strip} {onwheel}>
  {#each tabs as tab (tab.id)}
    <div
      class="tab"
      class:active={tab.id === active}
      class:dirty={tab.dirty}
      class:preview={tab.preview}
      role="tab"
      tabindex="-1"
      aria-selected={tab.id === active}
      title={tab.path ?? t("tabs.notSaved", { name: tab.name })}
      onmousedown={(e) => onmousedown(e, tab.id)}
      onpointerdown={(e) => onpointerdown(e, tab.id)}
      ondblclick={() => onpin(tab.id)}
    >
      {#if tab.lang !== "plain"}
        {@const badge = langBadge(tab.lang)}
        <span class="badge {badge.cls}">{badge.text}</span>
      {/if}
      <span class="name" class:untitled={tab.path === null}>{tab.name}</span>
      {#if tab.hint}
        <span class="hint">{tab.hint}</span>
      {/if}
      <button
        class="close"
        title={t("tabs.close")}
        aria-label={t("tabs.closeNamed", { name: tab.name })}
        onmousedown={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        onclick={() => onclose(tab.id)}
      >
        <svg class="x" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
        <svg class="dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.5" /></svg>
      </button>
    </div>
  {/each}
</div>
<!-- The buttons leave the keyboard where it is. -->
<div class="actions" role="toolbar">
  <button
    class="action split"
    title={t("tabs.split")}
    aria-label={t("tabs.split")}
    tabindex="-1"
    onmousedown={(e) => e.preventDefault()}
    onclick={(e) => onsplit(e.altKey)}
  >
    <svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M8 2.5v11" /></svg>
  </button>
  {#if locked}
    <button
      class="action lock"
      title={t("tabs.unlock")}
      aria-label={t("tabs.unlock")}
      tabindex="-1"
      onmousedown={(e) => e.preventDefault()}
      onclick={onunlock}
    >
      <svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="6.5" rx="1.5" /><path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2M8 9.75v1.25" /></svg>
    </button>
  {/if}
  <button
    class="action more"
    title={t("tabs.more")}
    aria-label={t("tabs.more")}
    aria-haspopup="menu"
    tabindex="-1"
    onmousedown={(e) => e.preventDefault()}
    onclick={(e) => onmore(e.currentTarget)}
  >
    <svg viewBox="0 0 16 16"><circle class="filled" cx="3.5" cy="8" r="1.1" /><circle class="filled" cx="8" cy="8" r="1.1" /><circle class="filled" cx="12.5" cy="8" r="1.1" /></svg>
  </button>
</div>
</div>

<style>
  .bar {
    display: flex;
    flex: none;
    height: 34px;
    background: var(--panel);
    user-select: none;
  }
  .strip {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    color: var(--muted);
  }
  .bar.focused .actions {
    color: var(--fg);
  }
  .action {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
  }
  .action:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .action.lock {
    background: rgba(255, 255, 255, 0.14);
  }
  .action svg {
    width: 16px;
    height: 16px;
  }
  .filled {
    fill: currentColor;
    stroke: none;
  }
  .strip::-webkit-scrollbar {
    display: none;
  }
  .tab {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    padding: 0 6px 0 12px;
    border-right: 1px solid var(--border);
    border-top: 1px solid transparent;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
  }
  .tab:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg);
  }
  .strip.focused .tab.active {
    border-top-color: var(--accent);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.untitled,
  .tab.preview .name {
    font-style: italic;
  }
  .hint {
    color: var(--muted);
    font-size: 11px;
  }
  .badge {
    display: grid;
    flex: none;
    place-items: center;
    min-width: 14px;
    padding: 0 1px;
    box-sizing: border-box;
    height: 14px;
    border-radius: 3px;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
  }
  .badge.abaqus {
    background: #2b6cb0;
  }
  .badge.nastran {
    background: #2c7a6b;
  }
  .badge.code {
    background: #5a5f66;
  }
  .close {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
  }
  .close:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .dot {
    fill: currentColor;
    stroke: none;
  }
  /* The close button shows on the active or hovered tab; a dirty tab shows a dot instead until hovered. */
  .tab .x,
  .tab .dot,
  .tab.dirty:hover .dot {
    display: none;
  }
  .tab.active:not(.dirty) .x,
  .tab:hover .x,
  .tab.dirty:not(:hover) .dot {
    display: block;
  }
  .tab:not(.active):not(.dirty):not(:hover) .close {
    visibility: hidden;
  }
</style>
