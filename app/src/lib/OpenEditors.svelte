<script lang="ts">
  // The tabs of a pane in a list to filter and pick from: for when they no longer
  // fit in the strip.

  import { tick, untrack } from "svelte";
  import { t } from "./i18n";
  import type { TabItem } from "./TabBar.svelte";

  interface Props {
    tabs: TabItem[];
    active: number | null;
    onpick: (id: number) => void;
    onclose: () => void;
  }

  let { tabs, active, onpick, onclose }: Props = $props();

  let filter = $state("");
  // To start with, the tab already showing.
  let selected = $state(untrack(() => Math.max(0, tabs.findIndex((tab) => tab.id === active))));
  let list = $state<HTMLElement>();

  let shown = $derived.by(() => {
    const wanted = filter.trim().toLowerCase();
    return wanted ? tabs.filter((tab) => `${tab.name} ${tab.path ?? ""}`.toLowerCase().includes(wanted)) : tabs;
  });

  async function select(at: number) {
    selected = at;
    await tick();
    list?.children[at]?.scrollIntoView({ block: "nearest" });
  }

  function onkeydown(e: KeyboardEvent) {
    e.stopPropagation();
    const count = shown.length;
    if (e.key === "Escape") onclose();
    else if (e.key === "Enter") {
      if (shown[selected]) onpick(shown[selected].id);
    } else if (e.key === "ArrowDown" && count) select((selected + 1) % count);
    else if (e.key === "ArrowUp" && count) select((selected + count - 1) % count);
    else return;
    e.preventDefault();
  }

  const takeFocus = (input: HTMLElement) => input.focus();
</script>

<div class="cover" role="presentation" onmousedown={onclose}></div>
<div class="picker" role="dialog" aria-label={t("more.showOpen")}>
  <input
    use:takeFocus
    bind:value={filter}
    placeholder={t("openEditors.filter")}
    spellcheck="false"
    autocomplete="off"
    oninput={() => (selected = 0)}
    {onkeydown}
  />
  <div class="list" role="listbox" tabindex="-1" bind:this={list}>
    {#each shown as tab, i (tab.id)}
      <button
        class="row"
        class:selected={i === selected}
        role="option"
        aria-selected={i === selected}
        tabindex="-1"
        onmousedown={(e) => e.preventDefault()}
        onmousemove={() => (selected = i)}
        onclick={() => onpick(tab.id)}
      >
        <span class="name">{tab.name}</span>
        {#if tab.dirty}<span class="dirty">●</span>{/if}
        <span class="path">{tab.path ?? ""}</span>
      </button>
    {:else}
      <p class="none">{t("openEditors.none")}</p>
    {/each}
  </div>
</div>

<style>
  .cover {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .picker {
    position: fixed;
    top: 36px;
    left: 50%;
    z-index: 61;
    width: min(560px, 90vw);
    padding: 6px;
    box-sizing: border-box;
    transform: translateX(-50%);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  }
  input {
    width: 100%;
    box-sizing: border-box;
  }
  .list {
    max-height: min(320px, 50vh);
    margin-top: 6px;
    overflow-y: auto;
    outline: none;
  }
  .row {
    display: flex;
    width: 100%;
    align-items: baseline;
    gap: 8px;
    padding: 3px 8px;
    border: none;
    border-radius: 3px;
    background: transparent;
    text-align: left;
    white-space: nowrap;
  }
  .row:hover {
    background: transparent;
  }
  .row.selected {
    background: var(--accent);
    color: #fff;
  }
  .name {
    flex: none;
  }
  .path {
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
  }
  .row.selected .path {
    color: inherit;
  }
  .none {
    margin: 4px 8px;
    color: var(--muted);
  }
</style>
