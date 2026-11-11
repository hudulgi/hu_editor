<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { emit, listen } from "@tauri-apps/api/event";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import * as api from "./lib/api";
  import { baseName, dirName, formatNumber as fmt, formatSize as size, isWindows, joinPath, linkedPath, parentName, samePath } from "./lib/format";
  import { commentsOf } from "./lib/languages";
  import { openTypes, saveTypes } from "./lib/fileTypes";
  import { dependsOnContent, detectLang, langLabel, type Lang } from "./lib/syntax";
  import Editor, { type CaretInfo } from "./lib/Editor.svelte";
  import { ENCODING_LABEL } from "./lib/encodings";
  import EncodingMenu from "./lib/EncodingMenu.svelte";
  import Explorer from "./lib/Explorer.svelte";
  import SearchView from "./lib/SearchView.svelte";
  import FindBar from "./lib/FindBar.svelte";
  import MarkdownView from "./lib/MarkdownView.svelte";
  import DropMenu, { type DropEntry } from "./lib/DropMenu.svelte";
  import { describeError, t } from "./lib/i18n";
  import {
    arrange,
    directionOf,
    flipped,
    leaves,
    mapLeaves,
    neighbor,
    presetLayout,
    presetOf,
    presetSlots,
    resized,
    splitAt,
    without,
    type Direction,
    type LayoutNode,
    type Preset,
    type Sash,
    type Side,
    type Tree,
  } from "./lib/layout";
  import MenuBar, { type Menu, type MenuEntry } from "./lib/MenuBar.svelte";
  import { DOC_NEWS, QUIT, type CompareSide, type CompareStart, type DocNews, type Loaded } from "./lib/news";
  import Picker, { type PickerItem } from "./lib/Picker.svelte";
  import SavePrompt, { type Choice } from "./lib/SavePrompt.svelte";
  import SettingsDialog, { type Category } from "./lib/SettingsDialog.svelte";
  import { settings, settingsFile } from "./lib/settings.svelte";
  import TabBar, { type TabItem } from "./lib/TabBar.svelte";

  /** An open document and what the app shows about it; several panes can show it. */
  interface Tab {
    doc: api.DocInfo;
    lang: Lang;
    state: api.DocState;
    status: api.IndexStatus | null;
    /** Indexing speed, bytes per second. */
    rate: number;
    changedOnDisk: boolean;
    /** The user chose the encoding, rather than it being detected. */
    chosenEncoding: boolean;
    /** Line to go to once the line index has reached it. */
    goto: number | null;
  }

  /** One part of the layout, with its tabs in order. Each tab keeps its own editor
   * (caret, selection, scroll position) mounted while hidden. */
  interface Pane {
    /** Stays with the pane, so that its editors stay when the layout changes. */
    key: number;
    ids: number[];
    activeId: number | null;
    /** The tab that the next preview takes the place of. */
    previewId: number | null;
    /** The tabs held at the start of `ids`, which closing many leaves alone. */
    pinned: number[];
    /** New files open in another pane. */
    locked: boolean;
    /** The tabs that show their Markdown preview here, in place of the text. */
    rendered: number[];
    carets: Record<number, CaretInfo | null>;
    editors: Record<number, ReturnType<typeof Editor> | undefined>;
    previews: Record<number, ReturnType<typeof MarkdownView> | undefined>;
  }

  let paneKeys = 0;
  const newPane = (): Pane => ({
    key: paneKeys++,
    ids: [],
    activeId: null,
    previewId: null,
    pinned: [],
    locked: false,
    rendered: [],
    carets: {},
    editors: {},
    previews: {},
  });

  let tabs = $state<Tab[]>([]);
  /** In reading order. */
  let panes = $state<Pane[]>([newPane()]);
  let layout = $state.raw<LayoutNode>({ pane: 0 });
  let arranged = $derived(arrange(layout));
  /** The pane with the keyboard. */
  let focused = $state(0);
  /** The way the last split went: Ctrl+\\ goes that way again. */
  let splitDirection = $state<Direction>("columns");
  let activeId = $derived(panes[focused].activeId);
  let active = $derived(tabs.find((t) => t.doc.id === activeId) ?? null);
  /** The active tab shows its Markdown preview: what works on the text does not. */
  let rendering = $derived(activeId !== null && panes[focused].rendered.includes(activeId));
  let editor = $derived(activeId === null || rendering ? undefined : panes[focused].editors[activeId]);
  let activeCaret = $derived(activeId === null ? null : (panes[focused].carets[activeId] ?? null));
  let lang = $derived(active?.lang ?? "plain");

  let menuBar = $state<ReturnType<typeof MenuBar>>();
  let findBar = $state<ReturnType<typeof FindBar>>();
  let explorer = $state<ReturnType<typeof Explorer>>();
  let searchView = $state<ReturnType<typeof SearchView>>();
  let findOpen = $state(false);
  let replacing = $state(false);
  // Outlives the bar, so that F3 can go on and Ctrl+F shows it again.
  let needle = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let regex = $state(false);
  let preserveCase = $state(false);
  /** Find in Selection: the document, and the part of it the bar looks in. */
  let scope = $state<{ id: number; range: [number, number] } | null>(null);
  let activeScope = $derived(scope && active && scope.id === active.doc.id ? scope.range : null);
  let encodingOpen = $state(false);
  let settingsOpen = $state(false);
  let settingsPage = $state<Category>("general");
  /** A pane's menu: more actions, hanging from its button, or a tab's, at the mouse. */
  let paneMenu = $state.raw<{
    key: number;
    kind: "more" | "tab" | "text" | "preview";
    button?: HTMLElement;
    tab?: number;
    point?: { x: number; y: number };
  } | null>(null);
  /** The pane whose tabs are being listed to pick from. */
  let listing = $state<number | null>(null);
  /** Ctrl+K went down; the next key says what for. */
  let chord = $state(false);
  let chordFrom: HTMLElement | null = null;
  let about = $state<{ version: string } | null>(null);
  let gotoOpen = $state(false);
  let gotoValue = $state("");
  let gotoInput = $state<HTMLInputElement>();
  let notice = $state<string | null>(null);
  let saving = $state<{ id: number; written: number } | null>(null);
  let prompt = $state<{ names: string[]; answer: (choice: Choice) => void } | null>(null);
  const polls = new Map<number, ReturnType<typeof setInterval>>();
  const statusRefresh = new Map<number, ReturnType<typeof setTimeout>>();

  // Sidebar layout survives restarts.
  const saved = (key: string) => localStorage.getItem(`hu.${key}`);
  let sidebarOpen = $state(saved("sidebarOpen") !== "false");
  /** What the sidebar shows, picked in the activity bar beside it. */
  let sideView = $state<"explorer" | "search">(saved("sideView") === "search" ? "search" : "explorer");
  $effect(() => localStorage.setItem("hu.sideView", sideView));
  let sidebarWidth = $state(Number(saved("sidebarWidth")) || 280);

  $effect(() => localStorage.setItem("hu.sidebarOpen", String(sidebarOpen)));
  $effect(() => localStorage.setItem("hu.sidebarWidth", String(sidebarWidth)));

  // The open files and how they were laid out come back next time (new documents
  // without a file do not), for the first window. Older sessions have `paths` and
  // `active`, and then `second` with the first pane's share kept apart.
  interface SavedPane {
    paths: string[];
    active: string | null;
    preview?: string | null;
    pinned?: string[];
    locked?: boolean;
    rendered?: string[];
  }

  interface Session {
    layout?: Tree<SavedPane>;
    paths?: string[];
    active?: string | null;
    second?: SavedPane | null;
    direction?: Direction;
    focused?: number;
  }

  let restored = false;
  $effect(() => {
    const saveOf = ({ pane: key }: { pane: number }): SavedPane => {
      const pane = panes.find((one) => one.key === key);
      return {
        paths: pane?.ids.flatMap((id) => tabOf(id)?.doc.path ?? []) ?? [],
        active: pane && pane.activeId !== null ? (tabOf(pane.activeId)?.doc.path ?? null) : null,
        preview: pane && pane.previewId !== null ? (tabOf(pane.previewId)?.doc.path ?? null) : null,
        pinned: pane?.pinned.flatMap((id) => tabOf(id)?.doc.path ?? []),
        locked: pane?.locked,
        rendered: pane?.rendered.flatMap((id) => tabOf(id)?.doc.path ?? []),
      };
    };
    const session: Session = { layout: mapLeaves(layout, saveOf), direction: splitDirection, focused };
    if (restored) localStorage.setItem("hu.session", JSON.stringify(session));
  });

  $effect(() => {
    const title = active ? `${active.state.dirty ? "● " : ""}${active.doc.name} — HU Editor` : "HU Editor";
    getCurrentWindow().setTitle(title);
  });

  let nameCounts = $derived.by(() => {
    const count = new Map<string, number>();
    for (const tab of tabs) count.set(tab.doc.name, (count.get(tab.doc.name) ?? 0) + 1);
    return count;
  });

  function tabItems(pane: Pane): TabItem[] {
    return pane.ids.flatMap((id) => {
      const tab = tabOf(id);
      if (!tab) return [];
      const { doc, lang, state } = tab;
      return {
        id,
        name: doc.name,
        lang,
        path: doc.path,
        dirty: state.dirty,
        // Same name in two folders: show the folder.
        hint: doc.path && nameCounts.get(doc.name)! > 1 ? parentName(doc.path) : null,
        preview: pane.previewId === id,
        pinned: pane.pinned.includes(id),
        rendered: pane.rendered.includes(id),
      };
    });
  }

  let indexPercent = $derived(
    active?.status && active.status.len ? Math.floor((active.status.scanned / active.status.len) * 100) : 0,
  );

  let indexText = $derived.by(() => {
    const status = active?.status;
    if (!status) return "";
    if (status.error) return t("status.indexError", { error: status.error });
    if (status.complete) return t(status.lines === 1 ? "status.oneLine" : "status.lines", { count: fmt(status.lines) });
    return t("status.indexing", { percent: indexPercent, rate: size(active!.rate), lines: fmt(status.lines) });
  });

  let position = $derived.by(() => {
    const caret = activeCaret;
    if (!caret) return "";
    const line = caret.line === null ? "…" : fmt(caret.line + 1);
    if (caret.box) {
      return t("status.box", { line, rows: caret.box.rows === null ? "…" : fmt(caret.box.rows), cols: caret.box.cols });
    }
    const position = t("status.position", { line, col: caret.col });
    return caret.selected ? t("status.selected", { position, count: fmt(caret.selected) }) : position;
  });

  const tabOf = (id: number) => tabs.find((t) => t.doc.id === id);
  /** Every editor showing a document. */
  const viewsOf = (id: number) => panes.flatMap((pane) => pane.editors[id] ?? []);
  const flush = (id: number) => Promise.all(viewsOf(id).map((view) => view.flush()));

  // ---- Tabs ---------------------------------------------------------------

  /** Shows a document and gives it the keyboard: in pane `at`, or else the one showing it. */
  function activate(id: number, at = focused) {
    if (!panes[at]?.ids.includes(id)) at = panes.findIndex((pane) => pane.ids.includes(id));
    const pane = panes[at];
    if (!pane) return;
    pane.activeId = id;
    focused = at;
    gotoOpen = false;
    encodingOpen = false;
    tick().then(() => {
      if (prompt) return;
      if (pane.rendered.includes(id)) pane.previews[id]?.focus();
      else pane.editors[id]?.focus();
    });
  }

  /** Adds a tab for an open document to pane `at`, next to its active tab. */
  function addView(id: number, at: number) {
    const pane = panes[at];
    if (!pane.ids.includes(id)) pane.ids.splice(placeForTab(pane), 0, id);
    activate(id, at);
  }

  /** Where a tab goes in: after the active one, and after those pinned. */
  function placeForTab(pane: Pane) {
    const next = pane.activeId === null ? pane.ids.length : pane.ids.indexOf(pane.activeId) + 1;
    return Math.max(next, pane.pinned.length);
  }

  /** Takes a tab out of pane `at`; a pane left empty closes. The document stays open. */
  function removeView(id: number, at: number) {
    const pane = panes[at];
    const wasFocused = at === focused;
    const index = pane.ids.indexOf(id);
    pane.ids.splice(index, 1);
    delete pane.editors[id];
    delete pane.previews[id];
    delete pane.carets[id];
    if (pane.previewId === id) pane.previewId = null;
    pane.pinned = pane.pinned.filter((one) => one !== id);
    pane.rendered = pane.rendered.filter((one) => one !== id);
    if (pane.activeId === id) pane.activeId = pane.ids[Math.min(index, pane.ids.length - 1)] ?? null;
    // An empty pane has no button to unlock it with.
    if (!pane.ids.length) pane.locked = false;
    if (!pane.ids.length && panes.length > 1) closePane(at);
    if (wasFocused || panes.length === 1) {
      const next = panes[focused].activeId;
      if (next !== null) activate(next, focused);
    }
  }

  /** The highlighting for a document: from its name or, if that could mean either solver, its content. */
  async function langOf(id: number, name: string): Promise<Lang> {
    if (!dependsOnContent(name)) return detectLang(name);
    return (await api.detectDialect(id).catch(() => null)) ?? settings.blkDefault;
  }

  $effect(() => {
    if (settingsFile.error) notice = t("notice.settingsNotSaved", { error: settingsFile.error });
  });

  // The default decides the .blk files whose content does not.
  $effect(() => {
    void settings.blkDefault;
    untrack(() => {
      for (const tab of tabs) {
        if (dependsOnContent(tab.doc.name)) langOf(tab.doc.id, tab.doc.name).then((lang) => (tab.lang = lang));
      }
    });
  });

  /** The tab is here to stay, wherever it was a preview. */
  function keepOpen(id: number) {
    for (const pane of panes) if (pane.previewId === id) pane.previewId = null;
  }

  /** Pinned, a tab goes after those pinned before it; unpinned, right after those still pinned. */
  function togglePin(id: number, pane: Pane) {
    pane.ids.splice(pane.ids.indexOf(id), 1);
    if (pane.pinned.includes(id)) {
      pane.pinned = pane.pinned.filter((one) => one !== id);
    } else {
      keepOpen(id);
      pane.pinned.push(id);
    }
    const count = pane.pinned.length;
    pane.ids.splice(pane.pinned.includes(id) ? count - 1 : count, 0, id);
  }

  // With previews off, no tab waits to be replaced.
  $effect(() => {
    if (!settings.previewEditors) untrack(() => panes.forEach((pane) => (pane.previewId = null)));
  });

  /** Where a new tab goes: this pane or, if that is locked, the next one that is not, or a new one. */
  function openTarget() {
    for (let step = 0; step < panes.length; step++) {
      const at = (focused + step) % panes.length;
      if (!panes[at].locked) return at;
    }
    const added = addPane(panes[focused], sideAfter(splitDirection));
    return panes.findIndex((pane) => pane.key === added.key);
  }

  /**
   * Adds a tab next to the active one, or in place of `replacing` wherever that
   * shows. A `preview` takes the place of the pane's last one.
   */
  function add(
    { doc, lang, chosenEncoding }: Loaded,
    replacing: Tab | null = null,
    goto: number | null = null,
    show = true,
    preview = false,
    /** A pane asked for, locked or not: where a file was dropped. */
    into: number | null = null,
  ) {
    const tab: Tab = {
      doc,
      lang,
      state: doc.state,
      status: null,
      rate: 0,
      changedOnDisk: false,
      chosenEncoding,
      goto,
    };
    if (replacing) {
      const old = replacing.doc.id;
      drop(old);
      tabs[tabs.indexOf(replacing)] = tab;
      for (const pane of panes) {
        const at = pane.ids.indexOf(old);
        if (at < 0) continue;
        pane.ids[at] = doc.id;
        delete pane.carets[old];
        if (pane.activeId === old) pane.activeId = doc.id;
        if (pane.previewId === old) pane.previewId = null;
        pane.pinned = pane.pinned.map((one) => (one === old ? doc.id : one));
        pane.rendered = pane.rendered.filter((one) => one !== old);
      }
      if (show) activate(doc.id);
    } else {
      tabs.push(tab);
      const at = into ?? openTarget();
      const pane = panes[at];
      const previous = pane.previewId;
      if (preview && previous !== null) {
        pane.ids.splice(pane.ids.indexOf(previous) + 1, 0, doc.id);
        activate(doc.id, at);
        closeView(previous, pane);
      } else {
        addView(doc.id, at);
      }
      if (preview) pane.previewId = doc.id;
    }
    watchIndex(doc.id);
  }

  /** Lets go of a document in the backend. */
  function drop(id: number) {
    api.closeDocument(id);
    clearInterval(polls.get(id));
    clearTimeout(statusRefresh.get(id));
    polls.delete(id);
    statusRefresh.delete(id);
    for (const pane of panes) delete pane.editors[id];
  }

  /**
   * Closes a tab of pane `at`. If another pane or window shows the document too,
   * that is all; otherwise the document goes, asking first if it has unsaved changes.
   */
  async function closeTab(id: number, at = focused) {
    const tab = tabOf(id);
    const pane = panes[at];
    if (!tab || !pane) return false;
    const last = !panes.some((other) => other !== pane && other.ids.includes(id));
    if (last) {
      await flush(id);
      if (tab.state.dirty && !(await inOtherWindow(id))) {
        activate(id, at);
        const choice = await ask([tab.doc.name]);
        if (choice === "cancel" || (choice === "save" && !(await saveTab(tab)))) return false;
      }
    }
    closeView(id, pane);
    return true;
  }

  /** Takes a tab out of a pane, without asking; the document goes with its last tab here. */
  function closeView(id: number, pane: Pane) {
    const last = !panes.some((other) => other !== pane && other.ids.includes(id));
    if (last) rememberClosed(id, pane);
    removeView(id, panes.indexOf(pane));
    if (last) {
      drop(id);
      tabs.splice(tabs.indexOf(tabOf(id)!), 1);
    }
  }

  /** Closes tabs of a pane, except those pinned, asking once about unsaved changes that nothing else shows. */
  async function closeTabs(pane: Pane, ids: number[]) {
    const closing = ids.filter((id) => !pane.pinned.includes(id));
    const alone = closing.flatMap((id) => (panes.some((other) => other !== pane && other.ids.includes(id)) ? [] : (tabOf(id) ?? [])));
    if (!(await mayClose(alone))) return;
    for (const id of closing) closeView(id, pane);
  }

  const closeAll = (pane: Pane) => closeTabs(pane, [...pane.ids]);

  /** All but this tab, which then shows. */
  async function closeOthers(pane: Pane, id: number) {
    await closeTabs(pane, pane.ids.filter((one) => one !== id));
    if (pane.ids.every((one) => one === id || pane.pinned.includes(one))) activate(id, panes.indexOf(pane));
  }

  const closeToRight = (pane: Pane, id: number) => closeTabs(pane, pane.ids.slice(pane.ids.indexOf(id) + 1));

  /** Closes the tabs of a pane with nothing to save. */
  async function closeSaved(pane: Pane) {
    await Promise.all(pane.ids.map(flush));
    for (const id of pane.ids.filter((one) => !pane.pinned.includes(one) && !tabOf(one)?.state.dirty)) closeView(id, pane);
  }

  function cycle(step: number) {
    const { ids, activeId } = panes[focused];
    if (activeId === null || ids.length < 2) return;
    activate(ids[(ids.indexOf(activeId) + step + ids.length) % ids.length], focused);
  }

  // ---- Split ----------------------------------------------------------------

  /** Changes the layout: `added` are the panes new to it, `focus` the pane to have the keyboard. */
  function setLayout(next: LayoutNode, focus: Pane, added: Pane[] = []) {
    const all = [...panes, ...added];
    layout = next;
    panes = leaves(next).map((key) => all.find((pane) => pane.key === key)!);
    focused = panes.findIndex((pane) => pane.key === focus.key);
  }

  /** A new, empty pane on `side` of `next`. */
  function addPane(next: Pane, side: Side) {
    const pane = newPane();
    splitDirection = directionOf(side);
    setLayout(splitAt(layout, next.key, pane.key, side), panes[focused], [pane]);
    return panes.find((one) => one.key === pane.key)!;
  }

  /** Takes a pane out of the layout. Its documents stay open; closing its tabs is for the caller. */
  function closePane(at: number) {
    const focus = at === focused ? (panes[at + 1] ?? panes[at - 1]) : panes[focused];
    setLayout(without(layout, panes[at].key), focus);
  }

  const sideAfter = (direction: Direction): Side => (direction === "columns" ? "right" : "bottom");

  /**
   * Split (Ctrl+\\, the tab bar's button, Editor Layout): a new, empty pane on
   * `side` of this one, with the keyboard, for what is opened next.
   */
  function split(side: Side) {
    const added = addPane(panes[focused], side);
    focusPane(panes.findIndex((pane) => pane.key === added.key));
  }

  /** The tab menu's Split: a new pane on `side` of this one, showing this tab at the same place. */
  async function splitTab(side: Side) {
    if (!active) return;
    const id = active.doc.id;
    const place = panes[focused].editors[id]?.place();
    const pane = addPane(panes[focused], side);
    if (rendering) pane.rendered.push(id);
    addView(id, panes.indexOf(pane));
    await tick();
    if (place) pane.editors[id]?.goToPlace(place);
  }

  /**
   * Lays the panes out as `preset`, sharing the room evenly. New panes start
   * empty; panes too many hand their tabs to the last one kept. No document closes.
   */
  async function applyPreset(preset: Preset) {
    const slots = presetSlots(preset);
    const current = panes[focused];
    const kept = panes.slice(0, slots);
    if (!kept.includes(current)) kept[slots - 1] = current;
    const into = kept[kept.length - 1];
    const places: [number, ReturnType<NonNullable<typeof editor>["place"]> | undefined][] = [];
    if (panes.length > slots) {
      const merging = panes.filter((pane) => pane === into || !kept.includes(pane));
      for (const pane of merging) {
        if (pane === into) continue;
        for (const id of pane.ids) if (!into.ids.includes(id)) places.push([id, pane.editors[id]?.place()]);
      }
      // Those pinned anywhere stay pinned, in front.
      const pinned = [...new Set(merging.flatMap((pane) => pane.pinned))];
      // A tab shows as it did here, or else as it did where it came from.
      const had = new Set(into.ids);
      into.rendered = [...new Set([...into.rendered, ...merging.flatMap((pane) => pane.rendered).filter((id) => !had.has(id))])];
      into.ids = [...new Set([...pinned, ...merging.flatMap((pane) => pane.ids)])];
      into.pinned = pinned;
      into.activeId ??= into.ids[0] ?? null;
    }
    const fresh = Array.from({ length: slots - kept.length }, newPane);
    const next = presetLayout(preset, [...kept, ...fresh].map((pane) => pane.key));
    if ("direction" in next) splitDirection = next.direction;
    setLayout(next, current, fresh);
    focusPane(focused);
    await tick();
    for (const [id, place] of places) if (place) into.editors[id]?.goToPlace(place);
  }

  /** Columns become rows and rows columns; the panes and their sizes stay. */
  function flipLayout() {
    if ("direction" in layout) splitDirection = layout.direction === "columns" ? "rows" : "columns";
    setLayout(flipped(layout), panes[focused]);
  }

  /** Moves a tab to pane `to`, or to a new pane on `side` of that, keeping its place. */
  async function moveTab(id: number, source: Pane, to: Pane, side?: Side) {
    const target = side ? addPane(to, side) : to;
    const place = source.editors[id]?.place();
    const shown = target.ids.includes(id);
    const pinned = source.pinned.includes(id) && !target.pinned.includes(id);
    if (!shown && source.rendered.includes(id)) target.rendered.push(id);
    if (!shown) target.ids.splice(placeForTab(target), 0, id);
    if (pinned) togglePin(id, target);
    removeView(id, panes.indexOf(source));
    activate(id, panes.indexOf(target));
    if (shown || !place) return;
    await tick();
    target.editors[id]?.goToPlace(place);
  }

  /**
   * Moves the active tab to the pane after or before this one, around the ends
   * if `wrap`. With one pane, going forward makes the other, the way the split last was.
   */
  function moveTabBy(step: 1 | -1, wrap = false) {
    if (!active) return;
    const source = panes[focused];
    if (panes.length === 1) {
      if (step > 0 && source.ids.length > 1) moveTab(active.doc.id, source, source, sideAfter(splitDirection));
      return;
    }
    const next = panes[wrap ? (focused + step + panes.length) % panes.length : focused + step];
    if (next) moveTab(active.doc.id, source, next);
  }

  // ---- Markdown preview --------------------------------------------------------

  /** A preview can be opened of the active tab, or it shows one. */
  let previewable = $derived(rendering || active?.lang === "markdown");

  /** Open Preview (Ctrl+Shift+V): the active tab shows its preview in place of its text, or its text again. */
  function togglePreview() {
    const pane = panes[focused];
    const id = pane.activeId;
    if (id === null) return;
    if (pane.rendered.includes(id)) pane.rendered = pane.rendered.filter((one) => one !== id);
    else pane.rendered.push(id);
    activate(id, focused);
  }

  /**
   * Open Preview to the Side (Ctrl+K V): the active tab's preview in the pane on
   * its right, made if there is none, while the keyboard stays in the text.
   */
  function previewToSide() {
    const source = panes[focused];
    const id = source.activeId;
    if (id === null || !previewable) return;
    const right = neighbor(layout, source.key, "right");
    const target = panes.find((pane) => pane.key === right) ?? addPane(source, "right");
    if (!target.ids.includes(id)) target.ids.splice(placeForTab(target), 0, id);
    if (!target.rendered.includes(id)) target.rendered.push(id);
    target.activeId = id;
    activate(id, panes.findIndex((pane) => pane.key === source.key));
  }

  /**
   * A link in a preview: on the web or to mail, for the system; otherwise a
   * file next to the document, opened in the preview's pane (as a preview too
   * if it is Markdown), or a folder, shown in the explorer.
   */
  async function followLink(href: string, from: Tab, pane: Pane) {
    if (/^[a-z][a-z0-9+.-]+:/i.test(href) && !/^file:/i.test(href)) {
      api.openUrl(href).catch((e) => (notice = describeError(e)));
      return;
    }
    const target = href.replace(/[?#].*$/, "");
    if (!target || from.doc.path === null) return;
    const path = linkedPath(from.doc.path, target);
    const kind = await api.pathKind(path);
    if (kind === null) notice = t("notice.linkMissing", { path });
    else if (kind === "dir") {
      sidebarOpen = true;
      sideView = "explorer";
      await tick();
      await explorer?.reveal(path, true);
    } else {
      const at = panes.findIndex((one) => one.key === pane.key);
      await openPath(path, true, false, at);
      const opened = tabOfPath(path);
      if (opened?.lang === "markdown" && panes[at]?.ids.includes(opened.doc.id) && !panes[at].rendered.includes(opened.doc.id)) {
        panes[at].rendered.push(opened.doc.id);
        activate(opened.doc.id, at);
      }
    }
  }

  /** A preview's own menu. */
  function previewMenuItems(pane: Pane): DropEntry[] {
    const id = pane.activeId;
    const view = id === null ? undefined : pane.previews[id];
    const selected = view?.selection() ?? "";
    return [
      { label: t("menu.copy"), shortcut: "Ctrl+C", enabled: selected !== "", palette: false, run: () => api.writeClipboard(selected) },
      { label: t("menu.selectAll"), shortcut: "Ctrl+A", palette: false, run: () => view?.selectAll() },
      "separator",
      { label: t("menu.showSource"), shortcut: "Ctrl+Shift+V", palette: false, run: togglePreview },
    ];
  }

  /** The pane under a point, if any. */
  function paneAt(x: number, y: number) {
    const index = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane]")?.dataset.pane;
    return index === undefined ? null : Number(index);
  }

  /** The side of a pane's text a point is close to; none in the middle or off the text. */
  function sideAt(at: number, x: number, y: number): Side | null {
    const box = panesBox?.querySelector(`[data-pane="${at}"] .editors`)?.getBoundingClientRect();
    if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
    const [toLeft, toRight, toTop, toBottom] = [x - box.left, box.right - x, y - box.top, box.bottom - y];
    const across = Math.min(toLeft, toRight) / box.width;
    const down = Math.min(toTop, toBottom) / box.height;
    if (Math.min(across, down) > EDGE) return null;
    if (across < down) return toLeft < toRight ? "left" : "right";
    return toTop < toBottom ? "top" : "bottom";
  }

  const EDGE = 0.3;

  /** Where a tab being dragged would go: into a pane or, near an edge of its text, a new pane on that side of it. */
  let dropZone = $state<{ pane: number; side?: Side } | null>(null);

  function dragTab(from: number, x: number, y: number) {
    const over = paneAt(x, y);
    if (over === null) {
      dropZone = null;
      return;
    }
    const side = sideAt(over, x, y) ?? undefined;
    if (over !== from) dropZone = { pane: over, side };
    else dropZone = side && panes[from].ids.length > 1 ? { pane: from, side } : null;
  }

  function dropTab(id: number, from: number) {
    const zone = dropZone;
    dropZone = null;
    if (zone) moveTab(id, panes[from], panes[zone.pane], zone.side);
  }

  /** Files dragged from the explorer or the OS: where they would go, shown as a tab's would be. */
  function dragFiles(x: number, y: number) {
    const over = paneAt(x, y);
    dropZone = over === null ? null : { pane: over, side: sideAt(over, x, y) ?? undefined };
  }

  /**
   * Files let go: into the pane they were over or, near an edge of its text, a
   * new pane on that side, locked or not; folders show in the explorer. Off the
   * panes, the OS's open as usual (`elsewhere`), the explorer's do not.
   */
  async function dropFiles(paths: string[], elsewhere: boolean) {
    const zone = dropZone;
    dropZone = null;
    const files: string[] = [];
    for (const path of paths) {
      if ((await api.pathKind(path)) !== "dir") files.push(path);
      else {
        sidebarOpen = true;
        sideView = "explorer";
        explorer?.reveal(path, true);
      }
    }
    if (!files.length) return;
    if (!zone) {
      if (elsewhere) for (const path of files) await openPath(path);
      return;
    }
    let at = zone.pane;
    if (zone.side) {
      const added = addPane(panes[at], zone.side);
      at = panes.findIndex((pane) => pane.key === added.key);
    }
    for (const path of files) await openPath(path, true, false, at);
  }

  /** Moves a tab to the pane next to its own on `side`, or if there is none, to a new one there. */
  function moveTabToSide(id: number, pane: Pane, side: Side) {
    const next = panes.find((one) => one.key === neighbor(layout, pane.key, side));
    moveTab(id, pane, next ?? pane, next ? undefined : side);
  }

  // Resizing the panes.
  let panesBox = $state<HTMLElement>();
  let resizingPanes: Sash | null = null;

  function paneSashMove(e: PointerEvent) {
    if (!resizingPanes || !panesBox) return;
    const box = panesBox.getBoundingClientRect();
    const { direction, parent } = resizingPanes;
    const at =
      direction === "columns"
        ? ((e.clientX - box.left) / box.width - parent.x) / parent.width
        : ((e.clientY - box.top) / box.height - parent.y) / parent.height;
    layout = resized(layout, resizingPanes, at);
  }

  // ---- Other windows ----------------------------------------------------------

  // What happens to a document shown in several windows is told to the others
  // (news.ts). Each window has its own panes and tabs.

  /** Where an editor is: its selection and its first line on screen. */
  type Place = ReturnType<NonNullable<typeof editor>["place"]>;

  /** What a new window shows first: a tab moved or copied there, or nothing (New Window). */
  interface WindowStart extends Loaded {
    place: Place | null;
  }
  type EmptyStart = { empty: true };

  const thisWindow = getCurrentWindow().label;
  /** Documents that another window may be showing too. */
  const sharedDocs = new Set<number>();

  const tell = (news: DocNews) => emit(DOC_NEWS, { ...$state.snapshot(news), from: thisWindow });
  const inOtherWindow = async (id: number) => sharedDocs.has(id) && (await api.documentWindows(id)) > 1;

  function heard(news: DocNews) {
    const tab = tabOf(news.id);
    if (!tab) return;
    if (news.kind === "edited") {
      for (const view of viewsOf(news.id)) view.followEdit(news.change);
      followScope(news.id, news.change);
      refreshAfterEdit(news.id, news.state);
    } else if (news.kind === "saved") {
      Object.assign(tab.doc, { path: news.path, name: news.name });
      Object.assign(tab, { state: news.state, lang: news.lang, changedOnDisk: false });
    } else if (news.kind === "moved") {
      Object.assign(tab.doc, { path: news.path, name: news.name });
      tab.lang = news.lang;
    } else if (news.kind === "encoding") {
      tab.doc.encoding = news.encoding;
      tab.chosenEncoding = news.chosen;
      for (const view of viewsOf(news.id)) view.reread();
    } else {
      sharedDocs.add(news.loaded.doc.id);
      add(news.loaded, tab, news.goto, false);
    }
  }

  // ---- Comparing -----------------------------------------------------------------

  /**
   * Opens a compare window of two files. A file open here goes as its document,
   * unsaved changes and all, shared with that window from now on.
   */
  async function openCompare(left: string, right: string) {
    const sides: CompareSide[] = [];
    const retained: number[] = [];
    for (const path of [left, right]) {
      const tab = tabOfPath(path);
      if (!tab) {
        sides.push({ path, loaded: null });
        continue;
      }
      const id = tab.doc.id;
      await flush(id);
      await api.retainDocument(id);
      retained.push(id);
      sharedDocs.add(id);
      sides.push({ path, loaded: $state.snapshot({ doc: { ...tab.doc, state: tab.state }, lang: tab.lang, chosenEncoding: tab.chosenEncoding }) });
    }
    try {
      await api.openCompareWindow({ left: sides[0], right: sides[1] } satisfies CompareStart);
    } catch (e) {
      for (const id of retained) api.closeDocument(id);
      notice = describeError(e);
    }
  }

  /** Compare Active File With…: the file picked on the left, as VS Code has it. */
  async function compareActiveWith() {
    const path = active?.doc.path;
    if (!path) return;
    const other = await openDialog({ multiple: false, directory: false, filters: openTypes() });
    if (typeof other === "string") await openCompare(other, path);
  }

  /** Shows the active tab in a new window, at the same place; `move` closes it here. */
  async function toNewWindow(move: boolean) {
    const tab = active;
    if (!tab) return;
    const id = tab.doc.id;
    const pane = panes[focused];
    keepOpen(id);
    await flush(id);
    const start: WindowStart = $state.snapshot({
      doc: { ...tab.doc, state: tab.state },
      lang: tab.lang,
      chosenEncoding: tab.chosenEncoding,
      place: pane.editors[id]?.place() ?? null,
    });
    await api.retainDocument(id);
    sharedDocs.add(id);
    try {
      await api.openWindow(start);
    } catch (e) {
      api.closeDocument(id);
      notice = describeError(e);
      return;
    }
    if (move) await closeTab(id, panes.indexOf(pane));
  }

  /** Puts a newly opened document in the place of a tab, here and in the other windows showing it. */
  async function replaceDoc(tab: Tab, loaded: Loaded, goto: number | null = null) {
    const old = tab.doc.id;
    if (sharedDocs.has(old)) {
      const others = (await api.documentWindows(old)) - 1;
      for (let i = 0; i < others; i++) await api.retainDocument(loaded.doc.id);
      if (others > 0) {
        sharedDocs.add(loaded.doc.id);
        tell({ kind: "replaced", id: old, loaded, goto });
      }
    }
    add(loaded, tab, goto);
  }

  // ---- Unsaved changes ------------------------------------------------------

  /** Asks whether to save unsaved changes in the named files before they are dropped. */
  function ask(names: string[]): Promise<Choice> {
    return new Promise((answer) => (prompt = { names, answer }));
  }

  function answer(choice: Choice) {
    prompt?.answer(choice);
    prompt = null;
    tick().then(() => editor?.focus());
  }

  /** A dialog takes the keyboard from the editor behind it. */
  function takeFocus(button: HTMLElement) {
    button.focus();
  }

  /** Whether these documents may close: unsaved ones that no other window shows are saved or given up. */
  async function mayClose(closing: Tab[]) {
    await Promise.all(closing.map((t) => flush(t.doc.id)));
    const dirty: Tab[] = [];
    for (const tab of closing) if (tab.state.dirty && !(await inOtherWindow(tab.doc.id))) dirty.push(tab);
    if (!dirty.length) return true;
    if (dirty.length === 1) activate(dirty[0].doc.id);
    const choice = await ask(dirty.map((t) => t.doc.name));
    if (choice !== "save") return choice === "discard";
    for (const tab of dirty) {
      activate(tab.doc.id);
      if (!(await saveTab(tab))) return false;
    }
    return true;
  }

  // ---- Files ----------------------------------------------------------------

  /** Saves; a new document asks for a file name first. */
  async function saveTab(tab: Tab) {
    // Keys typed just before Ctrl+S must make it into the file.
    await flush(tab.doc.id);
    if (tab.doc.path === null) return saveTabAs(tab);
    if (saving) return false;
    return writing(tab, async (progress) => {
      tab.state = await api.save(tab.doc.id, progress);
    });
  }

  async function saveTabAs(tab: Tab) {
    await flush(tab.doc.id);
    if (saving) return false;
    const defaultPath = tab.doc.path ?? untitledName(tab);
    const path = await saveDialog({ defaultPath, filters: saveTypes(defaultPath) });
    if (!path) return false;
    return writing(tab, async (progress) => {
      const done = await api.saveAs(tab.doc.id, path, progress);
      tab.state = done.state;
      tab.doc.path = done.path;
      tab.doc.name = done.name;
      tab.lang = await langOf(tab.doc.id, done.name);
      noteRecent(done.path);
      if (tab.chosenEncoding) rememberEncoding(done.path, tab.doc.encoding);
      if (tab.doc.id === activeId) explorer?.reveal(done.path, false);
    });
  }

  /** What a new document is first saved as: its name, with the extension of its solver. */
  const untitledName = (tab: Tab) => `${tab.doc.name}${tab.lang === "nastran" ? ".bdf" : ".inp"}`;

  /** Runs a save with progress in the status bar; false if it failed. */
  async function writing(tab: Tab, work: (progress: (written: number) => void) => Promise<void>) {
    saving = { id: tab.doc.id, written: 0 };
    try {
      await work((written) => saving && (saving.written = written));
      tab.changedOnDisk = false;
      keepOpen(tab.doc.id);
      if (sharedDocs.has(tab.doc.id)) {
        const { id, path, name } = tab.doc;
        tell({ kind: "saved", id, state: tab.state, path, name, lang: tab.lang });
      }
      return true;
    } catch (e) {
      notice = t("notice.saveFailed", { error: describeError(e) });
      return false;
    } finally {
      saving = null;
    }
  }

  // An encoding the user chose stays with the file, across reopening and restarts.
  const encodingKey = (path: string) => (isWindows ? path.toLowerCase() : path);
  const chosenEncodings = (): Record<string, api.Encoding> => JSON.parse(localStorage.getItem("hu.encodings") ?? "{}");

  function rememberEncoding(path: string, encoding: api.Encoding | null) {
    const chosen = chosenEncodings();
    if (encoding) chosen[encodingKey(path)] = encoding;
    else delete chosen[encodingKey(path)];
    localStorage.setItem("hu.encodings", JSON.stringify(chosen));
  }

  function closeEncodingMenu() {
    encodingOpen = false;
    editor?.focus();
  }

  /** Reads the tab's file in `encoding`, or the one detected; the file does not change. */
  async function readAs(tab: Tab, encoding: api.Encoding | null) {
    closeEncodingMenu();
    const id = tab.doc.id;
    await flush(id);
    try {
      tab.doc.encoding = await api.setEncoding(id, encoding, settings.fallbackEncoding);
    } catch (e) {
      notice = describeError(e);
      return;
    }
    tab.chosenEncoding = encoding !== null;
    if (tab.doc.path !== null) rememberEncoding(tab.doc.path, encoding);
    for (const view of viewsOf(id)) view.reread();
    if (sharedDocs.has(id)) tell({ kind: "encoding", id, encoding: tab.doc.encoding, chosen: tab.chosenEncoding });
  }

  /** Saves the tab converted to `encoding`. Its bytes change, so it opens anew at the same line. */
  async function saveConverted(tab: Tab, encoding: api.Encoding) {
    closeEncodingMenu();
    const id = tab.doc.id;
    await flush(id);
    if (saving) return;
    if (encoding === tab.doc.encoding) {
      // Nothing to convert: a plain save, and undo stays.
      await readAs(tab, encoding);
      await saveTab(tab);
      return;
    }
    const path =
      tab.doc.path ?? (await saveDialog({ defaultPath: untitledName(tab), filters: saveTypes(untitledName(tab)) }));
    if (!path) return;
    const line = activeCaret?.line ?? null;
    if (!(await writing(tab, (progress) => api.saveConverted(id, path, encoding, progress)))) return;
    rememberEncoding(path, encoding);
    try {
      await replaceDoc(tab, await load(path), line);
    } catch (e) {
      notice = describeError(e);
    }
  }

  /** Opens `path` in the encoding chosen for it, if any. */
  async function load(path: string): Promise<Loaded> {
    const encoding = chosenEncodings()[encodingKey(path)] ?? null;
    const doc = await api.openDocument(path, encoding, settings.fallbackEncoding);
    return { doc, lang: await langOf(doc.id, doc.name), chosenEncoding: encoding !== null };
  }

  const tabOfPath = (path: string) => tabs.find((tab) => tab.doc.path !== null && samePath(tab.doc.path, path));
  /** Files on their way into a tab. */
  const opening = new Map<string, Promise<void>>();

  async function chooseFile() {
    const path = await openDialog({ multiple: false, directory: false, filters: openTypes() });
    if (typeof path === "string") await openPath(path);
  }

  /**
   * Shows `path` in a tab: the one it is already open in, in any pane, or a new
   * one in this pane, which an empty pane gets in any case. `reveal` expands the
   * explorer down to it (not wanted when picked there). `preview`: not meant to
   * stay yet; otherwise a tab that was a preview stays from now on.
   */
  async function openPath(path: string, reveal = true, preview = false, into: number | null = null) {
    // A double click arrives while its first click is still opening the file.
    await opening.get(path);
    const open = tabOfPath(path);
    if (open) {
      if (into !== null) addView(open.doc.id, into);
      else if (panes[focused].activeId === null && !panes[focused].locked) addView(open.doc.id, focused);
      else activate(open.doc.id);
      if (!preview) keepOpen(open.doc.id);
    } else {
      const done = (async () => {
        try {
          const loaded = await load(path);
          // A blank, untouched new document gives way to the file.
          const blank = into === null && active && !panes[focused].locked && active.doc.path === null && !active.state.dirty && active.state.len === 0;
          add(loaded, blank ? active : null, null, true, preview && settings.previewEditors, into);
          return true;
        } catch (e) {
          notice = describeError(e);
          return false;
        }
      })();
      opening.set(path, done.then(() => {}));
      const opened = await done;
      opening.delete(path);
      if (!opened) return;
    }
    noteRecent(path);
    if (reveal) explorer?.reveal(path, false);
  }

  /** Ctrl+Enter in the explorer: in the pane to the right of this one, or a new one there. */
  async function openToSide(path: string) {
    const here = panes[focused];
    const right = neighbor(layout, here.key, "right");
    const beside = panes.find((pane) => pane.key === right);
    const target = beside && !beside.locked ? beside : addPane(here, "right");
    const at = panes.indexOf(target);
    const open = tabOfPath(path);
    if (open) addView(open.doc.id, at);
    else {
      focused = at;
      await openPath(path, false);
    }
  }

  /** The explorer renamed or moved files open here: their tabs follow, here and in the other windows. */
  async function followMoves(moved: api.MovedDoc[]) {
    for (const { id, path, name } of moved) {
      const tab = tabOf(id);
      if (!tab) continue;
      Object.assign(tab.doc, { path, name });
      tab.lang = await langOf(id, name);
      if (tab.chosenEncoding) rememberEncoding(path, tab.doc.encoding);
      if (sharedDocs.has(id)) tell({ kind: "moved", id, path, name, lang: tab.lang });
    }
  }

  /** Marks the tabs whose files changed or went from the disk. */
  async function checkDisk() {
    for (const tab of tabs) {
      if (tab.doc.path !== null) tab.changedOnDisk = await api.diskChanged(tab.doc.id).catch(() => false);
    }
  }

  let untitled = 0;

  /** A new, empty document in its own tab: Untitled-1, Untitled-2, … `lang` from New File…. */
  async function newFile(lang: Lang = "plain") {
    const encoding = settings.newFileEncoding;
    const doc = await api.newDocument(encoding, settings.newFileEol === "os" ? null : settings.newFileEol);
    add({
      doc: { ...doc, name: t("doc.untitled", { n: ++untitled }) },
      lang,
      chosenEncoding: encoding !== "utf8",
    });
  }

  /** Reopens a tab's file after it changed on disk, at `line` if given; unsaved changes go. */
  async function reload(tab: Tab, line: number | null = null) {
    if (!tab.doc.path) return;
    try {
      await replaceDoc(tab, await load(tab.doc.path), line);
    } catch (e) {
      notice = describeError(e);
    }
  }

  /** Revert File: back to what is on disk, at the same line; unsaved changes go, as in VS Code. */
  async function revert(tab: Tab) {
    await flush(tab.doc.id);
    await reload(tab, tab === active ? (activeCaret?.line ?? null) : null);
  }

  // ---- File menu: new files and windows, recent files, saving all -------------

  let newFileOpen = $state(false);

  /** New File… picked: a document for a solver, or a file of the name typed. */
  async function pickNewFile(key: number | string) {
    newFileOpen = false;
    const kind = String(key);
    if (kind.startsWith("name:")) await createNamed(kind.slice(5));
    else await newFile(kind as Lang);
  }

  function closeNewFile() {
    newFileOpen = false;
    editor?.focus();
  }

  /** The file is made on disk where the save dialog says, as VS Code does, and opens; nothing there is replaced. */
  async function createNamed(name: string) {
    const folder = active?.doc.path ? dirName(active.doc.path) : null;
    const path = await saveDialog({ defaultPath: folder ? joinPath(folder, name) : name, filters: saveTypes(name) });
    if (!path) return editor?.focus();
    try {
      await api.createFile(path);
    } catch (e) {
      notice = describeError(e);
      return;
    }
    await openPath(path);
  }

  /** New Window: one of its own, empty; its layout is not kept. */
  async function newWindow() {
    try {
      await api.openWindow({ empty: true } satisfies EmptyStart);
    } catch (e) {
      notice = describeError(e);
    }
  }

  /** Open Folder…: there is no workspace to open, so the explorer shows it, open. */
  async function openFolder() {
    const path = await openDialog({ multiple: false, directory: true });
    if (typeof path !== "string") return;
    sidebarOpen = true;
    sideView = "explorer";
    await tick();
    await explorer?.reveal(path, true);
  }

  const RECENT = "hu.recent";
  const MAX_RECENT = 50;
  /** How many Open Recent shows; More… lists them all. */
  const RECENT_SHOWN = 10;

  function readRecent(): string[] {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
      return Array.isArray(list) ? list.filter((one) => typeof one === "string") : [];
    } catch {
      return [];
    }
  }

  /** Files opened lately, the last first, shared by the windows. */
  let recentFiles = $state(readRecent());

  function setRecent(list: string[]) {
    recentFiles = list;
    localStorage.setItem(RECENT, JSON.stringify(list));
  }

  const noteRecent = (path: string) => setRecent([path, ...readRecent().filter((one) => !samePath(one, path))].slice(0, MAX_RECENT));

  async function openRecent(path: string) {
    if ((await api.pathKind(path)) !== "file") {
      setRecent(readRecent().filter((one) => !samePath(one, path)));
      notice = t("notice.recentGone", { path });
      return;
    }
    await openPath(path);
  }

  let recentOpen = $state(false);

  function closeRecent() {
    recentOpen = false;
    editor?.focus();
  }

  /** The files of the tabs closed last, the last at the end, for Ctrl+Shift+T. */
  let closedEditors = $state.raw<{ path: string; place: Place | null }[]>([]);
  const MAX_CLOSED = 30;

  function rememberClosed(id: number, pane: Pane) {
    const path = tabOf(id)?.doc.path;
    if (!path) return;
    closedEditors = [...closedEditors, { path, place: pane.editors[id]?.place() ?? null }].slice(-MAX_CLOSED);
  }

  /** Reopen Closed Editor: the last tab closed, where it was; one open again since is passed over. */
  async function reopenClosed() {
    while (closedEditors.length) {
      const { path, place } = closedEditors[closedEditors.length - 1];
      closedEditors = closedEditors.slice(0, -1);
      if (tabOfPath(path) || (await api.pathKind(path)) !== "file") continue;
      await openPath(path);
      await tick();
      const tab = tabOfPath(path);
      if (tab && place) panes[focused].editors[tab.doc.id]?.goToPlace(place);
      return;
    }
  }

  /** Save All: every file with unsaved changes; a new one asks for its name, and cancelling stops. */
  async function saveAll() {
    for (const tab of [...tabs]) {
      await flush(tab.doc.id);
      if (!tab.state.dirty) continue;
      if (tab.doc.path === null) activate(tab.doc.id);
      if (!(await saveTab(tab))) return;
    }
  }

  const AUTO_SAVE_DELAY = 1000;
  const autoSaves = new Map<number, ReturnType<typeof setTimeout>>();

  /** Auto Save: a file saves a second after its last edit here, as in VS Code. */
  function autoSaveSoon(id: number) {
    if (!settings.autoSave) return;
    clearTimeout(autoSaves.get(id));
    autoSaves.set(
      id,
      setTimeout(() => autoSave(id), AUTO_SAVE_DELAY),
    );
  }

  async function autoSave(id: number) {
    autoSaves.delete(id);
    const tab = tabOf(id);
    if (!settings.autoSave || !tab || tab.doc.path === null || !tab.state.dirty || tab.changedOnDisk) return;
    // After the save under way.
    if (saving) return autoSaveSoon(id);
    // Never over a change made to the file elsewhere: the banner tells of it instead.
    if (await api.diskChanged(id).catch(() => false)) {
      tab.changedOnDisk = true;
      return;
    }
    await saveTab(tab);
  }

  function toggleAutoSave() {
    settings.autoSave = !settings.autoSave;
  }

  // Turned on, from the menu or the settings: what is unsaved saves soon, not only after its next edit.
  $effect(() => {
    if (!settings.autoSave) return;
    untrack(() => {
      for (const tab of tabs) if (tab.state.dirty) autoSaveSoon(tab.doc.id);
    });
  });

  // ---- Edit menu: comments, Find in Files ----------------------------------------

  /** Toggle Line Comment (Ctrl+/) or Toggle Block Comment (Shift+Alt+A), as the language writes them. */
  function toggleComment(block: boolean) {
    const tab = active;
    const target = editor;
    if (!tab || !target) return;
    const comments = commentsOf(tab.lang);
    const pair = comments.block;
    const marker = comments.line;
    if (block && pair) target.editSelection((anchor, caret) => api.toggleBlockComment(tab.doc.id, pair[0], pair[1], anchor, caret));
    else if (!block && marker) target.editSelection((anchor, caret) => api.toggleLineComment(tab.doc.id, marker, comments.atStart, anchor, caret));
  }

  /** The activity bar: a click on the view showing hides the sidebar, as in VS Code. */
  function pickSideView(view: "explorer" | "search") {
    if (sidebarOpen && sideView === view) sidebarOpen = false;
    else {
      sidebarOpen = true;
      sideView = view;
    }
  }

  /** Find in Files (Ctrl+Shift+F), Replace in Files (Ctrl+Shift+H): the search view, with the selected text. */
  async function showSearch(replace: boolean) {
    const seed = editor?.findSeed(false) ?? null;
    sidebarOpen = true;
    sideView = "search";
    await tick();
    searchView?.focus(replace, seed);
  }

  /** A match picked in the search view: its file, with it selected. */
  async function openMatch(path: string, start: number, end: number) {
    await openPath(path, false);
    await tick();
    const tab = tabOfPath(path);
    if (tab) panes[focused].editors[tab.doc.id]?.select(start, end);
  }

  /** Replace in Files changed documents open here or in another window: their views follow. */
  function replacedIn(done: api.FileReplaced[]) {
    for (const { doc: id, result } of done) {
      if (id === null || !result) continue;
      const view = panes.find((pane) => pane.editors[id])?.editors[id];
      if (view) view.applyResult(result);
      else tell({ kind: "edited", id, change: result.change, state: result.state });
    }
  }

  /** Exit: every window closes, each asking about its own unsaved changes. */
  function quit() {
    emit(QUIT, { from: thisWindow });
    getCurrentWindow().close();
  }

  function watchIndex(id: number) {
    clearInterval(polls.get(id));
    let last = { at: performance.now(), scanned: 0 };
    const poll = async () => {
      const next = await api.indexStatus(id).catch(() => null);
      const tab = tabOf(id);
      if (!next || !tab) return;
      const at = performance.now();
      if (at > last.at) tab.rate = ((next.scanned - last.scanned) / (at - last.at)) * 1000;
      last = { at, scanned: next.scanned };
      tab.status = next;
      if (tab.goto !== null && (next.complete || next.lines > tab.goto)) {
        for (const view of viewsOf(id)) view.gotoLine(Math.min(tab.goto, next.lines - 1));
        tab.goto = null;
      }
      if (next.complete || next.error) clearInterval(polls.get(id));
    };
    poll();
    polls.set(id, setInterval(poll, 250));
  }

  /** An edit in a pane: wherever else the document shows follows. */
  function edited(id: number, from: Pane, result: api.EditResult) {
    keepOpen(id);
    for (const pane of panes) if (pane !== from) pane.editors[id]?.followEdit(result.change);
    followScope(id, result.change);
    refreshAfterEdit(id, result.state);
    autoSaveSoon(id);
    if (sharedDocs.has(id)) tell({ kind: "edited", id, change: result.change, state: result.state });
  }

  /** Edits change the line count and can settle the language; refresh them once typing pauses. */
  function refreshAfterEdit(id: number, state: api.DocState) {
    const tab = tabOf(id);
    if (!tab) return;
    tab.state = state;
    clearTimeout(statusRefresh.get(id));
    statusRefresh.set(
      id,
      setTimeout(async () => {
        const next = await api.indexStatus(id).catch(() => null);
        const tab = tabOf(id);
        if (!next || !tab) return;
        tab.status = next;
        if (dependsOnContent(tab.doc.name)) tab.lang = await langOf(id, tab.doc.name);
      }, 150),
    );
  }

  // ---- Go to line, keys -------------------------------------------------------

  function openGoto() {
    gotoValue = "";
    gotoOpen = true;
  }

  function submitGoto() {
    const status = active?.status;
    const line = Number.parseInt(gotoValue.replaceAll(",", ""), 10);
    if (!status || !Number.isFinite(line) || line < 1) return;
    if (!status.complete && line > status.lines) {
      notice = t("goto.notReached", { lines: fmt(status.lines), percent: indexPercent });
      return;
    }
    editor?.gotoLine(Math.min(line, status.lines) - 1);
    gotoOpen = false;
    editor?.focus();
  }

  function gotoKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") submitGoto();
    else if (e.key === "Escape") {
      gotoOpen = false;
      editor?.focus();
    } else return;
    e.preventDefault();
  }

  $effect(() => {
    if (gotoOpen && gotoInput) gotoInput.focus();
  });

  function openSettings(page: Category = "general") {
    encodingOpen = false;
    gotoOpen = false;
    settingsPage = page;
    settingsOpen = true;
  }

  function closeSettings() {
    settingsOpen = false;
    editor?.focus();
  }

  /**
   * Ctrl+F, Ctrl+H: opens the bar on the selected text, if any. With `orWord`
   * (Ctrl+F2, Change All Occurrences), on the word at the caret if nothing is
   * selected: there is one caret only, so changing all of them is a Replace All.
   */
  async function startFind(replace: boolean, orWord = false) {
    const seed = editor?.findSeed(orWord);
    if (seed) needle = regex ? escapeRegex(seed) : seed;
    if (replace) replacing = true;
    else if (!findOpen) replacing = false;
    findOpen = true;
    await tick();
    // With what to find given, what is left to type is its replacement.
    findBar?.focus(replace && seed ? "replace" : "find");
  }

  /**
   * F3 goes on with the last search, Ctrl+F3 searches for the selection or the
   * word at the caret. The keyboard stays where it is; the bar opens to show
   * the progress of a long search and to cancel it.
   */
  async function findAgain(backward: boolean, fromSelection: boolean) {
    if (fromSelection || !needle) {
      const seed = editor?.findSeed(true);
      if (seed) needle = regex ? escapeRegex(seed) : seed;
    }
    if (!needle) return startFind(false);
    if (!findOpen) replacing = false;
    findOpen = true;
    await tick();
    findBar?.run(backward);
  }

  /** What finds `text` as it is, with the regular expression toggle on. */
  const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

  /** Find in Selection (Alt+L, the bar's button): in the selection, or everywhere again. */
  function toggleScope() {
    if (activeScope) {
      scope = null;
      return;
    }
    const [anchor, caret] = editor?.selection() ?? [0, 0];
    if (!active || anchor === caret) return;
    scope = { id: active.doc.id, range: [Math.min(anchor, caret), Math.max(anchor, caret)] };
  }

  /** The scope stays on its text through an edit; one that takes it all ends it. */
  function followScope(id: number, change: api.Change) {
    if (scope?.id !== id) return;
    const end = change.start + change.oldLen;
    const moved = (at: number, isEnd: boolean) =>
      at >= end ? at + change.newLen - change.oldLen : at <= change.start ? at : isEnd ? change.start + change.newLen : change.start;
    const range: [number, number] = [moved(scope.range[0], false), moved(scope.range[1], true)];
    scope = range[0] < range[1] ? { id, range } : null;
  }

  /** What the find bar looks for in a document, to show on screen. */
  function highlightFor(id: number): api.Query | null {
    if (!findOpen) return null;
    return { needle, caseSensitive, wholeWord, regex, scope: scope?.id === id ? scope.range : null };
  }

  async function showAbout() {
    about = { version: await getVersion() };
  }

  /** The licenses of the third-party software in the app: a file installed with it, opened as any other. */
  function openNotices() {
    api.noticesPath().then(
      (path) => openPath(path, false),
      (e) => (notice = describeError(e)),
    );
  }

  /** The keyboard goes to a pane, or leaves the editors if the pane is empty. */
  function focusPane(at: number) {
    const pane = panes[at];
    if (!pane) return;
    if (pane.activeId !== null) activate(pane.activeId, at);
    else {
      focused = at;
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  function closeAbout() {
    about = null;
    editor?.focus();
  }

  /** The Edit menu works on the editor, wherever the keyboard was. */
  /** The keyboard is in the text, where the comment keys work. */
  const inText = () => !!editor && !!document.activeElement?.closest(".editor");

  function inEditor(command: (target: NonNullable<typeof editor>) => unknown) {
    if (!editor) return;
    editor.focus();
    command(editor);
  }

  // Everything here also has its key: below, or in the editor for the Edit menu.
  let menus = $derived.by<Menu[]>(() => {
    const tab = active;
    const open = tab !== null;
    const splitted = panes.length > 1;
    const current = presetOf(layout);
    const preset = (name: Preset, label: string, key: string) => ({
      label,
      key,
      checked: current === name,
      run: () => applyPreset(name),
    });
    return [
      {
        label: t("menu.file"),
        key: "F",
        items: [
          { label: t("menu.new"), key: "N", shortcut: "Ctrl+N", run: () => newFile() },
          { label: t("menu.newFileOf"), key: "F", run: () => (newFileOpen = true) },
          { label: t("menu.newWindow"), key: "W", shortcut: "Ctrl+Shift+N", run: newWindow },
          "separator",
          { label: t("menu.open"), key: "O", shortcut: "Ctrl+O", run: chooseFile },
          { label: t("menu.openFolder"), key: "D", run: openFolder },
          {
            label: t("menu.openRecent"),
            key: "R",
            items: [
              { label: t("menu.reopenClosed"), key: "R", shortcut: "Ctrl+Shift+T", enabled: closedEditors.length > 0, run: reopenClosed },
              "separator",
              ...recentFiles.slice(0, RECENT_SHOWN).map((path) => ({ label: path, key: "", run: () => openRecent(path) })),
              ...(recentFiles.length ? ["separator" as const] : []),
              { label: t("menu.moreRecent"), key: "M", shortcut: "Ctrl+R", enabled: recentFiles.length > 0, run: () => (recentOpen = true) },
              "separator",
              { label: t("menu.clearRecent"), key: "C", enabled: recentFiles.length > 0, run: () => setRecent([]) },
            ],
          },
          { label: t("menu.compareWith"), key: "P", enabled: !!tab?.doc.path, run: compareActiveWith },
          "separator",
          {
            label: t("menu.save"),
            key: "S",
            shortcut: "Ctrl+S",
            enabled: !!tab?.state.dirty && !saving,
            run: () => tab && saveTab(tab),
          },
          {
            label: t("menu.saveAs"),
            key: "A",
            shortcut: "Ctrl+Shift+S",
            enabled: open && !saving,
            run: () => tab && saveTabAs(tab),
          },
          { label: t("menu.saveAll"), key: "L", shortcut: "Ctrl+K S", enabled: tabs.some((one) => one.state.dirty) && !saving, run: saveAll },
          { label: t("menu.encoding"), key: "E", enabled: open, run: () => (encodingOpen = true) },
          "separator",
          { label: t("menu.autoSave"), key: "U", checked: settings.autoSave, run: toggleAutoSave },
          "separator",
          { label: t("menu.revert"), key: "V", enabled: !!tab?.doc.path, run: () => tab && revert(tab) },
          { label: t("menu.closeTab"), key: "C", shortcut: "Ctrl+W", enabled: open || splitted, run: closeTabOrPane },
          { label: t("menu.closeWindow"), key: "I", shortcut: "Ctrl+Shift+W", run: () => getCurrentWindow().close() },
          "separator",
          { label: t("menu.settings"), key: "T", shortcut: "Ctrl+,", run: () => openSettings() },
          "separator",
          { label: t("menu.exit"), key: "X", run: quit },
        ],
      },
      {
        label: t("menu.edit"),
        key: "E",
        items: [
          {
            label: t("menu.undo"),
            key: "U",
            shortcut: "Ctrl+Z",
            enabled: !!tab?.state.canUndo,
            run: () => inEditor((target) => target.undo()),
          },
          {
            label: t("menu.redo"),
            key: "R",
            shortcut: "Ctrl+Y",
            enabled: !!tab?.state.canRedo,
            run: () => inEditor((target) => target.undo(true)),
          },
          "separator",
          { label: t("menu.cut"), key: "T", shortcut: "Ctrl+X", enabled: open, run: () => inEditor((target) => target.copySelection(true)) },
          { label: t("menu.copy"), key: "C", shortcut: "Ctrl+C", enabled: open, run: () => inEditor((target) => target.copySelection(false)) },
          {
            label: t("menu.paste"),
            key: "P",
            shortcut: "Ctrl+V",
            enabled: open,
            run: () => inEditor(pasteClipboard),
          },
          "separator",
          { label: t("menu.lineComment"), key: "O", shortcut: "Ctrl+/", enabled: !!tab && !!commentsOf(tab.lang).line, run: () => toggleComment(false) },
          { label: t("menu.blockComment"), key: "B", shortcut: "Shift+Alt+A", enabled: !!tab && !!commentsOf(tab.lang).block, run: () => toggleComment(true) },
        ],
      },
      {
        label: t("menu.selection"),
        // Not C, W, R, P or L: Alt+ those is column mode and the find bar's toggles.
        key: "T",
        items: [
          { label: t("menu.selectAll"), key: "A", shortcut: "Ctrl+A", enabled: open, run: () => inEditor((target) => target.selectAll()) },
          { label: t("menu.expandSelection"), key: "E", shortcut: "Ctrl+Shift+Alt+→", enabled: open, run: () => inEditor((target) => target.expandSelection()) },
          { label: t("menu.shrinkSelection"), key: "S", shortcut: "Ctrl+Shift+Alt+←", enabled: open, run: () => inEditor((target) => target.shrinkSelection()) },
          "separator",
          { label: t("menu.copyLineUp"), key: "C", shortcut: "Ctrl+Shift+Alt+↑", enabled: open, run: () => inEditor((target) => target.copyLines(true)) },
          { label: t("menu.copyLineDown"), key: "D", shortcut: "Ctrl+Shift+Alt+↓", enabled: open, run: () => inEditor((target) => target.copyLines(false)) },
          { label: t("menu.moveLineUp"), key: "M", shortcut: "Alt+↑", enabled: open, run: () => inEditor((target) => target.moveLines(true)) },
          { label: t("menu.moveLineDown"), key: "O", shortcut: "Alt+↓", enabled: open, run: () => inEditor((target) => target.moveLines(false)) },
          { label: t("menu.duplicate"), key: "U", shortcut: "Ctrl+D", enabled: open, run: () => inEditor((target) => target.duplicate()) },
          "separator",
          { label: t("menu.cursorAbove"), key: "B", shortcut: "Ctrl+Alt+↑", enabled: open, run: () => inEditor((target) => target.addCursor(-1)) },
          { label: t("menu.cursorBelow"), key: "W", shortcut: "Ctrl+Alt+↓", enabled: open, run: () => inEditor((target) => target.addCursor(1)) },
          "separator",
          {
            label: t("menu.columnMode"),
            key: "L",
            shortcut: "Alt+C",
            enabled: open,
            checked: !!activeCaret?.columnMode,
            run: () => inEditor((target) => target.toggleColumnMode()),
          },
        ],
      },
      {
        label: t("menu.search"),
        key: "S",
        items: [
          { label: t("menu.find"), key: "F", shortcut: "Ctrl+F", enabled: open, run: () => startFind(false) },
          { label: t("menu.replace"), key: "R", shortcut: "Ctrl+H", enabled: open, run: () => startFind(true) },
          { label: t("menu.findNext"), key: "N", shortcut: "F3", enabled: open, run: () => findAgain(false, false) },
          { label: t("menu.findPrevious"), key: "P", shortcut: "Shift+F3", enabled: open, run: () => findAgain(true, false) },
          { label: t("menu.findSelection"), key: "S", shortcut: "Ctrl+F3", enabled: open, run: () => findAgain(false, true) },
          { label: t("textMenu.changeAll"), key: "C", shortcut: "Ctrl+F2", enabled: open, run: () => startFind(true, true) },
          "separator",
          { label: t("menu.findInFiles"), key: "I", shortcut: "Ctrl+Shift+F", run: () => showSearch(false) },
          { label: t("menu.replaceInFiles"), key: "E", shortcut: "Ctrl+Shift+H", run: () => showSearch(true) },
          "separator",
          { label: t("menu.goto"), key: "G", shortcut: "Ctrl+G", enabled: open, run: openGoto },
        ],
      },
      {
        label: t("menu.view"),
        key: "V",
        items: [
          { label: t("menu.palette"), key: "C", shortcut: "Ctrl+Shift+P", run: openPalette },
          "separator",
          { label: t("menu.explorer"), key: "E", shortcut: "Ctrl+B", checked: sidebarOpen, run: () => (sidebarOpen = !sidebarOpen) },
          "separator",
          { label: t("menu.lineNumbers"), key: "N", checked: settings.lineNumbers, run: () => (settings.lineNumbers = !settings.lineNumbers) },
          { label: t("menu.highlightLine"), key: "H", checked: settings.highlightLine, run: () => (settings.highlightLine = !settings.highlightLine) },
          { label: t("menu.syntax"), key: "S", checked: settings.syntaxHighlight, run: () => (settings.syntaxHighlight = !settings.syntaxHighlight) },
          { label: t("menu.fieldShading"), key: "F", checked: settings.fieldShading, run: () => (settings.fieldShading = !settings.fieldShading) },
          { label: t("menu.rainbow"), key: "R", checked: settings.rainbowColumns, run: toggleRainbow },
          "separator",
          {
            label: rendering ? t("menu.showSource") : t("menu.openPreview"),
            key: "O",
            shortcut: "Ctrl+Shift+V",
            enabled: previewable,
            run: togglePreview,
          },
          { label: t("menu.previewToSide"), key: "D", shortcut: "Ctrl+K V", enabled: previewable, run: previewToSide },
          "separator",
          {
            label: t("menu.editorLayout"),
            key: "L",
            items: [
              { label: t("menu.splitUp"), key: "U", run: () => split("top") },
              { label: t("menu.splitDown"), key: "D", run: () => split("bottom") },
              { label: t("menu.splitLeft"), key: "L", run: () => split("left") },
              { label: t("menu.splitRight"), key: "R", run: () => split("right") },
              "separator",
              { label: t("menu.moveToNewWindow"), key: "M", enabled: open, run: () => toNewWindow(true) },
              { label: t("menu.copyToNewWindow"), key: "C", enabled: open, run: () => toNewWindow(false) },
              "separator",
              preset("single", t("menu.layoutSingle"), "S"),
              preset("twoColumns", t("menu.layoutTwoColumns"), "T"),
              preset("threeColumns", t("menu.layoutThreeColumns"), "H"),
              preset("twoRows", t("menu.layoutTwoRows"), "W"),
              preset("threeRows", t("menu.layoutThreeRows"), "E"),
              preset("grid", t("menu.layoutGrid"), "G"),
              preset("twoRowsRight", t("menu.layoutTwoRowsRight"), "I"),
              preset("twoColumnsBottom", t("menu.layoutTwoColumnsBottom"), "B"),
              "separator",
              { label: t("menu.flipLayout"), key: "F", shortcut: "Shift+Alt+0", enabled: splitted, run: flipLayout },
            ],
          },
          {
            label: t("menu.moveTab"),
            key: "M",
            shortcut: "Ctrl+Alt+←/→",
            enabled: open && (splitted || panes[0].ids.length > 1),
            run: () => moveTabBy(1, true),
          },
          { label: t("menu.switchPane"), key: "W", shortcut: "Ctrl+1…9", enabled: splitted, run: () => focusPane((focused + 1) % panes.length) },
        ],
      },
      {
        label: t("menu.help"),
        key: "H",
        items: [
          { label: t("menu.shortcuts"), key: "K", run: () => openSettings("shortcuts") },
          { label: t("menu.notices"), key: "N", run: openNotices },
          { label: t("menu.about"), key: "A", run: showAbout },
        ],
      },
    ];
  });

  // ---- A pane's own menu --------------------------------------------------------

  function toggleMoreMenu(key: number, button: HTMLElement) {
    if (paneMenu?.button === button) closePaneMenu();
    else paneMenu = { key, kind: "more", button };
  }

  function closePaneMenu() {
    paneMenu = null;
    editor?.focus();
  }

  function toggleLock(pane: Pane) {
    pane.locked = !pane.locked;
    focusPane(panes.indexOf(pane));
  }

  /** A tab's own menu. What runs on a tab that is not showing first makes it show, where it has to show. */
  function tabMenuItems(pane: Pane, id: number): DropEntry[] {
    const others = pane.ids.filter((one) => one !== id && !pane.pinned.includes(one));
    const toRight = pane.ids.slice(pane.ids.indexOf(id) + 1).filter((one) => !pane.pinned.includes(one));
    const pinned = pane.pinned.includes(id);
    const showing = (run: () => void) => () => {
      activate(id, panes.indexOf(pane));
      run();
    };
    const canMove = (side: Side) => neighbor(layout, pane.key, side) !== null || pane.ids.length > 1;
    return [
      { label: t("tabMenu.close"), shortcut: "Ctrl+W", run: () => closeTab(id, panes.indexOf(pane)) },
      { label: t("tabMenu.closeOthers"), shortcut: "Ctrl+Alt+T", enabled: others.length > 0, run: () => closeOthers(pane, id) },
      { label: t("tabMenu.closeRight"), enabled: toRight.length > 0, run: () => closeToRight(pane, id) },
      { label: t("more.closeSaved"), shortcut: "Ctrl+K U", palette: false, run: () => closeSaved(pane) },
      { label: t("more.closeAll"), shortcut: "Ctrl+K W", palette: false, run: () => closeAll(pane) },
      "separator",
      { label: t("tabMenu.keepOpen"), shortcut: "Ctrl+K Enter", enabled: pane.previewId === id, run: () => keepOpen(id) },
      { label: t(pinned ? "tabMenu.unpin" : "tabMenu.pin"), shortcut: "Ctrl+K Shift+Enter", run: () => togglePin(id, pane) },
      "separator",
      { label: t("tabMenu.splitRight"), palette: false, run: showing(() => splitTab("right")) },
      {
        label: t("tabMenu.splitMove"),
        items: [
          { label: t("menu.splitUp"), palette: false, run: showing(() => splitTab("top")) },
          { label: t("menu.splitDown"), palette: false, run: showing(() => splitTab("bottom")) },
          { label: t("menu.splitLeft"), palette: false, run: showing(() => splitTab("left")) },
          { label: t("menu.splitRight"), palette: false, run: showing(() => splitTab("right")) },
          "separator",
          { label: t("tabMenu.moveUp"), enabled: canMove("top"), run: () => moveTabToSide(id, pane, "top") },
          { label: t("tabMenu.moveDown"), enabled: canMove("bottom"), run: () => moveTabToSide(id, pane, "bottom") },
          { label: t("tabMenu.moveLeft"), enabled: canMove("left"), run: () => moveTabToSide(id, pane, "left") },
          { label: t("tabMenu.moveRight"), enabled: canMove("right"), run: () => moveTabToSide(id, pane, "right") },
        ],
      },
      "separator",
      { label: t("tabMenu.moveToNewWindow"), palette: false, run: showing(() => toNewWindow(true)) },
      { label: t("tabMenu.copyToNewWindow"), shortcut: "Ctrl+K O", palette: false, run: showing(() => toNewWindow(false)) },
    ];
  }

  /** The more-actions menu of a pane. */
  function moreItemsFor(pane: Pane): DropEntry[] {
    return [
      { label: t("more.showOpen"), run: () => (listing = pane.key) },
      "separator",
      { label: t("more.closeAll"), shortcut: "Ctrl+K W", run: () => closeAll(pane) },
      { label: t("more.closeSaved"), shortcut: "Ctrl+K U", run: () => closeSaved(pane) },
      "separator",
      { label: t("more.preview"), checked: settings.previewEditors, run: () => (settings.previewEditors = !settings.previewEditors) },
      "separator",
      { label: t("more.lock"), checked: pane.locked, run: () => toggleLock(pane) },
      "separator",
      { label: t("more.configure"), run: () => openSettings("editor") },
    ];
  }

  /** The text's own menu. */
  function textMenuItems(): DropEntry[] {
    return [
      { label: t("textMenu.changeAll"), shortcut: "Ctrl+F2", palette: false, run: () => startFind(true, true) },
      "separator",
      { label: t("menu.cut"), shortcut: "Ctrl+X", palette: false, run: () => inEditor((target) => target.copySelection(true)) },
      { label: t("menu.copy"), shortcut: "Ctrl+C", palette: false, run: () => inEditor((target) => target.copySelection(false)) },
      { label: t("menu.paste"), shortcut: "Ctrl+V", palette: false, run: pasteClipboard },
      "separator",
      { label: t("menu.palette"), shortcut: "Ctrl+Shift+P", palette: false, run: openPalette },
      "separator",
      { label: t("menu.rainbow"), checked: settings.rainbowColumns, palette: false, run: toggleRainbow },
    ];
  }

  let paneMenuItems = $derived.by<DropEntry[]>(() => {
    const pane = panes.find((one) => one.key === paneMenu?.key);
    if (!pane || !paneMenu) return [];
    if (paneMenu.kind === "tab") return tabMenuItems(pane, paneMenu.tab!);
    if (paneMenu.kind === "text") return textMenuItems();
    if (paneMenu.kind === "preview") return previewMenuItems(pane);
    return moreItemsFor(pane);
  });

  // ---- The command palette ---------------------------------------------------

  let paletteOpen = $state(false);

  interface Command extends PickerItem {
    run: () => void;
  }

  /**
   * Everything the menus can do now, by name: the menu bar's, then the pane's
   * and its tab's, without what is there already.
   */
  let commands = $derived.by<Command[]>(() => {
    if (!paletteOpen) return [];
    const list: Command[] = [];
    const walk = (path: string[], entries: (MenuEntry | DropEntry)[]) => {
      for (const entry of entries) {
        if (entry === "separator" || ("enabled" in entry && entry.enabled === false) || ("palette" in entry && entry.palette === false)) continue;
        const name = [...path, entry.label].join(": ");
        if ("items" in entry) walk([...path, entry.label], entry.items);
        else list.push({ key: name, name, shortcut: entry.shortcut, mark: entry.checked ? "✓" : undefined, run: entry.run });
      }
    };
    for (const menu of menus) walk([menu.label], menu.items);
    const pane = panes[focused];
    walk([t("palette.pane")], moreItemsFor(pane));
    if (pane.activeId !== null) walk([t("palette.tab")], tabMenuItems(pane, pane.activeId));
    return list;
  });

  function openPalette() {
    encodingOpen = false;
    gotoOpen = false;
    paletteOpen = true;
  }

  function closePalette() {
    paletteOpen = false;
    editor?.focus();
  }

  function runCommand(key: number | string) {
    const command = commands.find((one) => one.key === key);
    closePalette();
    command?.run();
  }

  function toggleRainbow() {
    settings.rainbowColumns = !settings.rainbowColumns;
  }

  async function pasteClipboard() {
    const text = await api.readClipboard();
    if (text) editor?.paste(text);
  }

  function pickListed(id: number) {
    const at = panes.findIndex((pane) => pane.key === listing);
    listing = null;
    activate(id, at);
  }

  function closeListing() {
    listing = null;
    editor?.focus();
  }

  /** The key after Ctrl+K. The keyboard was away from the text meanwhile: an IME must not compose it. */
  function finishChord(e: KeyboardEvent) {
    chord = false;
    chordFrom?.focus();
    chordFrom = null;
    const pane = panes[focused];
    if (e.code === "KeyW") closeAll(pane);
    else if (e.code === "KeyU") closeSaved(pane);
    else if (e.code === "KeyO") toNewWindow(false);
    else if (e.code === "KeyS") saveAll();
    else if (e.code === "KeyV") previewToSide();
    else if (e.key === "Enter" && pane.activeId !== null) {
      if (e.shiftKey) togglePin(pane.activeId, pane);
      else keepOpen(pane.activeId);
    }
    e.preventDefault();
  }

  /** The active tab; in an empty pane, with others beside it, the pane itself. */
  function closeTabOrPane() {
    // A pinned tab closes only on purpose, from its menu: the keyboard just goes on to the next.
    if (active && panes[focused].pinned.includes(active.doc.id)) cycle(1);
    else if (active) closeTab(active.doc.id, focused);
    else if (panes.length > 1) closeEmptyPane(focused);
  }

  /** The keyboard stays in the pane that had it; if this one had it, it goes next door. */
  function closeEmptyPane(at: number) {
    closePane(at);
    focusPane(focused);
  }

  // Alt pressed and released by itself goes to the menu bar, as on Windows. The
  // right Alt is left out: on Korean keyboards it can be the Hangul key.
  let altAlone = false;

  function onkeyup(e: KeyboardEvent) {
    if (e.code !== "AltLeft" || !altAlone) return;
    altAlone = false;
    if (prompt || about || settingsOpen || encodingOpen || paletteOpen || listing !== null) return;
    e.preventDefault();
    menuBar?.toggleKeyboard();
  }

  function onkeydown(e: KeyboardEvent) {
    if (prompt) {
      if (e.key === "Escape") answer("cancel");
      return;
    }
    if (about) {
      if (e.key === "Escape") closeAbout();
      else if (e.key === "Tab") e.preventDefault();
      return;
    }
    if (chord) {
      if (!["Control", "Meta", "Shift", "Alt"].includes(e.key)) finishChord(e);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.altKey && !mod && !e.shiftKey && !settingsOpen && !encodingOpen && menuBar?.openByKey(e.code)) {
      e.preventDefault();
      return;
    }
    if (mod && key === ",") {
      if (settingsOpen) closeSettings();
      else openSettings();
    } else if (settingsOpen) return;
    else if (mod && !e.shiftKey && !e.altKey && e.code === "KeyK") {
      chord = true;
      chordFrom = document.activeElement as HTMLElement | null;
      chordFrom?.blur();
    } else if ((mod && e.shiftKey && e.code === "KeyP") || e.key === "F1") openPalette();
    else if (mod && e.key === "F2" && active) startFind(true, true);
    else if (mod && key === "o") chooseFile();
    else if (mod && e.shiftKey && key === "n") newWindow();
    else if (mod && key === "n") newFile();
    else if (mod && e.shiftKey && key === "w") getCurrentWindow().close();
    else if (mod && e.shiftKey && key === "t") reopenClosed();
    else if (mod && !e.shiftKey && key === "r") recentOpen = true;
    else if (mod && key === "s" && active) e.shiftKey ? saveTabAs(active) : saveTab(active);
    else if (mod && key === "w" && (active || panes.length > 1)) closeTabOrPane();
    else if (mod && e.altKey && e.code === "KeyT" && active) closeOthers(panes[focused], active.doc.id);
    else if (mod && e.code === "Backslash" && panes.length > 1) applyPreset("single");
    else if (mod && e.code === "Backslash") split(sideAfter(splitDirection));
    else if (mod && /^Digit[1-9]$/.test(e.code)) focusPane(Number(e.code.slice(5)) - 1);
    else if (e.altKey && e.shiftKey && !mod && e.code === "Digit0") flipLayout();
    else if (mod && e.altKey && e.key === "ArrowRight") moveTabBy(1);
    else if (mod && e.altKey && e.key === "ArrowLeft") moveTabBy(-1);
    else if (e.ctrlKey && e.key === "Tab") cycle(e.shiftKey ? -1 : 1);
    else if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) cycle(e.key === "PageDown" ? 1 : -1);
    else if (mod && key === "b") sidebarOpen = !sidebarOpen;
    else if (mod && e.shiftKey && !e.altKey && e.code === "KeyF") showSearch(false);
    else if (mod && e.shiftKey && !e.altKey && e.code === "KeyH") showSearch(true);
    else if (mod && e.shiftKey && !e.altKey && e.code === "KeyE") pickSideView("explorer");
    else if (mod && e.shiftKey && !e.altKey && e.code === "KeyV" && previewable) togglePreview();
    else if (mod && !e.shiftKey && !e.altKey && e.code === "Slash" && inText()) toggleComment(false);
    else if (e.shiftKey && e.altKey && !mod && e.code === "KeyA" && inText()) toggleComment(true);
    else if (mod && (key === "f" || key === "h") && active) startFind(key === "h");
    else if (mod && key === "g" && active) openGoto();
    else if (e.key === "F3" && active) findAgain(e.shiftKey, mod);
    else if (e.altKey && !mod && e.code === "KeyW" && findOpen) wholeWord = !wholeWord;
    else if (e.altKey && !mod && e.code === "KeyR" && findOpen) regex = !regex;
    else if (e.altKey && !mod && e.code === "KeyP" && findOpen) preserveCase = !preserveCase;
    else if (e.altKey && !mod && e.code === "KeyL" && findOpen) toggleScope();
    else if (e.key === "F10" && !encodingOpen) menuBar?.toggleKeyboard();
    else if (e.key === "Escape" && findOpen && !encodingOpen && !e.defaultPrevented) findBar?.close();
    else return;
    e.preventDefault();
  }

  async function onfocus() {
    explorer?.refresh();
    await checkDisk();
  }

  // Sidebar resizing.
  let resizing: { x: number; width: number } | null = null;

  function sashDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizing = { x: e.clientX, width: sidebarWidth };
  }

  function sashMove(e: PointerEvent) {
    if (!resizing) return;
    sidebarWidth = Math.min(640, Math.max(160, resizing.width + e.clientX - resizing.x));
  }

  /** The layout of a session, of any age. */
  function savedLayout(session: Session): Tree<SavedPane> {
    if (session.layout) return session.layout;
    const first = { paths: session.paths ?? [], active: session.active ?? null };
    if (!session.second?.paths.length) return first;
    const share = Number(saved("paneShare")) || 0.5;
    return {
      direction: session.direction ?? "columns",
      children: [
        { node: first, share },
        { node: session.second, share: 1 - share },
      ],
    };
  }

  /** Reopens the panes and files of a session; a pane whose files have all gone goes too. */
  async function restoreSession(session: Session) {
    if (session.direction) splitDirection = session.direction;
    const wanted: { pane: Pane; saved: SavedPane }[] = [];
    const next = mapLeaves<SavedPane, { pane: number }>(savedLayout(session), (saved) => {
      const pane = wanted.length ? newPane() : panes[0];
      wanted.push({ pane, saved });
      return { pane: pane.key };
    });
    setLayout(next, panes[0], wanted.slice(1).map(({ pane }) => pane));
    for (const [at, { saved }] of wanted.entries()) {
      focused = at;
      for (const path of saved.paths) {
        if ((await api.pathKind(path)) !== "file") continue;
        // Open in another pane as well: a second tab on the same document.
        const open = tabOfPath(path);
        if (open) addView(open.doc.id, at);
        else await openPath(path, false);
      }
      const shown = saved.active ? tabOfPath(saved.active) : undefined;
      if (shown && panes[at].ids.includes(shown.doc.id)) panes[at].activeId = shown.doc.id;
      const preview = saved.preview ? tabOfPath(saved.preview) : undefined;
      if (preview && settings.previewEditors && panes[at].ids.includes(preview.doc.id)) panes[at].previewId = preview.doc.id;
      for (const path of saved.pinned ?? []) {
        const pinned = tabOfPath(path);
        if (pinned && panes[at].ids.includes(pinned.doc.id)) togglePin(pinned.doc.id, panes[at]);
      }
      for (const path of saved.rendered ?? []) {
        const rendered = tabOfPath(path);
        if (rendered && panes[at].ids.includes(rendered.doc.id)) panes[at].rendered.push(rendered.doc.id);
      }
    }
    // Only now: a locked pane would have sent its own files elsewhere.
    for (const [at, { saved }] of wanted.entries()) panes[at].locked = !!saved.locked;
    const keys = wanted.map(({ pane }) => pane.key);
    for (const [at, { saved }] of wanted.entries()) {
      const now = panes.findIndex((pane) => pane.key === keys[at]);
      if (saved.paths.length && !panes[now].ids.length && panes.length > 1) closePane(now);
    }
    focused = panes[session.focused ?? 0] ? (session.focused ?? 0) : 0;
  }

  /** A window opened from another: it starts with that tab, and its layout is not kept. */
  async function startWith({ place, ...loaded }: WindowStart) {
    sharedDocs.add(loaded.doc.id);
    add(loaded);
    if (loaded.doc.path) explorer?.reveal(loaded.doc.path, false);
    await tick();
    if (place) editor?.goToPlace(place);
  }

  /** Reopens the files of the last session, then the one passed on the command line. */
  async function restore() {
    const start = await api.windowStart<WindowStart | EmptyStart>();
    if (start) return "empty" in start ? undefined : startWith(start);
    const session = (settings.restoreSession ? JSON.parse(localStorage.getItem("hu.session") ?? "null") : null) as Session | null;
    if (session) await restoreSession(session);

    const launched = await api.launchPath();
    const shownId = panes[focused].activeId;
    const activePath = shownId === null ? null : tabOf(shownId)?.doc.path;
    const current = launched ?? activePath;
    // The tab showing is only revealed: only the command line opens a file on purpose.
    if (current) await openPath(current, true, !launched);
    restored = true;
  }

  onMount(() => {
    const unlisten: (() => void)[] = [];
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        const dragged = e.payload;
        if (dragged.type === "leave") {
          dropZone = null;
          return;
        }
        // Called physical, but only Windows sends device pixels; macOS and Linux send CSS pixels already.
        const { x, y } = dragged.position.toLogical(isWindows ? window.devicePixelRatio : 1);
        dragFiles(x, y);
        if (dragged.type === "drop") await dropFiles(dragged.paths, true);
      })
      .then((u) => unlisten.push(u));
    // Closing the window with unsaved changes asks first; other windows go on.
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (!(await mayClose(tabs))) e.preventDefault();
        else for (const tab of tabs) api.closeDocument(tab.doc.id);
      })
      .then((u) => unlisten.push(u));
    listen<DocNews & { from: string }>(DOC_NEWS, ({ payload }) => {
      if (payload.from !== thisWindow) heard(payload);
    }).then((u) => unlisten.push(u));
    listen<{ from: string }>(QUIT, ({ payload }) => {
      if (payload.from !== thisWindow) getCurrentWindow().close();
    }).then((u) => unlisten.push(u));
    restore();
    return () => {
      unlisten.forEach((u) => u());
      polls.forEach(clearInterval);
    };
  });
