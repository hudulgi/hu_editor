<script lang="ts" module>
  export interface MenuItem {
    label: string;
    /** The letter that picks it while its menu is open. */
    key: string;
    shortcut?: string;
    enabled?: boolean;
    /** Set for an on/off item. */
    checked?: boolean;
    run: () => void;
  }

  /** An item that opens more items beside it. */
  export interface Submenu {
    label: string;
    key: string;
    items: (MenuItem | "separator")[];
  }

  export type MenuEntry = MenuItem | Submenu | "separator";

  export interface Menu {
    label: string;
    /** The letter that opens it, with Alt. */
    key: string;
    items: MenuEntry[];
  }
</script>

<script lang="ts">
  // The menu bar, drawn here rather than by the OS so that it follows the theme
  // and the language. While it is in use it holds the keyboard, which also keeps
  // an IME from composing the letters that pick items; the keyboard then goes
  // back to where it was, before the item runs. The mouse counts when it moves,
  // not when a menu opens under it: that must not take the place of the keyboard.

  import { tick } from "svelte";

  interface Props {
    menus: Menu[];
  }

  let { menus }: Props = $props();

  /** How long a submenu stays when the mouse goes past other items on its way there. */
  const SUBMENU_STAYS = 300;

  let bar: HTMLElement;
  let openAt = $state<number | null>(null);
  /** The open submenu, by its place in the open menu. */
  let subAt = $state<number | null>(null);
  /**
   * Moved to stay inside the window: to the menu's left, as the OS's are,
   * where the right has no room; on the roomier side where neither has, moved
   * over the menu by no more than it must be.
   */
  let subFit = $state({ flip: false, dx: 0, up: 0 });
  let subPanel = $state<HTMLElement>();
  let subTimer: ReturnType<typeof setTimeout> | undefined;
  let cameFrom: HTMLElement | null = null;

  const titles = () => [...bar.querySelectorAll<HTMLElement>(".title")];
  const inSub = () => !!subPanel?.contains(document.activeElement);
  /** The items the arrow keys go through: of the submenu with the keyboard, or else of the menu. */
  const items = () => {
    const level = inSub() ? subPanel : bar.querySelector(".panel");
    return [...(level?.querySelectorAll<HTMLElement>(":scope > button:not(:disabled), :scope > .parent > button:not(:disabled)") ?? [])];
  };
  const holdsKeyboard = () => bar.contains(document.activeElement);

  function enter() {
    if (!holdsKeyboard() && document.activeElement instanceof HTMLElement) cameFrom = document.activeElement;
  }

  function leave() {
    closeSubNow();
    openAt = null;
    if (holdsKeyboard()) (document.activeElement as HTMLElement).blur();
    cameFrom?.focus();
    cameFrom = null;
  }

  async function show(at: number, start: "title" | "first" | "last") {
    enter();
    closeSubNow();
    openAt = at;
    await tick();
    const list = items();
    const target = start === "first" ? list[0] : start === "last" ? list.at(-1) : null;
    (target ?? titles()[at]).focus();
  }

  async function openSub(at: number, takeKeyboard: boolean) {
    clearTimeout(subTimer);
    if (subAt !== at) {
      subAt = at;
      subFit = { flip: false, dx: 0, up: 0 };
      await tick();
      const box = subPanel!.getBoundingClientRect();
      const menu = subPanel!.parentElement!.getBoundingClientRect();
      const right = innerWidth - 4 - box.left;
      const left = menu.left - 2 - 4;
      const flip = box.width > right && left > right;
      const dx = flip ? Math.max(0, box.width - left) : -Math.max(0, box.width - right);
      subFit = { flip, dx, up: Math.max(0, box.bottom - innerHeight + 4) };
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

  /** Alt+letter; false if no menu has that letter. */
  export function openByKey(code: string) {
    const at = menus.findIndex((menu) => `Key${menu.key}` === code);
    if (at < 0) return false;
    show(at, "first");
    return true;
  }

  /** Alt alone, F10: the keyboard goes to the menu titles, or back. */
  export function toggleKeyboard() {
    if (holdsKeyboard()) leave();
    else {
      enter();
      titles()[0].focus();
    }
  }

  function pick(item: MenuItem) {
    leave();
    item.run();
  }

  function pickByLetter(code: string) {
    if (openAt === null) {
      const at = menus.findIndex((menu) => `Key${menu.key}` === code);
      if (at >= 0) show(at, "first");
      return;
    }
    const entries = menus[openAt].items;
    const list: MenuEntry[] = inSub() ? (entries[subAt!] as Submenu).items : entries;
    for (const [at, entry] of list.entries()) {
      if (entry === "separator" || `Key${entry.key}` !== code) continue;
      if ("items" in entry) return void openSub(at, true);
      if (entry.enabled !== false) return pick(entry);
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (["Control", "Meta", "Shift", "Alt"].includes(e.key) || e.altKey) return;
    // A shortcut of the app: it acts where the keyboard was.
    if (e.ctrlKey || e.metaKey) return leave();

    const list = items();
    const item = list.indexOf(document.activeElement as HTMLElement);
    const title = openAt ?? titles().indexOf(document.activeElement as HTMLElement);
    const count = menus.length;
    const opensSub = (document.activeElement as HTMLElement).dataset.sub;
    switch (e.key) {
      case "Escape":
        if (inSub()) closeSub();
        else leave();
        break;
      case "Tab":
      case "F10":
        leave();
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        if (e.key === "ArrowLeft" && inSub()) {
          closeSub();
          break;
        }
        if (e.key === "ArrowRight" && opensSub !== undefined) {
          openSub(Number(opensSub), true);
          break;
        }
        const next = (title + (e.key === "ArrowLeft" ? count - 1 : 1)) % count;
        if (openAt === null) titles()[next].focus();
        else show(next, "first");
        break;
      }
      case "ArrowDown":
        if (openAt === null) show(title, "first");
        else {
          if (!inSub()) closeSubNow();
          list[(item + 1) % list.length]?.focus();
        }
        break;
      case "ArrowUp":
        if (openAt === null) show(title, "last");
        else {
          if (!inSub()) closeSubNow();
          list[item <= 0 ? list.length - 1 : item - 1]?.focus();
        }
        break;
      case "Home":
        list[0]?.focus();
        break;
      case "End":
        list.at(-1)?.focus();
        break;
      case "Enter":
      case " ":
        if (item >= 0) list[item].click();
        else show(title, "first");
        break;
      default:
        pickByLetter(e.code);
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onwindowmousedown(e: MouseEvent) {
    if ((openAt !== null || holdsKeyboard()) && !bar.contains(e.target as Node)) leave();
  }

  /** Splits a label around its letter, or adds the letter, the way Korean menus do: 열기(O)… */
  function marked(label: string, key: string) {
    const dots = label.endsWith("…") ? "…" : "";
    const text = dots ? label.slice(0, -1) : label;
    // A file's path, in Open Recent, has no letter.
    if (!key) return { before: label, letter: "", after: "" };
    const atWord = text.search(new RegExp(`\\b${key}`, "i"));
    const at = atWord >= 0 ? atWord : text.toLowerCase().indexOf(key.toLowerCase());
    if (at < 0) return { before: `${text}(`, letter: key, after: `)${dots}` };
    return { before: text.slice(0, at), letter: text[at], after: text.slice(at + 1) + dots };
  }
</script>

<svelte:window onmousedowncapture={onwindowmousedown} onblur={() => openAt !== null && leave()} />

{#snippet labelled(label: string, key: string)}
  {@const parts = marked(label, key)}
  {parts.before}<u>{parts.letter}</u>{parts.after}
{/snippet}

{#snippet item(entry: MenuItem, inSubmenu: boolean)}
  <button
    class="item"
    role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
    aria-checked={entry.checked}
    tabindex="-1"
    disabled={entry.enabled === false}
    onclick={() => pick(entry)}
    onmousemove={(e) => {
      e.currentTarget.focus();
      if (inSubmenu) clearTimeout(subTimer);
      else closeSubSoon();
    }}
  >
    <span class="check">{entry.checked ? "✓" : ""}</span>
    <span class="label">{@render labelled(entry.label, entry.key)}</span>
    {#if entry.shortcut}<span class="shortcut">{entry.shortcut}</span>{/if}
  </button>
{/snippet}

<div class="menubar" role="menubar" tabindex="-1" bind:this={bar} {onkeydown}>
  {#each menus as menu, i (menu.key)}
    <div class="entry">
      <button
        class="title"
        class:open={openAt === i}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={openAt === i}
        tabindex="-1"
        onmousedown={(e) => {
          e.preventDefault();
          if (openAt === i) leave();
          else show(i, "title");
        }}
        onmousemove={() => {
          if (openAt !== null && openAt !== i) show(i, "title");
        }}>{@render labelled(menu.label, menu.key)}</button
      >
      {#if openAt === i}
        <div class="panel" role="menu">
          {#each menu.items as entry, j (j)}
            {#if entry === "separator"}
              <div class="separator" role="separator"></div>
            {:else if "items" in entry}
              <div class="parent">
                <button
                  class="item"
                  class:open={subAt === j}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={subAt === j}
                  tabindex="-1"
                  data-sub={j}
                  onclick={() => openSub(j, true)}
                  onmousemove={(e) => {
                    e.currentTarget.focus();
                    openSub(j, false);
                  }}
                >
                  <span class="check"></span>
                  <span class="label">{@render labelled(entry.label, entry.key)}</span>
                  <span class="shortcut">›</span>
                </button>
                {#if subAt === j}
                  <div
                    class="panel sub"
                    class:flip={subFit.flip}
                    role="menu"
                    tabindex="-1"
                    style:translate="{subFit.dx}px {-subFit.up}px"
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
      {/if}
    </div>
  {/each}
</div>

<style>
  .menubar {
    display: flex;
    flex: none;
    align-items: center;
    outline: none;
  }
  .entry {
    position: relative;
  }
  .title {
    padding: 2px 8px;
    border: none;
    background: transparent;
    outline: none;
    white-space: nowrap;
  }
  .title:hover,
  .title:focus,
  .title.open {
    background: #45494e;
  }
  .panel {
    position: absolute;
    top: calc(100% + 3px);
    left: 0;
    z-index: 50;
    width: max-content;
    min-width: 220px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    outline: none;
  }
  .parent {
    position: relative;
  }
  .panel.sub {
    top: -5px;
    left: calc(100% + 2px);
  }
  .panel.sub.flip {
    left: auto;
    right: calc(100% + 2px);
  }
  .panel.sub {
    max-height: calc(100vh - 8px);
    box-sizing: border-box;
    overflow-y: auto;
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
  u {
    text-underline-offset: 2px;
  }
</style>
