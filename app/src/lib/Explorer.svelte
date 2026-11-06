<script lang="ts">
  // System file explorer: quick-access folders, then drives (`/` and
  // volumes outside Windows). Folders are listed when first expanded and
  // the tree is flattened into rows, so keyboard navigation is a list walk.
  // Opening a file reveals it, the way UltraEdit's explorer follows the
  // active file. A right click opens a menu after VS Code's: new files and
  // folders, cut, copy and paste, rename, delete to the Recycle Bin.

  import { confirm } from "@tauri-apps/plugin-dialog";
  import { onMount, tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import * as api from "./api";
  import DropMenu, { type DropEntry } from "./DropMenu.svelte";
  import { baseName, dirName, formatSize, isWindows, joinPath, movedPath, relativePath, samePath } from "./format";
  import { describeError, t, type MessageKey } from "./i18n";
  import { settings } from "./settings.svelte";
  import { detectLang, langBadge } from "./syntax";

  interface Props {
    /** Path of the open document, highlighted in the tree. */
    active: string | null;
    /** `preview`: picked with a single click, not meant to stay yet. */
    onopen: (path: string, preview?: boolean) => void;
    /** Ctrl+Enter: in the pane beside. */
    onopenside: (path: string) => void;
    /** Open documents whose files were renamed or moved. */
    onmoved: (docs: api.MovedDoc[]) => void;
    /** Something was deleted: open files may be gone from the disk. */
    ondeleted: () => void;
    onerror: (message: string) => void;
  }

  let { active, onopen, onopenside, onmoved, ondeleted, onerror }: Props = $props();

  /** A folder as the tree has it: its row, and the root that row is under. */
  interface Folder {
    key: string;
    path: string;
    base: string;
  }

  type EntryRow = {
    kind: "entry";
    key: string;
    entry: api.DirEntry;
    depth: number;
    /** The key of the root it is under. */
    base: string;
    root?: api.Root;
    /** The folder it is in; none for a root. */
    parent?: Folder;
  };
  type Row =
    | { kind: "group"; key: string; label: string }
    | EntryRow
    | { kind: "note"; key: string; text: string; depth: number }
    | { kind: "input"; key: string; depth: number; isDir: boolean };

  /** A name being typed: for a new file or folder in `key`'s folder, or to rename the row `key`. */
  interface Editing {
    kind: "newFile" | "newDir" | "rename";
    key: string;
    base: string;
    /** The folder it goes in. */
    folder: string;
    /** What is renamed. */
    from: string | null;
    value: string;
    error: string | null;
  }

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
  let selectedPath: string | null = null;
  let address = $state("");
  let addressError = $state<string | null>(null);
  let tree = $state<HTMLDivElement>();
  let addressInput = $state<HTMLInputElement>();
  let reveals = 0;
  let menu = $state<{ items: DropEntry[]; point: { x: number; y: number } } | null>(null);
  /** What Cut or Copy took, for Paste. */
  let clip = $state<{ path: string; cut: boolean } | null>(null);
  let pasting = $state(false);
  let editing = $state<Editing | null>(null);
  let editInput = $state<HTMLInputElement>();
  let committing = false;

  const rootKey = (root: api.Root) => `${root.group}:${root.path}`;

  function sorted(entries: api.DirEntry[]) {
    // Folders first, then natural order (part2 before part10).
    return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name));
  }

  /** A hidden entry the listing leaves out stays while the tree is open through it or it is selected. */
  function stillNeeded(entry: api.DirEntry) {
    return (
      entry.hidden &&
      [selectedPath, ...expanded.values()].some((path) => path !== null && samePath(path, entry.path))
    );
  }

  async function load(path: string) {
    try {
      const entries = await api.listDir(path, settings.showHidden);
      const before = listed.get(path);
      const kept = Array.isArray(before)
        ? before.filter((old) => stillNeeded(old) && !entries.some((entry) => samePath(entry.path, old.path)))
        : [];
      listed.set(path, sorted([...entries, ...kept]));
    } catch (e) {
      listed.set(path, describeError(e));
    }
  }

  let rows = $derived.by(() => {
    const out: Row[] = [];
    const walk = (base: string, folderKey: string, path: string, depth: number) => {
      const list = listed.get(path);
      const note = (text: string) => out.push({ kind: "note", key: `${base}|${path}\n`, text, depth });
      // A new file or folder is named at the top of its folder.
      const naming = editing !== null && editing.kind !== "rename" && editing.key === folderKey;
      if (naming) out.push({ kind: "input", key: `${folderKey}\n+`, depth, isDir: editing!.kind === "newDir" });
      if (list === undefined) note(t("explorer.loading"));
      else if (typeof list === "string") note(list);
      else if (list.length === 0) {
        if (!naming) note(t("explorer.empty"));
      } else
        for (const entry of list) {
          const key = `${base}|${entry.path}`;
          out.push({ kind: "entry", key, entry, depth, base, parent: { key: folderKey, path, base } });
          if (entry.isDir && expanded.has(key)) walk(base, key, entry.path, depth + 1);
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
        out.push({ kind: "entry", key, entry, depth: 0, root, base: key });
        if (expanded.has(key)) walk(key, key, root.path, 1);
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
    selectedPath = path;
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
    else onopen(row.entry.path, true);
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

  /**
   * Re-lists the expanded folders, a renamed one under its new name too;
   * collapsed ones are re-listed when expanded again.
   */
  export function refresh() {
    const open = new Set(expanded.values());
    for (const path of [...listed.keys()]) if (!open.has(path)) listed.delete(path);
    return Promise.all([...open].map(load));
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

  const entryRows = () => rows.filter((r): r is EntryRow => r.kind === "entry");
  const selectedRow = () => entryRows().find((r) => r.key === selected) ?? null;

  /** The folder a row stands for: itself, or the one a file is in. */
  const folderOf = (row: EntryRow): Folder | null =>
    row.entry.isDir ? { key: row.key, path: row.entry.path, base: row.base } : (row.parent ?? null);

  async function onkeydown(e: KeyboardEvent) {
    // Not the keys typed into a name.
    if (e.target !== tree) return;
    const entries = entryRows();
    const i = entries.findIndex((r) => r.key === selected);
    const row: EntryRow | undefined = entries[i];
    const pick = (r: EntryRow | undefined) => r && select(r.key, r.entry.path);
    const mod = e.ctrlKey || e.metaKey;
    const plain = !e.shiftKey && !e.altKey;
    // Drives and quick-access folders stay as they are.
    const movable = row && !row.root;
    const folder = row ? folderOf(row) : null;
    if (e.key === "ArrowDown") pick(entries[Math.min(entries.length - 1, i + 1)]);
    else if (e.key === "ArrowUp") pick(entries[Math.max(0, i - 1)]);
    else if (mod && e.key === "Enter" && row && !row.entry.isDir) onopenside(row.entry.path);
    else if (e.key === "Enter" && row) activate(row);
    else if (e.key === "ArrowRight" && row?.entry.isDir) {
      if (!expanded.has(row.key)) toggle(row.key, row.entry.path);
    } else if (e.key === "ArrowLeft" && row) {
      if (row.entry.isDir && expanded.has(row.key)) toggle(row.key, row.entry.path);
      else pick(entries.slice(0, i).findLast((r) => r.depth < row.depth));
    } else if (e.key === "F2" && movable) startRename(row);
    else if ((e.key === "Delete" || (e.metaKey && e.key === "Backspace")) && movable) remove(row);
    else if (mod && plain && (e.code === "KeyX" || e.code === "KeyC") && movable) clip = { path: row.entry.path, cut: e.code === "KeyX" };
    else if (mod && plain && e.code === "KeyV" && folder) pasteInto(folder);
    else if (e.shiftKey && e.altKey && !mod && e.code === "KeyC" && row) copyPath(row.entry.path);
    else if (e.shiftKey && e.altKey && !mod && e.code === "KeyR" && row) showInFileManager(row.entry.path);
    else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && row) {
      const box = document.getElementById(rowId(row.key))?.getBoundingClientRect();
      if (box) openMenu(row, box.left + 16, box.bottom);
    } else return;
    e.preventDefault();
    // Handled here: not a shortcut of the app's too (Shift+F10 is F10's).
    e.stopPropagation();
    await scrollToSelected("nearest");
  }

  // ---- The menu ---------------------------------------------------------------

  const REVEAL: MessageKey = isWindows
    ? "explorer.revealWindows"
    : navigator.userAgent.includes("Mac")
      ? "explorer.revealMac"
      : "explorer.revealOther";

  /** The folder of the file in the editor, which relative paths start from, as an `*INCLUDE` reads them. */
  const relativeTo = (path: string) => (active ? relativePath(dirName(active), path) : null);

  /** The menu for a row, or with none for the empty space below them, which stands for the selected row's folder. */
  function menuItems(row: EntryRow | null): DropEntry[] {
    const selectedOne = selectedRow();
    const folder = row ? folderOf(row) : selectedOne && folderOf(selectedOne);
    const path = row?.entry.path ?? folder?.path ?? null;
    const on = path !== null;
    const movable = !!row && !row.root;
    const newItems: DropEntry[] = [
      { label: t("explorer.newFile"), enabled: !!folder, run: () => folder && startNew("newFile", folder) },
      { label: t("explorer.newFolder"), enabled: !!folder, run: () => folder && startNew("newDir", folder) },
    ];
    const outside: DropEntry[] = [
      { label: t(REVEAL), shortcut: "Shift+Alt+R", enabled: on, run: () => path && showInFileManager(path) },
      { label: t("explorer.terminal"), enabled: !!folder, run: () => folder && terminal(folder.path) },
    ];
    const paste: DropEntry = {
      label: t("menu.paste"),
      shortcut: "Ctrl+V",
      enabled: !!folder && clip !== null && !pasting,
      run: () => folder && pasteInto(folder),
    };
    const clipItems: DropEntry[] = [
      { label: t("menu.cut"), shortcut: "Ctrl+X", enabled: movable, run: () => row && (clip = { path: row.entry.path, cut: true }) },
      { label: t("menu.copy"), shortcut: "Ctrl+C", enabled: movable, run: () => row && (clip = { path: row.entry.path, cut: false }) },
    ];
    const paths: DropEntry[] = [
      { label: t("explorer.copyPath"), shortcut: "Shift+Alt+C", enabled: on, run: () => path && copyPath(path) },
      {
        label: t("explorer.copyRelativePath"),
        enabled: path !== null && relativeTo(path) !== null,
        run: () => path && copyPath(relativeTo(path) ?? path),
      },
    ];
    const change: DropEntry[] = [
      { label: t("explorer.rename"), shortcut: "F2", enabled: movable, run: () => row && startRename(row) },
      { label: t("explorer.delete"), shortcut: "Delete", enabled: movable, run: () => row && remove(row) },
    ];
    if (!row) return [...newItems, ...outside, "separator", paste, "separator", ...paths];
    if (row.entry.isDir) return [...newItems, ...outside, "separator", ...clipItems, paste, "separator", ...paths, "separator", ...change];
    const side: DropEntry = { label: t("explorer.openToSide"), shortcut: "Ctrl+Enter", run: () => onopenside(row.entry.path) };
    return [side, ...outside, "separator", ...clipItems, "separator", ...paths, "separator", ...change];
  }

  function openMenu(row: EntryRow | null, x: number, y: number) {
    if (row) select(row.key, row.entry.path);
    menu = { items: menuItems(row), point: { x, y } };
  }

  function closeMenu() {
    menu = null;
    if (!editing) tree?.focus();
  }

  function rowMenu(e: MouseEvent, row: EntryRow) {
    e.preventDefault();
    e.stopPropagation();
    openMenu(row, e.clientX, e.clientY);
  }

  function emptyMenu(e: MouseEvent) {
    e.preventDefault();
    openMenu(null, e.clientX, e.clientY);
  }

  // ---- What the menu does -------------------------------------------------------

  const failed = (e: unknown) => onerror(describeError(e));

  const copyPath = (path: string) => api.writeClipboard(path).catch(failed);
  const showInFileManager = (path: string) => api.revealPath(path).catch(failed);
  const terminal = (dir: string) => api.openTerminal(dir).catch(failed);

  async function startNew(kind: "newFile" | "newDir", folder: Folder) {
    await expand(folder.key, folder.path);
    editing = { kind, key: folder.key, base: folder.base, folder: folder.path, from: null, value: "", error: null };
    await focusName(null);
  }

  function startRename(row: EntryRow) {
    const { name, path, isDir } = row.entry;
    editing = { kind: "rename", key: row.key, base: row.base, folder: dirName(path), from: path, value: name, error: null };
    // The name without its extension, as VS Code selects it.
    const dot = name.lastIndexOf(".");
    focusName(isDir || dot <= 0 ? null : dot);
  }

  async function focusName(selectTo: number | null) {
    await tick();
    if (!editInput) return;
    editInput.focus();
    if (selectTo === null) editInput.select();
    else editInput.setSelectionRange(0, selectTo);
    editInput.scrollIntoView({ block: "nearest" });
  }

  /** What is wrong with the name typed, as it is typed. */
  function check() {
    if (!editing) return;
    const name = editing.value.trim();
    const list = listed.get(editing.folder);
    const from = editing.from;
    const taken = Array.isArray(list) && list.some((e) => samePath(e.name, name) && !(from && samePath(e.path, from)));
    editing.error = /[\\/]/.test(name) ? t("explorer.slash") : taken ? t("explorer.exists", { name }) : null;
  }

  /** Makes the file or folder, or renames it. Leaving the name (`blurred`) gives it up if it cannot be. */
  async function commit(blurred = false) {
    const edit = editing;
    if (!edit || committing) return;
    const name = edit.value.trim();
    if (!name || (edit.from && name === baseName(edit.from))) return cancelEdit(!blurred);
    check();
    if (edit.error) return blurred ? cancelEdit(false) : undefined;
    committing = true;
    const path = joinPath(edit.folder, name);
    try {
      if (edit.from) {
        const moved = await api.renamePath(edit.from, path);
        follow(edit.from, path);
        if (moved.length) onmoved(moved);
      } else if (edit.kind === "newFile") await api.createFile(path);
      else await api.createDir(path);
    } catch (e) {
      if (blurred) {
        editing = null;
        failed(e);
      } else edit.error = describeError(e);
      return;
    } finally {
      committing = false;
    }
    editing = null;
    await refresh();
    select(`${edit.base}|${path}`, path);
    // A new file is to be written in.
    if (edit.kind === "newFile") onopen(path);
    else if (!blurred) tree?.focus();
    await scrollToSelected("nearest");
  }

  function cancelEdit(focus = true) {
    editing = null;
    if (focus) tree?.focus();
  }

  function nameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") cancelEdit();
    else return;
    e.preventDefault();
  }

  /** After `from` was renamed or moved to `to`: the tree stays open where it was. */
  function follow(from: string, to: string) {
    for (const [key, path] of [...expanded]) {
      const moved = movedPath(path, from, to);
      if (moved === null || !key.includes("|")) continue;
      expanded.delete(key);
      expanded.set(key.slice(0, key.length - path.length) + moved, moved);
    }
    const clipped = clip && movedPath(clip.path, from, to);
    if (clip && clipped) clip.path = clipped;
  }

  async function pasteInto(folder: Folder) {
    if (!clip || pasting) return;
    const { path, cut } = clip;
    pasting = true;
    try {
      const done = await api.paste([path], folder.path, cut);
      if (cut && done.to.length) {
        follow(path, done.to[0]);
        clip = null;
      }
      if (done.docs.length) onmoved(done.docs);
      if (done.error) failed(done.error);
      await expand(folder.key, folder.path);
      await refresh();
      if (done.to.length) {
        select(`${folder.base}|${done.to[0]}`, done.to[0]);
        await scrollToSelected("nearest");
      }
    } catch (e) {
      failed(e);
    } finally {
      pasting = false;
    }
  }

  async function remove(row: EntryRow) {
    const { name, path, isDir } = row.entry;
    const question = t(isDir ? "explorer.deleteFolder" : "explorer.deleteFile", { name });
    const ok = await confirm(`${question}\n\n${t(isWindows ? "explorer.restoreWindows" : "explorer.restoreTrash")}`, {
      title: t("explorer.delete"),
      kind: "warning",
      okLabel: t(isWindows ? "explorer.toRecycleBin" : "explorer.toTrash"),
      cancelLabel: t("prompt.cancel"),
    });
    if (ok) {
      const at = entryRows().findIndex((r) => r.key === row.key);
      try {
        await api.deletePath(path);
        ondeleted();
      } catch (e) {
        failed(e);
      }
      await refresh();
      // The row that takes its place.
      const entries = entryRows();
      const next = entries[Math.min(at, entries.length - 1)];
      if (next) select(next.key, next.entry.path);
    }
    tree?.focus();
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
    {#if pasting}
      <span class="busy">{t("explorer.pasting")}</span>
    {/if}
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
    oncontextmenu={emptyMenu}
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
          class:cut={clip?.cut && samePath(clip.path, entry.path)}
          id={rowId(row.key)}
          role="treeitem"
          aria-selected={row.key === selected}
          aria-expanded={entry.isDir ? expanded.has(row.key) : undefined}
          title={entry.path}
          style:padding-left="{6 + row.depth * 14}px"
          onclick={() => activate(row)}
          ondblclick={() => row.kind === "entry" && !row.entry.isDir && onopen(row.entry.path)}
          oncontextmenu={(e) => rowMenu(e, row)}
        >
          <span class="glyph">
            {#if entry.isDir}
              <svg class="chevron" class:open={expanded.has(row.key)} viewBox="0 0 16 16">
                <path d="M6 4l4 4-4 4" />
              </svg>
            {:else if lang !== "plain"}
              {@const badge = langBadge(lang)}
              <span class="badge {badge.cls}">{badge.text}</span>
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
          {#if editing?.kind === "rename" && editing.key === row.key}
            {@render nameInput()}
          {:else}
            <span class="name">{entry.name}</span>
            {#if !entry.isDir && (!entry.hidden || entry.size > 0)}
              <span class="size">{formatSize(entry.size)}</span>
            {/if}
          {/if}
        </div>
      {:else if row.kind === "input"}
        <div class="row naming" style:padding-left="{6 + row.depth * 14}px">
          <span class="glyph">
            {#if row.isDir}
              <svg class="chevron" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
            {/if}
          </span>
          {@render nameInput()}
        </div>
      {:else}
        <div class="row note" style:padding-left="{28 + row.depth * 14}px">{row.text}</div>
      {/if}
    {/each}
  </div>
</aside>

{#snippet nameInput()}
  {#if editing}
    <span class="name-edit">
      <input
        bind:this={editInput}
        bind:value={editing.value}
        class:wrong={editing.error}
        spellcheck="false"
        aria-label={t(editing.kind === "newDir" ? "explorer.newFolder" : editing.kind === "newFile" ? "explorer.newFile" : "explorer.rename")}
        oninput={check}
        onkeydown={nameKeydown}
        onblur={() => commit(true)}
        onclick={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        oncontextmenu={(e) => e.stopPropagation()}
      />
      {#if editing.error}
        <span class="name-error">{editing.error}</span>
      {/if}
    </span>
  {/if}
{/snippet}

{#if menu}
  <DropMenu items={menu.items} point={menu.point} onclose={closeMenu} />
{/if}

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
  .row.cut {
    opacity: 0.5;
  }
  .busy {
    color: var(--muted);
    font-size: 11px;
  }
  .name-edit {
    flex: 1;
    min-width: 0;
  }
  .row:has(> .name-edit) {
    position: relative;
  }
  .name-edit input {
    box-sizing: border-box;
    width: 100%;
    height: 20px;
    padding: 0 4px;
    font: inherit;
  }
  .name-edit input.wrong {
    outline: 1px solid #be1100;
  }
  /* Over the rows below, as VS Code shows it; as wide as the tree, since a deep
     folder leaves its name little room. */
  .name-error {
    position: absolute;
    top: 100%;
    left: 8px;
    right: 8px;
    z-index: 1;
    padding: 4px 6px;
    background: #5a1d1d;
    border: 1px solid #be1100;
    color: var(--fg);
    font-size: 12px;
    white-space: normal;
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
