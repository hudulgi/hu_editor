<script lang="ts">
  // A compare window: two files side by side, with the menus of going through
  // their differences, copying them across and saving. Its documents may be
  // shown in other windows too: what it changes is told to them, and what
  // they change is compared again where it is.

  import { emit, listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import * as api from "./lib/api";
  import CompareView from "./lib/CompareView.svelte";
  import { dirName, formatNumber as fmt } from "./lib/format";
  import { describeError, t } from "./lib/i18n";
  import MenuBar, { type Menu } from "./lib/MenuBar.svelte";
  import { DOC_NEWS, QUIT, SHOW, type CompareSide, type CompareStart, type DocNews, type ShowNews } from "./lib/news";
  import SavePrompt, { type Choice } from "./lib/SavePrompt.svelte";
  import { settings } from "./lib/settings.svelte";
  import { dependsOnContent, detectLang, type Lang } from "./lib/syntax";

  interface Side {
    doc: api.DocInfo;
    lang: Lang;
    state: api.DocState;
    chosenEncoding: boolean;
  }

  let sides = $state<Side[]>([]);
  let comparison = $state<number | null>(null);
  /** Of the comparison running, 0 to 1 while the files are read; null once they are. */
  let progress = $state<number | null>(0);
  let ready = $state(false);
  let failed = $state<string | null>(null);
  let hunks = $state(0);
  /** The rows of all the hunks by kind, and of the current one. */
  let lines = $state<api.HunkLines | null>(null);
  let currentLines = $state<api.HunkLines | null>(null);
  let current = $state<number | null>(null);
  /** Bumped when a document changed. */
  let version = $state(0);
  let notice = $state<string | null>(null);
  /** The window that opened this one: where Open in Editor shows a line. */
  let opener = $state<string | null>(null);
  let prompt = $state<{ names: string[]; answer: (choice: Choice) => void } | null>(null);
  let viewer = $state<ReturnType<typeof CompareView>>();
  let menuBar = $state<ReturnType<typeof MenuBar>>();
  /** The documents copied to, for Undo and Redo, the latest last. */
  let undoable = $state<number[]>([]);
  let redoable = $state<number[]>([]);

  const thisWindow = getCurrentWindow().label;
  const tell = (news: DocNews) => emit(DOC_NEWS, { ...$state.snapshot(news), from: thisWindow });

  let dirty = $derived(sides.some((side) => side.state.dirty));
  let langs = $derived<[Lang, Lang]>([sides[0]?.lang ?? "plain", sides[1]?.lang ?? "plain"]);

  $effect(() => {
    const names = sides.map((side) => side.doc.name);
    if (names.length === 2) getCurrentWindow().setTitle(`${t("compare.title", { left: names[0], right: names[1] })} - HU Editor`);
  });

  // ---- Opening and comparing ---------------------------------------------------

  async function langOf(id: number, name: string): Promise<Lang> {
    if (!dependsOnContent(name)) return detectLang(name);
    return (await api.detectDialect(id).catch(() => null)) ?? settings.blkDefault;
  }

  async function open(side: CompareSide): Promise<Side> {
    if (side.loaded) return { doc: side.loaded.doc, lang: side.loaded.lang, state: side.loaded.doc.state, chosenEncoding: side.loaded.chosenEncoding };
    const doc = await api.openDocument(side.path, null, settings.fallbackEncoding);
    return { doc, lang: await langOf(doc.id, doc.name), state: doc.state, chosenEncoding: false };
  }

  async function start() {
    const begun = await api.windowStart<CompareStart>();
    if (!begun) return;
    opener = begun.opener;
    const opened = await Promise.allSettled([open(begun.left), open(begun.right)]);
    for (const one of opened) if (one.status === "fulfilled") sides.push(one.value);
    const problem = opened.find((one) => one.status === "rejected");
    if (problem) {
      failed = describeError(problem.reason);
      return;
    }
    await compare();
  }

  /** Compares afresh. */
  async function compare() {
    if (sides.length !== 2) return;
    if (comparison !== null) api.compareClose(comparison);
    ready = false;
    progress = 0;
    current = null;
    try {
      const made = await api.compareNew(sides[0].doc.id, sides[1].doc.id);
      comparison = made.id;
      const done = await api.compareRun(made.id, (n) => (progress = api.allRead(n) ? null : made.work ? Math.min(n / made.work, 1) : 0));
      if (!done || comparison !== made.id) return;
      hunks = done.hunks;
      ready = true;
    } catch (e) {
      failed = describeError(e);
    }
  }

  // ---- Changes -------------------------------------------------------------------

  /**
   * A document changed here: the other windows showing it follow, and this one
   * compares again. No hunk is current then, so that copying again needs one picked.
   */
  function changed(id: number, result: api.EditResult) {
    current = null;
    for (const side of sides) if (side.doc.id === id) side.state = result.state;
    tell({ kind: "edited", id, change: result.change, state: result.state });
    version++;
  }

  async function merge(index: number, to: api.Side) {
    if (!ready || comparison === null) return;
    try {
      const { doc, result } = await api.compareMerge(comparison, index, to);
      changed(doc, result);
      undoable.push(doc);
      redoable = [];
    } catch (e) {
      notice = describeError(e);
    }
  }

  /** A line edited where it is shown, as an edit of its document. */
  async function editLine(side: api.Side, line: number, text: string) {
    if (!ready || comparison === null) return;
    try {
      const { doc, result } = await api.compareEditLine(comparison, side, line, text);
      changed(doc, result);
      undoable.push(doc);
      redoable = [];
    } catch (e) {
      notice = describeError(e);
    }
  }

  /** The window that opened this one shows the line, in its document: edited there, compared here. */
  async function showInEditor(side: api.Side, line: number) {
    const one = sides[side === "left" ? 0 : 1];
    if (!one || !opener) return;
    // Held for that window, which lets go of it if it holds it already.
    await api.retainDocument(one.doc.id);
    const loaded = $state.snapshot({ doc: { ...one.doc, state: one.state }, lang: one.lang, chosenEncoding: one.chosenEncoding });
    emit(SHOW, { to: opener, loaded, line, from: thisWindow } satisfies ShowNews & { from: string });
  }

  function showPicked() {
    const at = viewer?.pickedLine();
    if (at) showInEditor(at.side, at.line);
  }

  async function undo() {
    const id = undoable.pop();
    if (id === undefined) return;
    const result = await api.undo(id).catch(() => null);
    if (!result) return;
    changed(id, result);
    redoable.push(id);
  }

  async function redo() {
    const id = redoable.pop();
    if (id === undefined) return;
    const result = await api.redo(id).catch(() => null);
    if (!result) return;
    changed(id, result);
    undoable.push(id);
  }

  /** What another window did to a document here. */
  function heard(news: DocNews) {
    const at = sides.findIndex((side) => side.doc.id === news.id);
    if (at < 0) return;
    const side = sides[at];
    if (news.kind === "edited") side.state = news.state;
    else if (news.kind === "saved" || news.kind === "moved") {
      Object.assign(side.doc, { path: news.path, name: news.name });
      side.lang = news.lang;
      if (news.kind === "saved") side.state = news.state;
    } else if (news.kind === "encoding") side.doc.encoding = news.encoding;
    else {
      // Read again from the disk, as a new document, held for this window too.
      sides[at] = { doc: news.loaded.doc, lang: news.loaded.lang, state: news.loaded.doc.state, chosenEncoding: news.loaded.chosenEncoding };
      api.closeDocument(news.id);
      undoable = undoable.filter((id) => id !== news.id);
      redoable = redoable.filter((id) => id !== news.id);
      compare();
      return;
    }
    version++;
  }

  // ---- Saving and closing --------------------------------------------------------

  /** Saves the sides `which` that have changes; false if one could not be saved. */
  async function save(which = [0, 1]) {
    for (const at of which) {
      const side = sides[at];
      if (!side?.state.dirty) continue;
      try {
        side.state = await api.save(side.doc.id, () => {});
        tell({ kind: "saved", id: side.doc.id, state: side.state, path: side.doc.path, name: side.doc.name, lang: side.lang });
      } catch (e) {
        notice = t("notice.saveFailed", { error: describeError(e) });
        return false;
      }
    }
    return true;
  }

  function ask(names: string[]): Promise<Choice> {
    return new Promise((answer) => (prompt = { names, answer }));
  }

  function answer(choice: Choice) {
    prompt?.answer(choice);
    prompt = null;
    viewer?.focus();
  }

  /** Unsaved changes that no other window shows are saved or given up first. */
  async function mayClose() {
    const dirtyHere: number[] = [];
    for (const [at, side] of sides.entries()) {
      if (side.state.dirty && (await api.documentWindows(side.doc.id).catch(() => 1)) <= 1) dirtyHere.push(at);
    }
    if (!dirtyHere.length) return true;
    const choice = await ask(dirtyHere.map((at) => sides[at].doc.name));
    if (choice === "cancel") return false;
    return choice === "discard" || save(dirtyHere);
  }

  function release() {
    if (comparison !== null) api.compareClose(comparison);
    for (const side of sides) api.closeDocument(side.doc.id);
  }

  const closeWindow = () => getCurrentWindow().close();

  // ---- Menus and keys ------------------------------------------------------------

  /** What the keys and menus do, one after another: a copy waits for the move to the hunk before it. */
  let chain = Promise.resolve();
  const act = (f: () => unknown) => {
    chain = chain.then(async () => void (await f())).catch((e) => void (notice = describeError(e)));
  };

  let can = $derived(ready && hunks > 0);

  // What the current hunk holds, for the status bar.
  $effect(() => {
    const [index, id] = [current, comparison];
    void version;
    currentLines = null;
    if (index === null || id === null || !ready) return;
    api.compareHunk(id, index).then((found) => {
      if (found && current === index) currentLines = found.lines;
    }, () => {});
  });

  /** "2 changed, 1 only on the left", leaving out the kinds there are none of. */
  function described(of: api.HunkLines) {
    const parts: [number, "compare.changedLines" | "compare.onlyLeft" | "compare.onlyRight"][] = [
      [of.changed, "compare.changedLines"],
      [of.onlyLeft, "compare.onlyLeft"],
      [of.onlyRight, "compare.onlyRight"],
    ];
    return parts
      .filter(([count]) => count > 0)
      .map(([count, key]) => t(key, { count: fmt(count) }))
      .join(", ");
  }

  let differences = $derived.by(() => {
    if (hunks === 0) return t("compare.same");
    if (current !== null) {
      const at = t("compare.at", { n: fmt(current + 1), count: fmt(hunks) });
      return currentLines ? `${at} · ${described(currentLines)}` : at;
    }
    const count = t(hunks === 1 ? "compare.one" : "compare.count", { count: fmt(hunks) });
    return lines ? `${count} · ${described(lines)}` : count;
  });

  let menus = $derived<Menu[]>([
    {
      label: t("menu.file"),
      key: "F",
      items: [
        { label: t("menu.save"), key: "S", shortcut: "Ctrl+S", enabled: dirty, run: () => act(save) },
        { label: t("compare.saveLeft"), key: "L", enabled: !!sides[0]?.state.dirty, run: () => act(() => save([0])) },
        { label: t("compare.saveRight"), key: "R", enabled: !!sides[1]?.state.dirty, run: () => act(() => save([1])) },
        "separator",
        { label: t("compare.again"), key: "A", shortcut: "F5", enabled: sides.length === 2, run: () => act(compare) },
        "separator",
        { label: t("menu.closeWindow"), key: "C", shortcut: "Ctrl+W", run: closeWindow },
      ],
    },
    {
      label: t("menu.edit"),
      key: "E",
      items: [
        { label: t("menu.undo"), key: "U", shortcut: "Ctrl+Z", enabled: undoable.length > 0, run: () => act(undo) },
        { label: t("menu.redo"), key: "R", shortcut: "Ctrl+Y", enabled: redoable.length > 0, run: () => act(redo) },
        "separator",
        { label: t("compare.editLine"), key: "L", shortcut: "F2", enabled: ready, run: () => viewer?.edit() },
        { label: t("compare.showInEditor"), key: "O", shortcut: "Ctrl+E", enabled: ready && !!opener, run: showPicked },
      ],
    },
    {
      label: t("compare.menu"),
      key: "C",
      items: [
        { label: t("compare.next"), key: "N", shortcut: "F7", enabled: can, run: () => act(() => viewer?.next()) },
        { label: t("compare.previous"), key: "P", shortcut: "Shift+F7", enabled: can, run: () => act(() => viewer?.previous()) },
        { label: t("compare.first"), key: "F", shortcut: "Alt+Home", enabled: can, run: () => act(() => viewer?.first()) },
        { label: t("compare.last"), key: "L", shortcut: "Alt+End", enabled: can, run: () => act(() => viewer?.last()) },
        "separator",
        { label: t("compare.copyRight"), key: "R", shortcut: "Alt+Right", enabled: can && current !== null, run: () => act(() => viewer?.mergeCurrent("right")) },
        { label: t("compare.copyLeft"), key: "E", shortcut: "Alt+Left", enabled: can && current !== null, run: () => act(() => viewer?.mergeCurrent("left")) },
      ],
    },
  ]);

  let altAlone = false;

  function onkeyup(e: KeyboardEvent) {
    if (e.code !== "AltLeft" || !altAlone) return;
    altAlone = false;
    if (prompt) return;
    e.preventDefault();
    menuBar?.toggleKeyboard();
  }

  function onkeydown(e: KeyboardEvent) {
    if (prompt) {
      if (e.key === "Escape") answer("cancel");
      return;
    }
    // Typing in a line edited where it is shown: its keys are its own.
    if (e.target instanceof HTMLInputElement) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const alt: Record<string, () => unknown> = {
      ArrowDown: () => viewer?.next(),
      ArrowUp: () => viewer?.previous(),
      Home: () => viewer?.first(),
      End: () => viewer?.last(),
      ArrowRight: () => viewer?.mergeCurrent("right"),
      ArrowLeft: () => viewer?.mergeCurrent("left"),
    };
    if (key === "F7" && !mod && !e.altKey) act(() => (e.shiftKey ? viewer?.previous() : viewer?.next()));
    else if (key === "F5" && !mod) act(compare);
    else if (e.altKey && !mod && !e.shiftKey && alt[key]) act(alt[key]);
    else if (mod && !e.shiftKey && key === "s") act(save);
    else if (mod && !e.shiftKey && key === "z") act(undo);
    else if (mod && (key === "y" || (e.shiftKey && key === "z"))) act(redo);
    else if (mod && key === "w") closeWindow();
    else if (key === "F2" && !mod && !e.altKey) viewer?.edit();
    else if (mod && !e.shiftKey && key === "e") showPicked();
    else return;
    e.preventDefault();
  }

  onMount(() => {
    const unlisten: (() => void)[] = [];
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (!(await mayClose())) e.preventDefault();
        else release();
      })
      .then((u) => unlisten.push(u));
    listen<DocNews & { from: string }>(DOC_NEWS, ({ payload }) => {
      if (payload.from !== thisWindow) heard(payload);
    }).then((u) => unlisten.push(u));
    listen<{ from: string }>(QUIT, ({ payload }) => {
      if (payload.from !== thisWindow) closeWindow();
    }).then((u) => unlisten.push(u));
    start();
    return () => unlisten.forEach((u) => u());
  });
