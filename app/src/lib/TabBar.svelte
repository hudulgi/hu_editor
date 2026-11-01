<script lang="ts" module>
  import type { Lang } from "./syntax";

  export interface TabItem {
    id: number;
    name: string;
    lang: Lang;
    /** Null for a new document. */
    path: string | null;
    dirty: boolean;
    /** Folder name, shown when another tab has the same file name. */
    hint: string | null;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { t } from "./i18n";

  interface Props {
    tabs: TabItem[];
    active: number | null;
    onselect: (id: number) => void;
    onclose: (id: number) => void;
  }

  let { tabs, active, onselect, onclose }: Props = $props();

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

  function onmousedown(e: MouseEvent, id: number) {
    // Keep the focus in the editor, which the app moves to the selected tab.
    e.preventDefault();
    // Middle click closes, like a browser.
    if (e.button === 1) onclose(id);
    else if (e.button === 0) onselect(id);
  }
</script>

<div class="strip" role="tablist" bind:this={strip} {onwheel}>
  {#each tabs as tab (tab.id)}
    <div
      class="tab"
      class:active={tab.id === active}
      class:dirty={tab.dirty}
      role="tab"
      tabindex="-1"
      aria-selected={tab.id === active}
      title={tab.path ?? t("tabs.notSaved", { name: tab.name })}
      onmousedown={(e) => onmousedown(e, tab.id)}
    >
      {#if tab.lang !== "plain"}
        <span class="badge {tab.lang}">{tab.lang === "abaqus" ? "A" : "N"}</span>
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
        onclick={() => onclose(tab.id)}
      >
        <svg class="x" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
        <svg class="dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.5" /></svg>
      </button>
    </div>
  {/each}
</div>

<style>
  .strip {
    display: flex;
    flex: none;
    height: 34px;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--panel);
    scrollbar-width: none;
    user-select: none;
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
    border-top-color: var(--accent);
    color: var(--fg);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.untitled {
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
    width: 14px;
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
