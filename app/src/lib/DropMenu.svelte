<script lang="ts" module>
  export interface DropItem {
    label: string;
    shortcut?: string;
    enabled?: boolean;
    /** Set for an on/off item. */
    checked?: boolean;
    run: () => void;
  }

  export type DropEntry = DropItem | "separator";
</script>

<script lang="ts">
  // A menu hanging from a button. Fixed in the window, since a pane clips what
  // leaves it. It holds the keyboard while open; the caller takes it back.

  import { onMount, untrack } from "svelte";

  interface Props {
    items: DropEntry[];
    /** The button it hangs from; a click on that is for the button to answer. */
    anchor: HTMLElement;
    onclose: () => void;
  }

  let { items, anchor, onclose }: Props = $props();

  let panel: HTMLElement;
  /** Moved to stay inside the window. */
  let shift = $state(0);

  const box = untrack(() => anchor.getBoundingClientRect());
  const buttons = () => [...panel.querySelectorAll<HTMLElement>("button:not(:disabled)")];

  onMount(() => {
    panel.focus();
    shift = Math.max(0, 4 - panel.getBoundingClientRect().left);
  });

  function pick(item: DropItem) {
    onclose();
    item.run();
  }

  function onkeydown(e: KeyboardEvent) {
    // A shortcut of the app: it acts where the keyboard was.
    if (e.ctrlKey || e.metaKey || e.altKey) return onclose();
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") onclose();
    else if (e.key === "ArrowDown") list[(at + 1) % list.length]?.focus();
    else if (e.key === "ArrowUp") list[at <= 0 ? list.length - 1 : at - 1]?.focus();
    else if (e.key === "Home") list[0]?.focus();
    else if (e.key === "End") list.at(-1)?.focus();
    else if ((e.key === "Enter" || e.key === " ") && at >= 0) list[at].click();
    e.preventDefault();
    e.stopPropagation();
  }

  function onwindowmousedown(e: MouseEvent) {
    if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) onclose();
  }
</script>

<svelte:window onmousedowncapture={onwindowmousedown} onblur={onclose} />

<div
  class="drop-menu"
  role="menu"
  tabindex="-1"
  style:top="{box.bottom + 3}px"
  style:right="{innerWidth - box.right - shift}px"
  bind:this={panel}
  {onkeydown}
>
  {#each items as entry, i (i)}
    {#if entry === "separator"}
      <div class="separator" role="separator"></div>
    {:else}
      <button
        class="item"
        role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={entry.checked}
        tabindex="-1"
        disabled={entry.enabled === false}
        onclick={() => pick(entry)}
        onmousedown={(e) => e.preventDefault()}
        onmousemove={(e) => e.currentTarget.focus()}
      >
        <span class="check">{entry.checked ? "✓" : ""}</span>
        <span class="label">{entry.label}</span>
        {#if entry.shortcut}<span class="shortcut">{entry.shortcut}</span>{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .drop-menu {
    position: fixed;
    z-index: 50;
    width: max-content;
    min-width: 220px;
    max-height: calc(100vh - 60px);
    box-sizing: border-box;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    outline: none;
  }
  .item {
    display: flex;
    width: 100%;
    align-items: center;
    padding: 3px 12px 3px 4px;
    border: none;
    background: transparent;
    outline: none;
    text-align: left;
    white-space: nowrap;
  }
  .item:hover {
    background: transparent;
  }
  .item:focus {
    background: var(--accent);
    color: #fff;
  }
  .item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .check {
    flex: none;
    width: 18px;
    text-align: center;
  }
  .shortcut {
    margin-left: auto;
    padding-left: 32px;
    color: var(--muted);
  }
  .item:focus .shortcut {
    color: inherit;
  }
  .separator {
    height: 1px;
    margin: 4px 8px;
    background: var(--border);
  }
</style>
