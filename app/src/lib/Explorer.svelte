<script lang="ts">
  // System file explorer: quick-access folders, then drives (`/` and
  // volumes outside Windows). Folders are listed when first expanded and
  // the tree is flattened into rows, so keyboard navigation is a list walk.
  // Opening a file reveals it, the way UltraEdit's explorer follows the
  // active file.

  import { onMount, tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import * as api from "./api";
  import { baseName, formatSize, isWindows, samePath } from "./format";
  import { describeError, t, type MessageKey } from "./i18n";
  import { settings } from "./settings.svelte";
  import { detectLang } from "./syntax";

  interface Props {
    /** Path of the open document, highlighted in the tree. */
    active: string | null;
    onopen: (path: string) => void;
  }

  let { active, onopen }: Props = $props();

  type Row =
    | { kind: "group"; key: string; label: string }
    | { kind: "entry"; key: string; entry: api.DirEntry; depth: number; root?: api.Root }
    | { kind: "note"; key: string; text: string; depth: number };

  const windows = isWindows;
  const GROUPS: readonly (readonly [api.Root["group"], MessageKey])[] = [
    ["quick", "explorer.quickAccess"],
    ["drives", windows ? "explorer.thisPc" : "explorer.locations"],
  ];
  const QUICK_NAMES: Partial<Record<api.Root["kind"], MessageKey>> = {
    home: "explorer.home",
    desktop: "explorer.desktop",
    documents: "explorer.documents",
    downloads: "explorer.downloads",
  };
  const SAVED_PATH = "hu.explorer.path";

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  let roots = $state<api.Root[]>([]);
  const ready = api.roots().then((r) => (roots = r));
  /** Listed folders: their entries, or the error message. */
  const listed = new SvelteMap<string, api.DirEntry[] | string>();
  /** Expanded nodes: tree key → folder path. A folder can appear under two roots. */
  const expanded = new SvelteMap<string, string>();
  let selected = $state<string | null>(null);
  let address = $state("");
  let addressError = $state<string | null>(null);
  let tree = $state<HTMLDivElement>();
  let addressInput = $state<HTMLInputElement>();
  let reveals = 0;

  const rootKey = (root: api.Root) => `${root.group}:${root.path}`;

  function sorted(entries: api.DirEntry[]) {
    // Folders first, then natural order (part2 before part10).
    return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name));
  }

  async function load(path: string) {
    try {
      listed.set(path, sorted(await api.listDir(path, settings.showHidden)));
    } catch (e) {
      listed.set(path, describeError(e));
    }
  }

  let rows = $derived.by(() => {
    const out: Row[] = [];
    const walk = (base: string, path: string, depth: number) => {
      const list = listed.get(path);
      const note = (text: string) => out.push({ kind: "note", key: `${base}|${path}\n`, text, depth });
      if (list === undefined) note(t("explorer.loading"));
      else if (typeof list === "string") note(list);
      else if (list.length === 0) note(t("explorer.empty"));
      else
        for (const entry of list) {
          const key = `${base}|${entry.path}`;
          out.push({ kind: "entry", key, entry, depth });
          if (entry.isDir && expanded.has(key)) walk(base, entry.path, depth + 1);
        }
    };
    for (const [group, labelKey] of GROUPS) {
      const members = roots.filter((r) => r.group === group);
      if (!members.length) continue;
      out.push({ kind: "group", key: group, label: t(labelKey) });
      for (const root of members) {
        const key = rootKey(root);
        const quickName = QUICK_NAMES[root.kind];
        const name = quickName ? t(quickName) : root.name;
        const entry = { name, path: root.path, isDir: true, size: 0 };
        out.push({ kind: "entry", key, entry, depth: 0, root });
        if (expanded.has(key)) walk(key, root.path, 1);
      }
    }
    return out;
  });

  // Element ids for aria-activedescendant; keys may contain any character.
  const ids = new Map<string, string>();
  function rowId(key: string) {
    let id = ids.get(key);
    if (!id) ids.set(key, (id = `tree-row-${ids.size}`));
    return id;
  }

  function select(key: string, path: string) {
    selected = key;
    // Not while the user is typing there: a reveal can finish at any moment.
    if (document.activeElement !== addressInput) address = path;
    addressError = null;
    localStorage.setItem(SAVED_PATH, path);
    // Long paths: show the end, where the file name is.
    tick().then(() => {
      if (addressInput && document.activeElement !== addressInput) {
        addressInput.scrollLeft = addressInput.scrollWidth;
      }
    });
  }

  async function expand(key: string, path: string) {
    expanded.set(key, path);
    if (!listed.has(path)) await load(path);
  }

  function toggle(key: string, path: string) {
    if (expanded.has(key)) expanded.delete(key);
    else expand(key, path);
  }

  function activate(row: Extract<Row, { kind: "entry" }>) {
    select(row.key, row.entry.path);
    if (row.entry.isDir) toggle(row.key, row.entry.path);
    else onopen(row.entry.path);
  }

  async function scrollToSelected(block: ScrollLogicalPosition) {
    await tick();
    tree?.querySelector(".row.selected")?.scrollIntoView({ block });
  }

  /**
   * Expands the drive tree down to `target` and selects it; a folder is
   * expanded too. Returns false if `target` is not an absolute path.
   */
  export async function reveal(target: string, isDir: boolean) {
    reveals++;
    await ready;
    const chain = await api.pathChain(target);
    if (!chain.length) return false;
    let root = roots.find((r) => r.group === "drives" && samePath(r.path, chain[0]));
    if (!root) {
      // A UNC share or other location without a drive: add it for this session.
      root = { name: chain[0], path: chain[0], group: "drives", kind: "network" };
      roots.push(root);
    }
    const base = rootKey(root);
    let key = base;
    let path = root.path;
    for (const [i, step] of chain.slice(1).entries()) {
      await expand(key, path);
      const list = listed.get(path);
      if (!Array.isArray(list)) break;
      let entry = list.find((e) => samePath(e.path, step));
      if (!entry) {
        // Hidden entries are not listed; show the ones this path runs through.
        const last = i === chain.length - 2;
        entry = { name: baseName(step), path: step, isDir: !last || isDir, size: 0, hidden: true };
        listed.set(path, sorted([...list, entry]));
      }
      key = `${base}|${entry.path}`;
      path = entry.path;
    }
    if (isDir) await expand(key, path);
    select(key, path);
    await scrollToSelected("center");
    return true;
  }

  /** Re-lists the expanded folders; collapsed ones are re-listed when expanded again. */
  export function refresh() {
    const open = new Set(expanded.values());
    for (const path of [...listed.keys()]) {
      if (open.has(path)) load(path);
      else listed.delete(path);
    }
  }

  async function go() {
    // Windows "Copy as path" wraps the path in quotes.
    const path = address.trim().replace(/^"(.*)"$/, "$1");
    if (!path) return;
    const kind = await api.pathKind(path);
    if (!kind || !(await reveal(path, kind === "dir"))) {
      addressError = t("explorer.notFound", { path });
      return;
    }
    address = path;
    if (kind === "file") onopen(path);
  }

  function addressKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") go();
    else if (e.key === "Escape") {
      address = localStorage.getItem(SAVED_PATH) ?? "";
      addressError = null;
      tree?.focus();
    } else return;
    e.preventDefault();
  }

  async function onkeydown(e: KeyboardEvent) {
    const entries = rows.filter((r) => r.kind === "entry");
    const i = entries.findIndex((r) => r.key === selected);
    const row = entries[i];
    const pick = (r: (typeof entries)[number] | undefined) => r && select(r.key, r.entry.path);
    if (e.key === "ArrowDown") pick(entries[Math.min(entries.length - 1, i + 1)]);
    else if (e.key === "ArrowUp") pick(entries[Math.max(0, i - 1)]);
    else if (e.key === "Enter" && row) activate(row);
    else if (e.key === "ArrowRight" && row?.entry.isDir) {
      if (!expanded.has(row.key)) toggle(row.key, row.entry.path);
    } else if (e.key === "ArrowLeft" && row) {
      if (row.entry.isDir && expanded.has(row.key)) toggle(row.key, row.entry.path);
      else pick(entries.slice(0, i).findLast((r) => r.depth < row.depth));
    } else return;
    e.preventDefault();
    await scrollToSelected("nearest");
  }

  // The setting changes what the open folders list.
  let listedHidden = settings.showHidden;
  $effect(() => {
    if (settings.showHidden !== listedHidden) {
      listedHidden = settings.showHidden;
      untrack(refresh);
    }
  });

  onMount(async () => {
    // Come back to where the user was, unless a file is being revealed already.
    await ready;
    const last = localStorage.getItem(SAVED_PATH);
    if (!last || reveals) return;
    const kind = await api.pathKind(last);
    if (kind && !reveals) reveal(last, false);
  });
