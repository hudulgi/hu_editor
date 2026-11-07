<script lang="ts" module>
  export interface PickerItem {
    key: number | string;
    name: string;
    /** Shown after the name, dimmed; also searched. */
    detail?: string;
    /** A sign after the name: unsaved, on. */
    mark?: string;
    shortcut?: string;
  }
</script>

<script lang="ts">
  // A list to filter by typing and pick from: the tabs of a pane, the commands.

  import { tick, untrack } from "svelte";

  interface Props {
    items: PickerItem[];
    /** Marked to start with. */
    selected?: number | string | null;
    placeholder: string;
    /** Said when nothing matches. */
    none: string;
    label: string;
    /** An item made of what is typed, after the ones it matches: New File…'s file name. */
    typed?: (text: string) => PickerItem | null;
    onpick: (key: number | string) => void;
    onclose: () => void;
  }

  let { items, selected: first = null, placeholder, none, label, typed, onpick, onclose }: Props = $props();

  let filter = $state("");
  let list = $state<HTMLElement>();
  let selected = $state(untrack(() => Math.max(0, items.findIndex((item) => item.key === first))));

  let shown = $derived.by(() => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Every word somewhere in it, in any order.
    const matching = words.length
      ? items.filter((item) => {
          const text = `${item.name} ${item.detail ?? ""}`.toLowerCase();
          return words.every((word) => text.includes(word));
        })
      : items;
    const extra = filter.trim() ? typed?.(filter.trim()) : null;
    return extra ? [...matching, extra] : matching;
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
      if (shown[selected]) onpick(shown[selected].key);
    } else if (e.key === "ArrowDown" && count) select((selected + 1) % count);
    else if (e.key === "ArrowUp" && count) select((selected + count - 1) % count);
    else return;
    e.preventDefault();
  }

  const takeFocus = (input: HTMLElement) => input.focus();
</script>

<div class="cover" role="presentation" onmousedown={onclose}></div>
<div class="picker" role="dialog" aria-label={label}>
  <input use:takeFocus bind:value={filter} {placeholder} spellcheck="false" autocomplete="off" oninput={() => (selected = 0)} {onkeydown} />
  <div class="list" role="listbox" tabindex="-1" bind:this={list}>
    {#each shown as item, i (item.key)}
      <button
        class="row"
        class:selected={i === selected}
        role="option"
        aria-selected={i === selected}
        tabindex="-1"
        onmousedown={(e) => e.preventDefault()}
        onmousemove={() => (selected = i)}
        onclick={() => onpick(item.key)}
      >
        <span class="name">{item.name}</span>
        {#if item.mark}<span class="mark">{item.mark}</span>{/if}
        {#if item.detail}<span class="detail">{item.detail}</span>{/if}
        {#if item.shortcut}<span class="shortcut">{item.shortcut}</span>{/if}
      </button>
    {:else}
      <p class="none">{none}</p>
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
    max-height: min(360px, 50vh);
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
  .detail {
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
  }
  .shortcut {
    flex: none;
    margin-left: auto;
    padding-left: 24px;
    color: var(--muted);
    font-size: 12px;
  }
  .row.selected .detail,
  .row.selected .shortcut {
    color: inherit;
  }
  .none {
    margin: 4px 8px;
    color: var(--muted);
  }
</style>
