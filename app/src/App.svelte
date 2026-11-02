<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import * as api from "./lib/api";
  import { formatNumber as fmt, formatSize as size, isWindows, parentName, samePath } from "./lib/format";
  import { dependsOnContent, detectLang, LANG_LABEL, type Lang } from "./lib/syntax";
  import Editor, { type CaretInfo } from "./lib/Editor.svelte";
  import { ENCODING_LABEL } from "./lib/encodings";
  import EncodingMenu from "./lib/EncodingMenu.svelte";
  import Explorer from "./lib/Explorer.svelte";
  import FindBar from "./lib/FindBar.svelte";
  import { describeError, t } from "./lib/i18n";
  import MenuBar, { type Menu } from "./lib/MenuBar.svelte";
  import SettingsDialog from "./lib/SettingsDialog.svelte";
  import { settings, settingsFile } from "./lib/settings.svelte";
  import TabBar, { type TabItem } from "./lib/TabBar.svelte";

  type Choice = "save" | "discard" | "cancel";

  /** An open document and what the app shows about it. Each tab keeps its
   * own editor (caret, selection, scroll position) mounted while hidden. */
  interface Tab {
    doc: api.DocInfo;
    lang: Lang;
    state: api.DocState;
    status: api.IndexStatus | null;
    /** Indexing speed, bytes per second. */
    rate: number;
    caret: CaretInfo | null;
    changedOnDisk: boolean;
    /** The user chose the encoding, rather than it being detected. */
    chosenEncoding: boolean;
    /** Line to go to once the line index has reached it. */
    goto: number | null;
  }

  /** A document just opened, ready for a tab. */
  interface Loaded {
    doc: api.DocInfo;
    lang: Lang;
    chosenEncoding: boolean;
  }

  let tabs = $state<Tab[]>([]);
  let activeId = $state<number | null>(null);
  let active = $derived(tabs.find((t) => t.doc.id === activeId) ?? null);
  const editors: Record<number, ReturnType<typeof Editor> | undefined> = $state({});
  let editor = $derived(activeId === null ? undefined : editors[activeId]);
  let lang = $derived(active?.lang ?? "plain");

  let menuBar = $state<ReturnType<typeof MenuBar>>();
  let findBar = $state<ReturnType<typeof FindBar>>();
  let explorer = $state<ReturnType<typeof Explorer>>();
  let findOpen = $state(false);
  let replacing = $state(false);
  // Outlives the bar, so that F3 can go on and Ctrl+F shows it again.
  let needle = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  let highlight = $derived(findOpen && needle ? { needle, caseSensitive } : null);
  let encodingOpen = $state(false);
  let settingsOpen = $state(false);
  let settingsPage = $state<"general" | "shortcuts">("general");
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
  let sidebarWidth = $state(Number(saved("sidebarWidth")) || 280);

  $effect(() => localStorage.setItem("hu.sidebarOpen", String(sidebarOpen)));
  $effect(() => localStorage.setItem("hu.sidebarWidth", String(sidebarWidth)));

  // The open files come back next time (new documents without a file do not).
  let restored = false;
  $effect(() => {
    const paths = tabs.flatMap((t) => (t.doc.path === null ? [] : [t.doc.path]));
    const current = active?.doc.path ?? null;
    if (restored) localStorage.setItem("hu.session", JSON.stringify({ paths, active: current }));
  });

  $effect(() => {
    const title = active ? `${active.state.dirty ? "● " : ""}${active.doc.name} — HU Editor` : "HU Editor";
    getCurrentWindow().setTitle(title);
  });

  let tabItems = $derived.by((): TabItem[] => {
    const count = new Map<string, number>();
    for (const tab of tabs) count.set(tab.doc.name, (count.get(tab.doc.name) ?? 0) + 1);
    return tabs.map(({ doc, lang, state }) => ({
      id: doc.id,
      name: doc.name,
      lang,
      path: doc.path,
      dirty: state.dirty,
      // Same name in two folders: show the folder.
      hint: doc.path && count.get(doc.name)! > 1 ? parentName(doc.path) : null,
    }));
  });

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
    const caret = active?.caret;
    if (!caret) return "";
    const line = caret.line === null ? "…" : fmt(caret.line + 1);
    if (caret.box) {
      return t("status.box", { line, rows: caret.box.rows === null ? "…" : fmt(caret.box.rows), cols: caret.box.cols });
    }
    const position = t("status.position", { line, col: caret.col });
    return caret.selected ? t("status.selected", { position, count: fmt(caret.selected) }) : position;
  });

  const tabOf = (id: number) => tabs.find((t) => t.doc.id === id);

  // ---- Tabs ---------------------------------------------------------------

  function activate(id: number) {
    activeId = id;
    gotoOpen = false;
    encodingOpen = false;
    tick().then(() => {
      if (!prompt) editors[id]?.focus();
    });
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

  /** Adds a tab next to the active one, or in place of `replacing`. */
  function add({ doc, lang, chosenEncoding }: Loaded, replacing: Tab | null = null, goto: number | null = null) {
    const tab: Tab = {
      doc,
      lang,
      state: doc.state,
      status: null,
      rate: 0,
      caret: null,
      changedOnDisk: false,
      chosenEncoding,
      goto,
    };
    const at = replacing ? tabs.indexOf(replacing) : active ? tabs.indexOf(active) + 1 : tabs.length;
    if (replacing) {
      drop(replacing.doc.id);
      tabs[at] = tab;
    } else {
      tabs.splice(at, 0, tab);
    }
    activate(doc.id);
    watchIndex(doc.id);
  }

  /** Lets go of a document in the backend. */
  function drop(id: number) {
    api.closeDocument(id);
    clearInterval(polls.get(id));
    clearTimeout(statusRefresh.get(id));
    polls.delete(id);
    statusRefresh.delete(id);
    delete editors[id];
  }

  /** Closes a tab, asking first if it has unsaved changes. */
  async function closeTab(id: number) {
    const tab = tabOf(id);
    if (!tab) return false;
    await editors[id]?.flush();
    if (tab.state.dirty) {
      activate(id);
      const choice = await ask([tab.doc.name]);
      if (choice === "cancel" || (choice === "save" && !(await saveTab(tab)))) return false;
    }
    const at = tabs.findIndex((t) => t.doc.id === id);
    drop(id);
    tabs.splice(at, 1);
    if (activeId === id) {
      const next = tabs[Math.min(at, tabs.length - 1)];
      if (next) activate(next.doc.id);
      else activeId = null;
    }
    return true;
  }

  function cycle(step: number) {
    if (!active || tabs.length < 2) return;
    const at = tabs.indexOf(active);
    activate(tabs[(at + step + tabs.length) % tabs.length].doc.id);
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

  /** Whether the window may close: unsaved files are saved or given up. */
  async function mayCloseAll() {
    await Promise.all(tabs.map((t) => editors[t.doc.id]?.flush()));
    const dirty = tabs.filter((t) => t.state.dirty);
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

  const filters = () => [
    { name: t("filter.solver"), extensions: ["inp", "bdf", "dat", "nas", "blk", "bulk", "fem"] },
    { name: t("filter.all"), extensions: ["*"] },
  ];

  /** Saves; a new document asks for a file name first. */
  async function saveTab(tab: Tab) {
    // Keys typed just before Ctrl+S must make it into the file.
    await editors[tab.doc.id]?.flush();
    if (tab.doc.path === null) return saveTabAs(tab);
    if (saving) return false;
    return writing(tab, async (progress) => {
      tab.state = await api.save(tab.doc.id, progress);
    });
  }

  async function saveTabAs(tab: Tab) {
    await editors[tab.doc.id]?.flush();
    if (saving) return false;
    const path = await saveDialog({ defaultPath: tab.doc.path ?? `${tab.doc.name}.inp`, filters: filters() });
    if (!path) return false;
    return writing(tab, async (progress) => {
      const done = await api.saveAs(tab.doc.id, path, progress);
      tab.state = done.state;
      tab.doc.path = done.path;
      tab.doc.name = done.name;
      tab.lang = await langOf(tab.doc.id, done.name);
      if (tab.chosenEncoding) rememberEncoding(done.path, tab.doc.encoding);
      if (tab.doc.id === activeId) explorer?.reveal(done.path, false);
    });
  }

  /** Runs a save with progress in the status bar; false if it failed. */
  async function writing(tab: Tab, work: (progress: (written: number) => void) => Promise<void>) {
    saving = { id: tab.doc.id, written: 0 };
    try {
      await work((written) => saving && (saving.written = written));
      tab.changedOnDisk = false;
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
    await editors[id]?.flush();
    try {
      tab.doc.encoding = await api.setEncoding(id, encoding, settings.fallbackEncoding);
    } catch (e) {
      notice = describeError(e);
      return;
    }
    tab.chosenEncoding = encoding !== null;
    if (tab.doc.path !== null) rememberEncoding(tab.doc.path, encoding);
    editors[id]?.reread();
  }

  /** Saves the tab converted to `encoding`. Its bytes change, so it opens anew at the same line. */
  async function saveConverted(tab: Tab, encoding: api.Encoding) {
    closeEncodingMenu();
    const id = tab.doc.id;
    await editors[id]?.flush();
    if (saving) return;
    if (encoding === tab.doc.encoding) {
      // Nothing to convert: a plain save, and undo stays.
      await readAs(tab, encoding);
      await saveTab(tab);
      return;
    }
    const path =
      tab.doc.path ?? (await saveDialog({ defaultPath: `${tab.doc.name}.inp`, filters: filters() }));
    if (!path) return;
    const line = tab.caret?.line ?? null;
    if (!(await writing(tab, (progress) => api.saveConverted(id, path, encoding, progress)))) return;
    rememberEncoding(path, encoding);
    try {
      add(await load(path), tab, line);
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

  async function chooseFile() {
    const path = await openDialog({ multiple: false, directory: false, filters: filters() });
    if (typeof path === "string") await openPath(path);
  }

  /**
   * Shows `path` in a tab: the one it is already open in, or a new one.
   * `reveal` expands the explorer down to it (not wanted when picked there).
   */
  async function openPath(path: string, reveal = true) {
    const open = tabs.find((tab) => tab.doc.path !== null && samePath(tab.doc.path, path));
    if (open) {
      activate(open.doc.id);
    } else {
      try {
        const loaded = await load(path);
        // A blank, untouched new document gives way to the file.
        const blank = active && active.doc.path === null && !active.state.dirty && active.state.len === 0;
        add(loaded, blank ? active : null);
      } catch (e) {
        notice = describeError(e);
        return;
      }
    }
    if (reveal) explorer?.reveal(path, false);
  }

  let untitled = 0;

  /** A new, empty document in its own tab: Untitled-1, Untitled-2, … */
  async function newFile() {
    const encoding = settings.newFileEncoding;
    const doc = await api.newDocument(encoding, settings.newFileEol === "os" ? null : settings.newFileEol);
    add({
      doc: { ...doc, name: t("doc.untitled", { n: ++untitled }) },
      lang: "plain",
      chosenEncoding: encoding !== "utf8",
    });
  }

  /** Reopens a tab's file after it changed on disk; unsaved changes go. */
  async function reload(tab: Tab) {
    if (!tab.doc.path) return;
    try {
      add(await load(tab.doc.path), tab);
    } catch (e) {
      notice = describeError(e);
    }
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
        editors[id]?.gotoLine(Math.min(tab.goto, next.lines - 1));
        tab.goto = null;
      }
      if (next.complete || next.error) clearInterval(polls.get(id));
    };
    poll();
    polls.set(id, setInterval(poll, 250));
  }

  /** Edits change the line count and can settle the language; refresh them once typing pauses. */
  function edited(id: number, state: api.DocState) {
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

  function openSettings(page: "general" | "shortcuts" = "general") {
    encodingOpen = false;
    gotoOpen = false;
    settingsPage = page;
    settingsOpen = true;
  }

  function closeSettings() {
    settingsOpen = false;
    editor?.focus();
  }

  /** Ctrl+F, Ctrl+H: opens the bar on the selected text, if any. */
  async function startFind(replace: boolean) {
    const seed = editor?.findSeed();
    if (seed) needle = seed;
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
      if (seed) needle = seed;
    }
    if (!needle) return startFind(false);
    if (!findOpen) replacing = false;
    findOpen = true;
    await tick();
    findBar?.run(backward);
  }

  async function showAbout() {
    about = { version: await getVersion() };
  }

  function closeAbout() {
    about = null;
    editor?.focus();
  }

  /** The Edit menu works on the editor, wherever the keyboard was. */
  function inEditor(command: (target: NonNullable<typeof editor>) => unknown) {
    if (!editor) return;
    editor.focus();
    command(editor);
  }

  // Everything here also has its key: below, or in the editor for the Edit menu.
  let menus = $derived.by<Menu[]>(() => {
    const tab = active;
    const open = tab !== null;
    return [
      {
        label: t("menu.file"),
        key: "F",
        items: [
          { label: t("menu.new"), key: "N", shortcut: "Ctrl+N", run: newFile },
          { label: t("menu.open"), key: "O", shortcut: "Ctrl+O", run: chooseFile },
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
          { label: t("menu.encoding"), key: "E", enabled: open, run: () => (encodingOpen = true) },
          "separator",
          { label: t("menu.closeTab"), key: "C", shortcut: "Ctrl+W", enabled: open, run: () => tab && closeTab(tab.doc.id) },
          { label: t("menu.settings"), key: "T", shortcut: "Ctrl+,", run: () => openSettings() },
          "separator",
          { label: t("menu.exit"), key: "X", shortcut: "Alt+F4", run: () => getCurrentWindow().close() },
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
            run: () =>
              inEditor(async (target) => {
                const text = await api.readClipboard();
                if (text) target.paste(text);
              }),
          },
          "separator",
          { label: t("menu.selectAll"), key: "A", shortcut: "Ctrl+A", enabled: open, run: () => inEditor((target) => target.selectAll()) },
          {
            label: t("menu.columnMode"),
            key: "L",
            shortcut: "Alt+C",
            enabled: open,
            checked: !!tab?.caret?.columnMode,
            run: () => inEditor((target) => target.toggleColumnMode()),
          },
        ],
      },
      {
        label: t("menu.search"),
        key: "S",
        items: [
          { label: t("menu.find"), key: "F", shortcut: "Ctrl+F", enabled: open, run: () => startFind(false) },
          { label: t("menu.findNext"), key: "N", shortcut: "F3", enabled: open, run: () => findAgain(false, false) },
          { label: t("menu.findPrevious"), key: "P", shortcut: "Shift+F3", enabled: open, run: () => findAgain(true, false) },
          { label: t("menu.findSelection"), key: "S", shortcut: "Ctrl+F3", enabled: open, run: () => findAgain(false, true) },
          "separator",
          { label: t("menu.replace"), key: "R", shortcut: "Ctrl+H", enabled: open, run: () => startFind(true) },
          "separator",
          { label: t("menu.goto"), key: "G", shortcut: "Ctrl+G", enabled: open, run: openGoto },
        ],
      },
      {
        label: t("menu.view"),
        key: "V",
        items: [
          { label: t("menu.explorer"), key: "E", shortcut: "Ctrl+B", checked: sidebarOpen, run: () => (sidebarOpen = !sidebarOpen) },
          "separator",
          { label: t("menu.lineNumbers"), key: "N", checked: settings.lineNumbers, run: () => (settings.lineNumbers = !settings.lineNumbers) },
          { label: t("menu.highlightLine"), key: "H", checked: settings.highlightLine, run: () => (settings.highlightLine = !settings.highlightLine) },
          { label: t("menu.syntax"), key: "S", checked: settings.syntaxHighlight, run: () => (settings.syntaxHighlight = !settings.syntaxHighlight) },
          { label: t("menu.fieldShading"), key: "F", checked: settings.fieldShading, run: () => (settings.fieldShading = !settings.fieldShading) },
        ],
      },
      {
        label: t("menu.help"),
        key: "H",
        items: [
          { label: t("menu.shortcuts"), key: "K", run: () => openSettings("shortcuts") },
          { label: t("menu.about"), key: "A", run: showAbout },
        ],
      },
    ];
  });

  // Alt pressed and released by itself goes to the menu bar, as on Windows. The
  // right Alt is left out: on Korean keyboards it can be the Hangul key.
  let altAlone = false;

  function onkeyup(e: KeyboardEvent) {
    if (e.code !== "AltLeft" || !altAlone) return;
    altAlone = false;
    if (prompt || about || settingsOpen || encodingOpen) return;
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
    else if (mod && key === "o") chooseFile();
    else if (mod && key === "n") newFile();
    else if (mod && key === "s" && active) e.shiftKey ? saveTabAs(active) : saveTab(active);
    else if (mod && key === "w" && active) closeTab(active.doc.id);
    else if (e.ctrlKey && e.key === "Tab") cycle(e.shiftKey ? -1 : 1);
    else if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) cycle(e.key === "PageDown" ? 1 : -1);
    else if (mod && key === "b") sidebarOpen = !sidebarOpen;
    else if (mod && (key === "f" || key === "h") && active) startFind(key === "h");
    else if (mod && key === "g" && active) openGoto();
    else if (e.key === "F3" && active) findAgain(e.shiftKey, mod);
    else if (e.key === "F10" && !encodingOpen) menuBar?.toggleKeyboard();
    else if (e.key === "Escape" && findOpen && !encodingOpen && !e.defaultPrevented) findBar?.close();
    else return;
    e.preventDefault();
  }

  async function onfocus() {
    explorer?.refresh();
    for (const tab of tabs) {
      if (tab.doc.path !== null) tab.changedOnDisk = await api.diskChanged(tab.doc.id).catch(() => false);
    }
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

  /** Reopens the files of the last session, then the one passed on the command line. */
  async function restore() {
    const session = (settings.restoreSession ? JSON.parse(localStorage.getItem("hu.session") ?? "null") : null) as {
      paths: string[];
      active: string | null;
    } | null;
    for (const path of session?.paths ?? []) {
      if ((await api.pathKind(path)) === "file") await openPath(path, false);
    }
    const launched = await api.launchPath();
    const current = launched ?? session?.active;
    if (current) await openPath(current, true);
    restored = true;
  }

  onMount(() => {
    const unlisten: (() => void)[] = [];
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        if (e.payload.type !== "drop" || !e.payload.paths.length) return;
        for (const path of e.payload.paths) {
          if ((await api.pathKind(path)) === "dir") {
            sidebarOpen = true;
            explorer?.reveal(path, true);
          } else {
            await openPath(path);
          }
        }
      })
      .then((u) => unlisten.push(u));
    // Closing the window with unsaved changes asks first.
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (!(await mayCloseAll())) e.preventDefault();
      })
      .then((u) => unlisten.push(u));
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
  onkeydowncapture={(e) => (altAlone = e.code === "AltLeft")}
  onmousedowncapture={() => (altAlone = false)}
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
    <div class="sidebar" class:hidden={!sidebarOpen} style:width="{sidebarWidth}px">
      <Explorer
        bind:this={explorer}
        active={active?.doc.path ?? null}
        onopen={(path) => openPath(path, false)}
      />
    </div>
    <div
      class="sash"
      class:hidden={!sidebarOpen}
      role="presentation"
      onpointerdown={sashDown}
      onpointermove={sashMove}
      onpointerup={() => (resizing = null)}
      onpointercancel={() => (resizing = null)}
    ></div>

    <section class="pane">
      {#if tabs.length}
        <TabBar tabs={tabItems} active={activeId} onselect={activate} onclose={closeTab} />
        <div class="editors">
          {#each tabs as tab (tab.doc.id)}
            <div class="slot" class:hidden={tab.doc.id !== activeId}>
              <Editor
                bind:this={editors[tab.doc.id]}
                doc={tab.doc}
                lang={tab.lang}
                indexed={tab.status?.scanned ?? 0}
                lines={tab.status?.lines ?? 0}
                {highlight}
                oncaret={(c) => (tab.caret = c)}
                onstate={(state) => edited(tab.doc.id, state)}
                onerror={(message) => (notice = message)}
              />
            </div>
          {/each}
          {#if findOpen && active && editor}
            <FindBar
              bind:this={findBar}
              bind:replacing
              bind:needle
              bind:replacement
              bind:caseSensitive
              doc={active.doc}
              len={active.state.len}
              viewer={editor}
              onclose={() => {
                findOpen = false;
                editor?.focus();
              }}
            />
          {/if}
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
        </div>
      {:else}
        <div class="empty">
          <p>
            {t("empty.open")}<br />
            {t("empty.new")}
          </p>
          <p class="muted">Abaqus .inp · Nastran .bdf / .dat / .nas</p>
        </div>
      {/if}
      {#if notice}
        <button class="notice" title={t("notice.dismiss")} onclick={() => (notice = null)}>{notice}</button>
      {/if}
    </section>
  </div>

  <footer class="statusbar">
    {#if active}
      <span>{position}</span>
      <span>{size(active.state.len)}</span>
      {#if saving?.id === active.doc.id}
        <span>{t("status.saving", { percent: active.state.len ? Math.floor((saving.written / active.state.len) * 100) : 0 })}</span>
      {:else if active.state.dirty}
        <span>{t("status.modified")}</span>
      {/if}
      <span class="spacer"></span>
      {#if active.caret?.columnMode}
        <span class="mode" title={t("status.columnMode")}>COL</span>
      {/if}
      <span>{indexText}</span>
      <button
        class="status-button"
        title={t("status.encoding")}
        onclick={() => (encodingOpen = !encodingOpen)}>{ENCODING_LABEL[active.doc.encoding]}</button
      >
      <span>{active.doc.eol === "crlf" ? "CRLF" : "LF"}</span>
      <span>{lang === "plain" ? t("status.plainText") : LANG_LABEL[lang]}</span>
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
    <div class="backdrop" role="presentation">
      <div class="dialog" role="alertdialog" aria-labelledby="save-title">
        {#if prompt.names.length === 1}
          <p id="save-title">{t("prompt.saveOne", { name: prompt.names[0] })}</p>
        {:else}
          <p id="save-title">{t("prompt.saveMany", { count: prompt.names.length })}</p>
          <ul>
            {#each prompt.names as name, i (i)}
              <li>{name}</li>
            {/each}
          </ul>
        {/if}
        <p class="muted">{t("prompt.lost")}</p>
        <div class="buttons">
          <button class="primary" use:takeFocus onclick={() => answer("save")}
            >{t(prompt.names.length === 1 ? "prompt.save" : "prompt.saveAll")}</button
          >
          <button onclick={() => answer("discard")}>{t("prompt.discard")}</button>
          <button onclick={() => answer("cancel")}>{t("prompt.cancel")}</button>
        </div>
      </div>
    </div>
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
  .sash {
    flex: none;
    width: 4px;
    margin-left: -2px;
    margin-right: -2px;
    z-index: 5;
    cursor: col-resize;
    border-left: 2px solid transparent;
    background-clip: content-box;
    box-shadow: inset 1px 0 0 var(--border);
  }
  .sash:hover {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .hidden {
    display: none;
  }
  .pane {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
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
    color: var(--fg);
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
  .dialog ul {
    max-height: 200px;
    margin: 0 0 8px;
    padding-left: 20px;
    overflow: auto;
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