</script>

<svelte:window {onkeydown} {onkeyup} onkeydowncapture={(e) => (altAlone = e.code === "AltLeft")} onmousedowncapture={() => (altAlone = false)} onblur={() => (altAlone = false)} />

<main>
  <header class="topbar">
    <MenuBar bind:this={menuBar} {menus} />
  </header>
  <div class="heads">
    {#each sides as side, i (i)}
      <div class="head" class:left={i === 0} class:right={i === 1} title={side.doc.path}>
        <span class="name">{side.doc.name}</span>
        {#if side.state.dirty}<span class="dirty" title={t("status.modified")}>●</span>{/if}
        {#if side.doc.path}<span class="folder"><bdi>{dirName(side.doc.path)}</bdi></span>{/if}
      </div>
      {#if i === 0}
        <!-- Over the bar between the sides: the keyboard stays where it was. -->
        <div class="nav">
          <button
            title="{t('compare.previous')} (Shift+F7)"
            aria-label={t("compare.previous")}
            tabindex="-1"
            disabled={!can}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => act(() => viewer?.previous())}
          >
            <svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4" /></svg>
          </button>
          <button
            title="{t('compare.next')} (F7)"
            aria-label={t("compare.next")}
            tabindex="-1"
            disabled={!can}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => act(() => viewer?.next())}
          >
            <svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg>
          </button>
        </div>
      {/if}
    {/each}
  </div>
  <div class="main">
    {#if failed}
      <p class="message">{failed}</p>
    {:else if ready && comparison !== null}
      <CompareView
        bind:this={viewer}
        bind:current
        id={comparison}
        {langs}
        {version}
        onmerge={(index, to) => act(() => merge(index, to))}
        onedit={(side, line, text) => act(() => editLine(side, line, text))}
        onshow={showInEditor}
        onnotice={(message) => (notice = message)}
        onstats={(view) => {
          hunks = view.hunks;
          lines = view.lines;
        }}
      />
    {:else}
      <p class="message">{progress === null ? t("compare.finding") : t("compare.comparing", { percent: Math.floor(progress * 100) })}</p>
    {/if}
    {#if notice}
      <button class="notice" title={t("notice.dismiss")} onclick={() => (notice = null)}>{notice}</button>
    {/if}
  </div>
  <footer class="statusbar">
    {#if ready}
      <span class="differences">{differences}</span>
    {/if}
  </footer>
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
    min-height: 30px;
    padding: 0 10px 0 4px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .heads {
    display: flex;
    padding-right: 17px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  /* As wide as the bar between the sides below it. */
  .nav {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 42px;
  }
  .nav button {
    display: grid;
    place-items: center;
    width: 18px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--muted);
  }
  .nav button:hover:not(:disabled) {
    background: #45494e;
    color: var(--fg);
  }
  .nav button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .nav svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .head {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 4px 10px;
    white-space: nowrap;
  }
  .name {
    font-weight: 600;
  }
  .dirty {
    color: var(--muted);
  }
  .folder {
    overflow: hidden;
    color: var(--muted);
    direction: rtl;
    text-overflow: ellipsis;
  }
  .main {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .message {
    margin: 0;
    padding: 40px;
    color: var(--muted);
    text-align: center;
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
</style>