</script>

<aside class="explorer">
  <header>
    <span class="title">{t("explorer.title")}</span>
    <button
      class="icon"
      title={t("explorer.showOpenFile")}
      aria-label={t("explorer.showOpenFile")}
      disabled={!active}
      onclick={() => active && reveal(active, false)}
    >
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /></svg>
    </button>
    <button class="icon" title={t("explorer.refresh")} aria-label={t("explorer.refresh")} onclick={refresh}>
      <svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" /></svg>
    </button>
    <button
      class="icon"
      title={t("explorer.collapseAll")}
      aria-label={t("explorer.collapseAll")}
      onclick={() => expanded.clear()}
    >
      <svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M5.5 8h5" /></svg>
    </button>
  </header>

  <div class="address">
    <input
      bind:this={addressInput}
      bind:value={address}
      placeholder={windows ? "C:\\path\\to\\deck.inp" : "/path/to/deck.inp"}
      spellcheck="false"
      title={t("explorer.address")}
      onkeydown={addressKeydown}
      onfocus={(e) => e.currentTarget.select()}
    />
    {#if addressError}
      <div class="address-error">{addressError}</div>
    {/if}
  </div>

  <!-- Focus stays on the tree, never on a row: a focused row would take the
       focus with it when its folder collapses. -->
  <div
    class="tree"
    role="tree"
    tabindex="0"
    aria-activedescendant={selected === null ? undefined : rowId(selected)}
    bind:this={tree}
    {onkeydown}
  >
    {#each rows as row (row.key)}
      {#if row.kind === "group"}
        <div class="group">{row.label}</div>
      {:else if row.kind === "entry"}
        {@const entry = row.entry}
        {@const lang = detectLang(entry.name)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus (the tree has focus and handles the keys) -->
        <div
          class="row"
          class:selected={row.key === selected}
          class:active={active !== null && samePath(entry.path, active)}
          class:hidden={entry.hidden}
          id={rowId(row.key)}
          role="treeitem"
          aria-selected={row.key === selected}
          aria-expanded={entry.isDir ? expanded.has(row.key) : undefined}
          title={entry.path}
          style:padding-left="{6 + row.depth * 14}px"
          onclick={() => activate(row)}
        >
          <span class="glyph">
            {#if entry.isDir}
              <svg class="chevron" class:open={expanded.has(row.key)} viewBox="0 0 16 16">
                <path d="M6 4l4 4-4 4" />
              </svg>
            {:else if lang !== "plain"}
              <span class="badge {lang}">{lang === "abaqus" ? "A" : "N"}</span>
            {/if}
          </span>
          {#if row.root}
            <svg class="root-icon" viewBox="0 0 16 16">
              {#if row.root.kind === "home"}
                <path d="M2.5 7.5L8 3l5.5 4.5M4 6.5V13h8V6.5" />
              {:else if row.root.kind === "desktop"}
                <rect x="2" y="3" width="12" height="8" rx="1" /><path d="M6 13.5h4M8 11v2.5" />
              {:else if row.root.kind === "documents"}
                <path d="M4 2h5l3 3v9H4zM9 2v3h3" />
              {:else if row.root.kind === "downloads"}
                <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />
              {:else if row.root.kind === "network"}
                <rect x="2" y="3" width="12" height="6" rx="1" /><path d="M8 9v3M3 13.5h10" />
              {:else if row.root.kind === "removable"}
                <path d="M5.5 2h5v4h-5z" /><rect x="3.5" y="6" width="9" height="8" rx="1" />
              {:else}
                <rect x="2" y="5" width="12" height="6" rx="1" /><path d="M11 8h.5" />
              {/if}
            </svg>
          {/if}
          <span class="name">{entry.name}</span>
          {#if !entry.isDir && (!entry.hidden || entry.size > 0)}
            <span class="size">{formatSize(entry.size)}</span>
          {/if}
        </div>
      {:else}
        <div class="row note" style:padding-left="{28 + row.depth * 14}px">{row.text}</div>
      {/if}
    {/each}
  </div>
</aside>

<style>
  .explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--panel);
    user-select: none;
  }
  header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: 34px;
    padding: 0 6px 0 14px;
  }
  .title {
    flex: 1;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
  }
  .icon:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--fg);
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }
  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .address {
    flex: none;
    padding: 0 8px 6px;
  }
  .address input {
    box-sizing: border-box;
    width: 100%;
    font-family: var(--mono);
    font-size: 12px;
  }
  .address-error {
    padding-top: 4px;
    color: #f48771;
    font-size: 12px;
    user-select: text;
  }
  .tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: none;
    padding-bottom: 8px;
  }
  .group {
    padding: 8px 14px 2px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding-right: 10px;
    white-space: nowrap;
    cursor: pointer;
  }
  .row:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .row.active {
    background: rgba(255, 255, 255, 0.09);
  }
  .row.selected {
    background: #04395e;
  }
  .tree:focus .row.selected {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .row.hidden .name {
    opacity: 0.6;
  }
  .glyph {
    display: grid;
    flex: none;
    place-items: center;
    width: 16px;
    color: var(--muted);
  }
  .chevron {
    transition: transform 0.1s;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .root-icon {
    flex: none;
    color: #9cb4d8;
  }
  .badge {
    display: grid;
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
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .size {
    flex: none;
    color: var(--muted);
    font-size: 11px;
  }
  .note {
    color: var(--muted);
    font-style: italic;
    cursor: default;
  }
  .note:hover {
    background: none;
  }
</style>
