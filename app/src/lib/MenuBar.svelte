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

  export type MenuEntry = MenuItem | "separator";

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

  let bar: HTMLElement;
  let openAt = $state<number | null>(null);
  let cameFrom: HTMLElement | null = null;

  const titles = () => [...bar.querySelectorAll<HTMLElement>(".title")];
  const items = () => [...bar.querySelectorAll<HTMLElement>(".panel button:not(:disabled)")];
  const holdsKeyboard = () => bar.contains(document.activeElement);

  function enter() {
    if (!holdsKeyboard() && document.activeElement instanceof HTMLElement) cameFrom = document.activeElement;
  }

  function leave() {
    openAt = null;
    if (holdsKeyboard()) (document.activeElement as HTMLElement).blur();
    cameFrom?.focus();
    cameFrom = null;
  }

  async function show(at: number, start: "title" | "first" | "last") {
    enter();
    openAt = at;
    await tick();
    const list = items();
    const target = start === "first" ? list[0] : start === "last" ? list.at(-1) : null;
    (target ?? titles()[at]).focus();
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
    for (const entry of menus[openAt].items) {
      if (entry !== "separator" && entry.enabled !== false && `Key${entry.key}` === code) return pick(entry);
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
    switch (e.key) {
      case "Escape":
      case "Tab":
      case "F10":
        leave();
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const next = (title + (e.key === "ArrowLeft" ? count - 1 : 1)) % count;
        if (openAt === null) titles()[next].focus();
        else show(next, "first");
        break;
      }
      case "ArrowDown":
        if (openAt === null) show(title, "first");
        else list[(item + 1) % list.length]?.focus();
        break;
      case "ArrowUp":
        if (openAt === null) show(title, "last");
        else list[item <= 0 ? list.length - 1 : item - 1]?.focus();
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
            {:else}
              <button
                class="item"
                role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={entry.checked}
                tabindex="-1"
                disabled={entry.enabled === false}
                onclick={() => pick(entry)}
                onmousemove={(e) => e.currentTarget.focus()}
              >
                <span class="check">{entry.checked ? "✓" : ""}</span>
                <span class="label">{@render labelled(entry.label, entry.key)}</span>
                {#if entry.shortcut}<span class="shortcut">{entry.shortcut}</span>{/if}
              </button>
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
  u {
    text-underline-offset: 2px;
  }
</style>