</script>

<svelte:window
  {onkeydown}
  {onkeyup}
  {onfocus}
  onstorage={(e) => e.key === RECENT && (recentFiles = readRecent())}
  onkeydowncapture={(e) => (altAlone = e.code === "AltLeft")}
  onmousedowncapture={() => {
    altAlone = false;
    chord = false;
    chordFrom = null;
  }}
  onblur={() => (altAlone = false)}
/>

<main>
  <header class="topbar">
    <MenuBar bind:this={menuBar} {menus} />
    {#if active}
      <span class="path" title={active.doc.path ?? t("doc.notSaved")}>{active.doc.path ?? active.doc.name}</span>
    {/if}
  </header>

  {#if active?.changedOnDisk}
    <div class="banner">
      {t(active.state.dirty ? "banner.changedUnsaved" : "banner.changed")}
      <button onclick={() => active && reload(active)}>{t("banner.reload")}</button>
    </div>
  {/if}

  <div class="workbench">
    <nav class="activity" aria-label={t("activity.label")}>
      <button
        class:on={sidebarOpen && sideView === "explorer"}
        title={t("activity.explorer")}
        aria-label={t("activity.explorer")}
        aria-pressed={sidebarOpen && sideView === "explorer"}
        onclick={() => pickSideView("explorer")}
      >
        <svg viewBox="0 0 24 24"><path d="M14.5 2.5h-8v15h11v-12zM14.5 2.5v3h3M6.5 6.5h-3v15h11v-4" /></svg>
      </button>
      <button
        class:on={sidebarOpen && sideView === "search"}
        title={t("activity.search")}
        aria-label={t("activity.search")}
        aria-pressed={sidebarOpen && sideView === "search"}
        onclick={() => pickSideView("search")}
      >
        <svg viewBox="0 0 24 24"><circle cx="13.5" cy="9.5" r="6" /><path d="M9.2 13.8L3 20" /></svg>
      </button>
    </nav>
    <div class="sidebar" class:hidden={!sidebarOpen} style:width="{sidebarWidth}px">
      <div class="view" class:hidden={sideView !== "search"}>
        <SearchView
          bind:this={searchView}
          near={active?.doc.path ? dirName(active.doc.path) : null}
          onopen={openMatch}
          onreplaced={replacedIn}
        />
      </div>
      <div class="view" class:hidden={sideView !== "explorer"}>
      <Explorer
        bind:this={explorer}
        active={active?.doc.path ?? null}
        onopen={(path, preview) => openPath(path, false, preview)}
        onopenside={openToSide}
        oncompare={openCompare}
        onmoved={followMoves}
        ondeleted={checkDisk}
        ondragfile={dragFiles}
        ondropfile={(paths, point) => {
          if (!point) dropZone = null;
          else {
            dragFiles(point.x, point.y);
            dropFiles(paths, false);
          }
        }}
        onerror={(message) => (notice = message)}
      />
      </div>
    </div>
    <div
      class="sash"
      class:hidden={!sidebarOpen}
      role="presentation"
      onmousedown={(e) => e.preventDefault()}
      onpointerdown={sashDown}
      onpointermove={sashMove}
      onpointerup={() => (resizing = null)}
      onpointercancel={() => (resizing = null)}
    ></div>

    <div class="panes" bind:this={panesBox}>
      {#each panes as pane, i (pane.key)}
        {@const box = arranged.boxes.get(pane.key)!}
        <section
          class="pane"
          class:focused={i === focused}
          class:drop-target={i === dropZone?.pane}
          data-side={i === dropZone?.pane ? dropZone.side : undefined}
          data-pane={i}
          style:left="{box.x * 100}%"
          style:top="{box.y * 100}%"
          style:width="{box.width * 100}%"
          style:height="{box.height * 100}%"
          onfocusin={() => (focused = i)}
          onmousedowncapture={(e) => {
            // Closing a pane is no reason to take the keyboard to it.
            if (!(e.target as Element).closest(".close-pane")) focused = i;
          }}
        >
          {#if pane.ids.length}
            <TabBar
              tabs={tabItems(pane)}
              active={pane.activeId}
              focused={i === focused}
              onselect={(id) => activate(id, i)}
              onclose={(id) => closeTab(id, i)}
              ondrag={(x, y) => dragTab(i, x, y)}
              ondrop={(id, point) => {
                if (point) dragTab(i, point.x, point.y);
                else dropZone = null;
                dropTab(id, i);
              }}
              onkeep={keepOpen}
              onunpin={(id) => togglePin(id, pane)}
              oncontext={(id, x, y) => (paneMenu = { key: pane.key, kind: "tab", tab: id, point: { x, y } })}
              locked={pane.locked}
              markdown={pane.activeId !== null && pane.rendered.includes(pane.activeId)
                ? "rendered"
                : tabOf(pane.activeId ?? -1)?.lang === "markdown"
                  ? "source"
                  : null}
              onpreview={(side) => {
                focusPane(i);
                if (side) previewToSide();
                else togglePreview();
              }}
              onsplit={(down) => split(down ? "bottom" : "right")}
              onunlock={() => toggleLock(pane)}
              onmore={(button) => toggleMoreMenu(pane.key, button)}
            />
            <div class="editors">
              <!-- In a stable order, whatever the tabs': an editor moved would lose the keyboard and its scrolling. -->
              {#each [...pane.ids].sort((a, b) => a - b) as id (id)}
                {@const tab = tabOf(id)}
                {#if tab}
                  {@const showsPreview = pane.rendered.includes(id)}
                  <div class="slot" class:hidden={id !== pane.activeId || showsPreview}>
                    <Editor
                      bind:this={pane.editors[id]}
                      doc={tab.doc}
                      lang={tab.lang}
                      indexed={tab.status?.scanned ?? 0}
                      lines={tab.status?.lines ?? 0}
                      highlight={highlightFor(id)}
                      covered={i === focused && findOpen ? () => findBar?.box() ?? null : undefined}
                      oncaret={(c) => (pane.carets[id] = c)}
                      oncontext={(x, y) => (paneMenu = { key: pane.key, kind: "text", point: { x, y } })}
                      onedit={(result) => edited(id, pane, result)}
                      onerror={(message) => (notice = message)}
                    />
                  </div>
                  {#if showsPreview}
                    <div class="slot" class:hidden={id !== pane.activeId}>
                      <MarkdownView
                        bind:this={pane.previews[id]}
                        {id}
                        version={tab.state.version}
                        path={tab.doc.path}
                        onlink={(href) => followLink(href, tab, pane)}
                        oncontext={(x, y) => (paneMenu = { key: pane.key, kind: "preview", point: { x, y } })}
                      />
                    </div>
                  {/if}
                {/if}
              {/each}
              {#if i === focused && findOpen && active && editor}
                <FindBar
                  bind:this={findBar}
                  bind:replacing
                  bind:needle
                  bind:replacement
                  bind:caseSensitive
                  bind:wholeWord
                  bind:regex
                  bind:preserveCase
                  doc={active.doc}
                  docState={active.state}
                  viewer={editor}
                  caret={activeCaret ?? undefined}
                  scope={activeScope}
                  ontogglescope={toggleScope}
                  onclose={() => {
                    findOpen = false;
                    scope = null;
                    editor?.focus();
                  }}
                />
              {/if}
              {#if i === focused}
                {#if gotoOpen}
                  <div class="goto">
                    <span>{t("goto.label")}</span>
                    <input
                      bind:this={gotoInput}
                      bind:value={gotoValue}
                      inputmode="numeric"
                      placeholder={active?.status?.complete ? `1 – ${fmt(active.status.lines)}` : t("goto.placeholder")}
                      onkeydown={gotoKeydown}
                      onblur={() => (gotoOpen = false)}
                    />
                  </div>
                {/if}
              {/if}
            </div>
          {:else}
            {#if panes.length > 1}
              <!-- VS Code's empty group has this button alone where the tab bar's would be. -->
              <button
                class="close-pane"
                title={t("tabs.closeGroup")}
                aria-label={t("tabs.closeGroup")}
                tabindex="-1"
                onmousedown={(e) => e.preventDefault()}
                onclick={() => closeEmptyPane(i)}
              >
                <svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
              </button>
            {/if}
            <div class="empty">
              <p>
                {t("empty.open")}<br />
                {t("empty.new")}
              </p>
              <p class="muted">Abaqus .inp · Nastran .bdf / .dat / .nas</p>
              {#if panes.length > 1}
                <p class="muted">{t("empty.closePane")}</p>
              {/if}
            </div>
          {/if}
        </section>
      {/each}
      {#each arranged.sashes as sash (sash.id)}
        <div
          class="pane-sash"
          class:rows={sash.direction === "rows"}
          role="presentation"
          style:left="{sash.x * 100}%"
          style:top="{sash.y * 100}%"
          style:width="{sash.width * 100}%"
          style:height="{sash.height * 100}%"
          onmousedown={(e) => e.preventDefault()}
          onpointerdown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            resizingPanes = sash;
          }}
          onpointermove={paneSashMove}
          onpointerup={() => (resizingPanes = null)}
          onpointercancel={() => (resizingPanes = null)}
        ></div>
      {/each}
      {#if notice}
        <button class="notice" title={t("notice.dismiss")} onclick={() => (notice = null)}>{notice}</button>
      {/if}
    </div>
  </div>

  <footer class="statusbar">
    {#if chord}
      <span>{t("status.chord")}</span>
    {:else if active}
      <span>{position}</span>
      {#if activeCaret?.field}
        <span class="field">{t("status.field", { n: activeCaret.field })}</span>
      {/if}
      <span>{size(active.state.len)}</span>
      {#if saving?.id === active.doc.id}
        <span>{t("status.saving", { percent: active.state.len ? Math.floor((saving.written / active.state.len) * 100) : 0 })}</span>
      {:else if active.state.dirty}
        <span>{t("status.modified")}</span>
      {/if}
      <span class="spacer"></span>
      {#if activeCaret?.columnMode}
        <span class="mode" title={t("status.columnMode")}>COL</span>
      {/if}
      <span>{indexText}</span>
      <button
        class="status-button"
        title={t("status.encoding")}
        onclick={() => (encodingOpen = !encodingOpen)}>{ENCODING_LABEL[active.doc.encoding]}</button
      >
      <span>{active.doc.eol === "crlf" ? "CRLF" : "LF"}</span>
      <span>{lang === "plain" ? t("status.plainText") : langLabel(lang)}</span>
    {/if}
  </footer>

  {#if encodingOpen && active}
    {@const tab = active}
    <EncodingMenu
      current={tab.doc.encoding}
      chosen={tab.chosenEncoding}
      dirty={tab.state.dirty}
      onread={(encoding) => readAs(tab, encoding)}
      onsave={(encoding) => saveConverted(tab, encoding)}
      onclose={closeEncodingMenu}
    />
  {/if}

  {#if paneMenu}
    <DropMenu items={paneMenuItems} anchor={paneMenu.button} point={paneMenu.point} onclose={closePaneMenu} />
  {/if}

  {#if listing !== null}
    {@const pane = panes.find((one) => one.key === listing)}
    {#if pane}
      <Picker
        items={tabItems(pane).map((tab) => ({ key: tab.id, name: tab.name, detail: tab.path ?? "", mark: tab.dirty ? "●" : undefined }))}
        selected={pane.activeId}
        label={t("more.showOpen")}
        placeholder={t("openEditors.filter")}
        none={t("openEditors.none")}
        onpick={(key) => pickListed(key as number)}
        onclose={closeListing}
      />
    {/if}
  {/if}

  {#if newFileOpen}
    <Picker
      items={[
        { key: "plain", name: t("newFile.text") },
        { key: "abaqus", name: t("newFile.abaqus"), detail: ".inp" },
        { key: "nastran", name: t("newFile.nastran"), detail: ".bdf" },
      ]}
      label={t("menu.newFileOf")}
      placeholder={t("newFile.filter")}
      none={t("palette.none")}
      typed={(name) => ({ key: `name:${name}`, name: t("newFile.create", { name }) })}
      onpick={pickNewFile}
      onclose={closeNewFile}
    />
  {/if}

  {#if recentOpen}
    <Picker
      items={recentFiles.map((path) => ({ key: path, name: baseName(path), detail: dirName(path) }))}
      label={t("menu.openRecent")}
      placeholder={t("recent.filter")}
      none={t("recent.none")}
      onpick={(path) => {
        recentOpen = false;
        openRecent(String(path));
      }}
      onclose={closeRecent}
    />
  {/if}

  {#if paletteOpen}
    <Picker items={commands} label={t("menu.palette")} placeholder={t("palette.filter")} none={t("palette.none")} onpick={runCommand} onclose={closePalette} />
  {/if}

  {#if settingsOpen && !prompt}
    <SettingsDialog initial={settingsPage} onclose={closeSettings} />
  {/if}

  {#if about}
    <div class="backdrop" role="presentation">
      <div class="dialog" role="dialog" aria-labelledby="about-title">
        <p id="about-title" class="product">HU Editor</p>
        <p class="muted">{t("about.version", { version: about.version })}</p>
        <p>{t("about.description")}</p>
        <div class="buttons">
          <button class="primary" use:takeFocus onclick={closeAbout}>{t("about.close")}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if prompt}
    <SavePrompt names={prompt.names} onanswer={answer} />
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 30px;
    padding: 0 10px 0 4px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .path {
    margin-left: auto;
    overflow: hidden;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    background: #4d3b00;
  }
  .workbench {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .sidebar {
    flex: none;
    min-width: 0;
  }
  .view {
    height: 100%;
  }
  /* VS Code's activity bar: which view the sidebar shows. */
  .activity {
    display: flex;
    flex: none;
    flex-direction: column;
    width: 48px;
    background: #333333;
  }
  .activity button {
    display: grid;
    place-items: center;
    height: 48px;
    padding: 0;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: #858585;
  }
  .activity button:hover,
  .activity button.on {
    color: #fff;
  }
  .activity button.on {
    border-left-color: #fff;
  }
  .activity svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linejoin: round;
  }
  /* Reaches 2px over the sidebar to be easy to grab. The rest is a little space between
     the sidebar and the text, with a line on each side of it. */
  .sash {
    flex: none;
    width: 6px;
    margin-left: -2px;
    z-index: 5;
    cursor: col-resize;
    border-left: 2px solid transparent;
    background-clip: content-box;
    box-shadow:
      inset 1px 0 0 var(--border),
      inset -1px 0 0 var(--border);
  }
  .sash:hover {
    background-color: var(--accent);
    box-shadow: none;
  }
  .hidden {
    display: none;
  }
  .panes {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .pane {
    position: absolute;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* Where a dragged tab would go. */
  .pane.drop-target::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 20;
    background: rgba(0, 122, 204, 0.25);
    pointer-events: none;
  }
  .pane[data-side="left"]::after {
    right: 50%;
  }
  .pane[data-side="right"]::after {
    left: 50%;
  }
  .pane[data-side="top"]::after {
    bottom: 50%;
  }
  .pane[data-side="bottom"]::after {
    top: 50%;
  }
  .pane-sash {
    position: absolute;
    z-index: 5;
    min-width: 4px;
    margin-left: -2px;
    cursor: col-resize;
    background: linear-gradient(var(--border), var(--border)) center / 1px 100% no-repeat;
  }
  .pane-sash.rows {
    min-width: 0;
    min-height: 4px;
    margin: -2px 0 0;
    cursor: row-resize;
    background: linear-gradient(var(--border), var(--border)) center / 100% 1px no-repeat;
  }
  .pane-sash:hover {
    background: var(--accent);
  }
  .editors {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .slot {
    position: absolute;
    inset: 0;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 0 16px;
    box-sizing: border-box;
    color: var(--fg);
    text-align: center;
  }
  /* In an empty pane, nothing else says that it has the keyboard. */
  .pane.focused:not(:only-of-type) > .empty {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  /* As the tab bar's buttons, at their place. */
  .close-pane {
    position: absolute;
    top: 5px;
    right: 6px;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
  }
  .pane.focused .close-pane {
    color: var(--fg);
  }
  .close-pane:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .close-pane svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .muted {
    color: var(--muted);
  }
  .goto {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    transform: translateX(-50%);
    background: var(--panel);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 6px 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .notice {
    position: absolute;
    bottom: 12px;
    left: 50%;
    z-index: 10;
    max-width: 70%;
    padding: 8px 14px;
    transform: translateX(-50%);
    background: #5a1d1d;
    color: #f8d7da;
  }
  .statusbar {
    display: flex;
    gap: 16px;
    min-height: 22px;
    padding: 0 10px;
    align-items: center;
    overflow: hidden;
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .status-button {
    padding: 0 4px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    font-size: inherit;
  }
  .status-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }
  .mode {
    padding: 0 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.25);
    font-weight: 600;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .dialog {
    min-width: 360px;
    padding: 18px 20px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .dialog p {
    margin: 0 0 8px;
  }
  .dialog .product {
    font-size: 16px;
    font-weight: 600;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
