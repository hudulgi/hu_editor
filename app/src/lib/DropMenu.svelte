<script lang="ts" module>
  export interface DropItem {
    label: string;
    shortcut?: string;
    enabled?: boolean;
    /** Set for an on/off item. */
    checked?: boolean;
    /** False: the command palette has it from elsewhere. */
    palette?: false;
    run: () => void;
  }

  /** An item that opens more items beside it. */
  export interface DropSubmenu {
    label: string;
    enabled?: boolean;
    items: (DropItem | "separator")[];
  }

  export type DropEntry = DropItem | DropSubmenu | "separator";
</script>

<script lang="ts">
  // A menu hanging from a button or opened at a point. Fixed in the window, since
  // a pane clips what leaves it. It holds the keyboard while open; the caller
  // takes it back.

  import { onMount, tick, untrack } from "svelte";

  interface Props {
    items: DropEntry[];
    /** The button it hangs from; a click on that is for the button to answer. */
    anchor?: HTMLElement;
    /** Where it opens, if not at a button. */
    point?: { x: number; y: number };
    onclose: () => void;
  }

  let { items, anchor, point, onclose }: Props = $props();

  /** How long a submenu stays when the mouse goes past other items on its way there. */
  const SUBMENU_STAYS = 300;
  const MARGIN = 4;

  let panel: HTMLElement;
  let subPanel = $state<HTMLElement>();
  let place = $state({ left: 0, top: 0 });
  /** The open submenu, by its place in the menu. */
  let subAt = $state<number | null>(null);
  let subPlace = $state({ left: 0, top: 0 });
  let subTimer: ReturnType<typeof setTimeout> | undefined;

  const inSub = () => !!subPanel?.contains(document.activeElement);
  /** The items the arrow keys go through: of the submenu with the keyboard, or else of the menu. */
  const buttons = () =>
    [...(inSub() ? subPanel! : panel).querySelectorAll<HTMLElement>(":scope > button:not(:disabled), :scope > .parent > button:not(:disabled)")];

  /** A place for a box of this size, as near as fits in the window. */
  const inWindow = (left: number, top: number, box: DOMRect) => ({
    left: Math.max(MARGIN, Math.min(left, innerWidth - box.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, innerHeight - box.height - MARGIN)),
  });

  onMount(() => {
    panel.focus();
    const box = panel.getBoundingClientRect();
    const button = untrack(() => anchor)?.getBoundingClientRect();
    const at = untrack(() => point);
    place = button ? inWindow(button.right - box.width, button.bottom + 3, box) : inWindow(at?.x ?? 0, at?.y ?? 0, box);
  });

  function pick(item: DropItem) {
    onclose();
    item.run();
  }

  async function openSub(at: number, takeKeyboard: boolean) {
    clearTimeout(subTimer);
    if (subAt !== at) {
      subAt = at;
      await tick();
      const parent = subPanel!.parentElement!.getBoundingClientRect();
      const box = subPanel!.getBoundingClientRect();
      // Beside the item: on the left if there is no room on the right.
      const left = parent.right + box.width + MARGIN <= innerWidth ? parent.right + 2 : parent.left - box.width - 2;
      subPlace = inWindow(left, parent.top - 5, box);
    }
    if (takeKeyboard) {
      await tick();
      subPanel?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    }
  }

  function closeSubNow() {
    clearTimeout(subTimer);
    subAt = null;
  }

  /** Back to the item it opened from. */
  function closeSub() {
    subPanel?.parentElement?.querySelector<HTMLElement>(":scope > button")?.focus();
    closeSubNow();
  }

  /** The mouse moved to another item of the menu: the submenu goes unless it gets there soon. */
  function closeSubSoon() {
    if (subAt === null) return;
    clearTimeout(subTimer);
    subTimer = setTimeout(closeSubNow, SUBMENU_STAYS);
  }

  function onkeydown(e: KeyboardEvent) {
    // A shortcut of the app: it acts where the keyboard was.
    if (e.ctrlKey || e.metaKey || e.altKey) return onclose();
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const opensSub = (document.activeElement as HTMLElement).dataset.sub;
    if (e.key === "Escape" && inSub()) closeSub();
    else if (e.key === "Escape" || e.key === "Tab") onclose();
    else if (e.key === "ArrowLeft" && inSub()) closeSub();
    else if (e.key === "ArrowRight" && opensSub !== undefined) openSub(Number(opensSub), true);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!inSub()) closeSubNow();
      const next = e.key === "ArrowDown" ? (at + 1) % list.length : at <= 0 ? list.length - 1 : at - 1;
      list[next]?.focus();
    } else if (e.key === "Home") list[0]?.focus();
    else if (e.key === "End") list.at(-1)?.focus();
    else if ((e.key === "Enter" || e.key === " ") && at >= 0) list[at].click();
    e.preventDefault();
    e.stopPropagation();
  }

  function onwindowmousedown(e: MouseEvent) {
    if (!panel.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onclose();
  }
</script>

<svelte:window onmousedowncapture={onwindowmousedown} onblur={onclose} />

{#snippet item(entry: DropItem, inSubmenu: boolean)}
  <button
    class="item"
    role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
    aria-checked={entry.checked}
    tabindex="-1"
    disabled={entry.enabled === false}
    onclick={() => pick(entry)}
    onmousedown={(e) => e.preventDefault()}
    onmousemove={(e) => {
      e.currentTarget.focus();
      if (inSubmenu) clearTimeout(subTimer);
      else closeSubSoon();
    }}
  >
    <span class="check">{entry.checked ? "✓" : ""}</span>
    <span class="label">{entry.label}</span>
    {#if entry.shortcut}<span class="shortcut">{entry.shortcut}</span>{/if}
  </button>
{/snippet}

<div
  class="drop-menu"
  role="menu"
  tabindex="-1"
  style:left="{place.left}px"
  style:top="{place.top}px"
  bind:this={panel}
  oncontextmenu={(e) => e.preventDefault()}
  {onkeydown}
>
  {#each items as entry, i (i)}
    {#if entry === "separator"}
      <div class="separator" role="separator"></div>
    {:else if "items" in entry}
      <div class="parent">
        <button
          class="item"
          class:open={subAt === i}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={subAt === i}
          tabindex="-1"
          disabled={entry.enabled === false}
          data-sub={i}
          onclick={() => openSub(i, true)}
          onmousedown={(e) => e.preventDefault()}
          onmousemove={(e) => {
            e.currentTarget.focus();
            openSub(i, false);
          }}
        >
          <span class="check"></span>
          <span class="label">{entry.label}</span>
          <span class="shortcut">›</span>
        </button>
        {#if subAt === i}
          <div
            class="drop-menu sub"
            role="menu"
            tabindex="-1"
            style:left="{subPlace.left}px"
            style:top="{subPlace.top}px"
            bind:this={subPanel}
            onmousemove={() => clearTimeout(subTimer)}
          >
            {#each entry.items as inner, k (k)}
              {#if inner === "separator"}
                <div class="separator" role="separator"></div>
              {:else}
                {@render item(inner, true)}
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      {@render item(entry, false)}
    {/if}
  {/each}
</div>

<style>
  .drop-menu {
    position: fixed;
    z-index: 50;
    width: max-content;
    min-width: 220px;
    max-height: calc(100vh - 8px);
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
  .item.open {
    background: #45494e;
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
