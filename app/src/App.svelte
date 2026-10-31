<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import * as api from "./lib/api";
  import { formatNumber as fmt, formatSize as size } from "./lib/format";
  import { detectLang, LANG_LABEL } from "./lib/syntax";
  import Editor, { type CaretInfo } from "./lib/Editor.svelte";
  import Explorer from "./lib/Explorer.svelte";
  import FindBar from "./lib/FindBar.svelte";

  type Choice = "save" | "discard" | "cancel";

  let doc = $state<api.DocInfo | null>(null);
  let docState = $state<api.DocState | null>(null);
  let status = $state<api.IndexStatus | null>(null);
  let rate = $state(0);
  let caret = $state<CaretInfo | null>(null);
  let lang = $derived(doc ? detectLang(doc.name) : "plain");

  let editor = $state<ReturnType<typeof Editor>>();
  let findBar = $state<ReturnType<typeof FindBar>>();
  let explorer = $state<ReturnType<typeof Explorer>>();
  let findOpen = $state(false);
  let replacing = $state(false);
  let gotoOpen = $state(false);
  let gotoValue = $state("");
  let gotoInput = $state<HTMLInputElement>();
  let notice = $state<string | null>(null);
  let changedOnDisk = $state(false);
  let saving = $state<number | null>(null);
  let prompt = $state<{ name: string; answer: (choice: Choice) => void } | null>(null);
  let poll: ReturnType<typeof setInterval> | undefined;

  // Sidebar layout survives restarts.
  const saved = (key: string) => localStorage.getItem(`hu.${key}`);
  let sidebarOpen = $state(saved("sidebarOpen") !== "false");
  let sidebarWidth = $state(Number(saved("sidebarWidth")) || 280);

  $effect(() => localStorage.setItem("hu.sidebarOpen", String(sidebarOpen)));
  $effect(() => localStorage.setItem("hu.sidebarWidth", String(sidebarWidth)));

  $effect(() => {
    const title = doc ? `${docState?.dirty ? "● " : ""}${doc.name} — HU Editor` : "HU Editor";
    getCurrentWindow().setTitle(title);
  });

  let indexPercent = $derived(
    status && status.len ? Math.floor((status.scanned / status.len) * 100) : 0,
  );

  let indexText = $derived.by(() => {
    if (!status) return "";
    if (status.error) return `Index error: ${status.error}`;
    if (status.complete) return `${fmt(status.lines)} lines`;
    return `Indexing ${indexPercent}% · ${size(rate)}/s · ${fmt(status.lines)} lines so far`;
  });

  let position = $derived.by(() => {
    if (!caret) return "";
    const line = caret.line === null ? "Ln …" : `Ln ${fmt(caret.line + 1)}`;
    if (caret.box) return `${line} · Box ${caret.box.rows === null ? "…" : fmt(caret.box.rows)} × ${caret.box.cols}`;
    const selected = caret.selected ? ` (${fmt(caret.selected)} selected)` : "";
    return `${line}, Col ${caret.col}${selected}`;
  });

  /** Asks whether to save unsaved changes before they are dropped. */
  function ask(): Promise<Choice> {
    return new Promise((answer) => (prompt = { name: doc?.name ?? "", answer }));
  }

  function answer(choice: Choice) {
    prompt?.answer(choice);
    prompt = null;
  }

  /** Whether the current document may be replaced or closed. */
  async function mayLeave() {
    if (!doc || !docState?.dirty) return true;
    const choice = await ask();
    if (choice === "cancel") return false;
    return choice === "discard" || (await save());
  }

  async function save() {
    if (!doc || saving !== null) return false;
    saving = 0;
    try {
      docState = await api.save(doc.id, (written) => (saving = written));
      changedOnDisk = false;
      return true;
    } catch (e) {
      notice = `Save failed: ${e}`;
      return false;
    } finally {
      saving = null;
    }
  }

  async function chooseFile() {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: "Solver input", extensions: ["inp", "bdf", "dat", "nas", "blk", "bulk", "fem"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof path === "string") await openPath(path);
  }

  /** Opens `path`; `reveal` expands the explorer down to it (not wanted when it was picked there). */
  async function openPath(path: string, reveal = true) {
    if (!(await mayLeave())) return;
    try {
      const next = await api.openDocument(path);
      if (doc) api.closeDocument(doc.id);
      doc = next;
      docState = next.state;
      status = null;
      caret = null;
      notice = null;
      findOpen = false;
      gotoOpen = false;
      changedOnDisk = false;
      if (reveal) explorer?.reveal(next.path, false);
      watchIndex(next.id);
    } catch (e) {
      notice = String(e);
    }
  }

  function watchIndex(id: number) {
    clearInterval(poll);
    let last = { at: performance.now(), scanned: 0 };
    const tick = async () => {
      const next = await api.indexStatus(id).catch(() => null);
      if (!next || doc?.id !== id) return;
      const at = performance.now();
      if (at > last.at) rate = ((next.scanned - last.scanned) / (at - last.at)) * 1000;
      last = { at, scanned: next.scanned };
      status = next;
      if (next.complete || next.error) clearInterval(poll);
    };
    tick();
    poll = setInterval(tick, 250);
  }

  // Edits change the line count; refresh it once typing pauses.
  let statusRefresh: ReturnType<typeof setTimeout> | undefined;
  function edited(state: api.DocState) {
    docState = state;
    clearTimeout(statusRefresh);
    const id = doc?.id;
    statusRefresh = setTimeout(async () => {
      const next = id === undefined ? null : await api.indexStatus(id).catch(() => null);
      if (next && doc?.id === id) status = next;
    }, 150);
  }

  function openGoto() {
    gotoValue = "";
    gotoOpen = true;
  }

  function submitGoto() {
    const line = Number.parseInt(gotoValue.replaceAll(",", ""), 10);
    if (!doc || !status || !Number.isFinite(line) || line < 1) return;
    if (!status.complete && line > status.lines) {
      notice = `Line index has reached line ${fmt(status.lines)} so far (${indexPercent}%).`;
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

  function onkeydown(e: KeyboardEvent) {
    if (prompt) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "o") chooseFile();
    else if (mod && key === "s") save();
    else if (mod && key === "b") sidebarOpen = !sidebarOpen;
    else if (mod && (key === "f" || key === "h") && doc) {
      if (key === "h") replacing = true;
      else if (!findOpen) replacing = false;
      if (findOpen) findBar?.focus();
      else findOpen = true;
    } else if (mod && key === "g" && doc) openGoto();
    else if (e.key === "F3" && findOpen) findBar?.run(e.shiftKey);
    else return;
    e.preventDefault();
  }

  async function onfocus() {
    explorer?.refresh();
    if (doc) changedOnDisk = await api.diskChanged(doc.id).catch(() => false);
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

  onMount(() => {
    const unlisten: (() => void)[] = [];
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        if (e.payload.type !== "drop" || !e.payload.paths.length) return;
        const path = e.payload.paths[0];
        if ((await api.pathKind(path)) === "dir") {
          sidebarOpen = true;
          explorer?.reveal(path, true);
        } else {
          openPath(path);
        }
      })
      .then((u) => unlisten.push(u));
    // Closing the window with unsaved changes asks first.
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (!(await mayLeave())) e.preventDefault();
      })
      .then((u) => unlisten.push(u));
    api.launchPath().then((path) => {
      if (path) openPath(path);
    });
    return () => {
      unlisten.forEach((u) => u());
      clearInterval(poll);
    };
  });
</script>

<svelte:window {onkeydown} {onfocus} />

<main>
  <header class="toolbar">
    <button
      class="toggle"
      class:on={sidebarOpen}
      title="Toggle explorer (Ctrl+B)"
      aria-label="Toggle explorer"
      onclick={() => (sidebarOpen = !sidebarOpen)}
    >
      <svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M6 2.5v11" /></svg>
    </button>
    <button onclick={chooseFile} title="Open file (Ctrl+O)">Open…</button>
    <button onclick={save} disabled={!docState?.dirty || saving !== null} title="Save (Ctrl+S)">Save</button>
    {#if doc}
      <span class="path" title={doc.path}>{doc.path}</span>
    {/if}
  </header>

  {#if changedOnDisk && doc}
    <div class="banner">
      The file changed on disk{docState?.dirty ? " (you have unsaved changes)" : ""}.
      <button onclick={() => doc && openPath(doc.path)}>Reload</button>
    </div>
  {/if}

  <div class="workbench">
    <div class="sidebar" class:hidden={!sidebarOpen} style:width="{sidebarWidth}px">
      <Explorer
        bind:this={explorer}
        active={doc?.path ?? null}
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
      {#if doc}
        <Editor
          bind:this={editor}
          {doc}
          {lang}
          indexed={status?.scanned ?? 0}
          lines={status?.lines ?? 0}
          oncaret={(c) => (caret = c)}
          onstate={edited}
          onerror={(message) => (notice = message)}
        />
        {#if findOpen && editor}
          <FindBar
            bind:this={findBar}
            bind:replacing
            {doc}
            len={docState?.len ?? 0}
            viewer={editor}
            onclose={() => {
              findOpen = false;
              editor?.focus();
            }}
          />
        {/if}
        {#if gotoOpen}
          <div class="goto">
            <span>Go to line</span>
            <input
              bind:this={gotoInput}
              bind:value={gotoValue}
              inputmode="numeric"
              placeholder={status?.complete ? `1 – ${fmt(status.lines)}` : "line"}
              onkeydown={gotoKeydown}
              onblur={() => (gotoOpen = false)}
            />
          </div>
        {/if}
      {:else}
        <div class="empty">
          <p>Open a deck with <kbd>Ctrl</kbd>+<kbd>O</kbd>, pick one in the explorer, or drop a file here.</p>
          <p class="muted">Abaqus .inp · Nastran .bdf / .dat / .nas</p>
        </div>
      {/if}
      {#if notice}
        <button class="notice" title="Dismiss" onclick={() => (notice = null)}>{notice}</button>
      {/if}
    </section>
  </div>

  <footer class="statusbar">
    {#if doc && docState}
      <span>{position}</span>
      <span>{size(docState.len)}</span>
      {#if saving !== null}
        <span>Saving {docState.len ? Math.floor((saving / docState.len) * 100) : 0}%</span>
      {:else if docState.dirty}
        <span>Modified</span>
      {/if}
      <span class="spacer"></span>
      {#if caret?.columnMode}
        <span class="mode" title="Column mode (Alt+C): Shift+arrows and dragging select boxes">COL</span>
      {/if}
      <span>{indexText}</span>
      <span>{doc.encoding === "cp949" ? "CP949" : "UTF-8"}</span>
      <span>{doc.eol === "crlf" ? "CRLF" : "LF"}</span>
      <span>{LANG_LABEL[lang]}</span>
    {/if}
  </footer>

  {#if prompt}
    <div class="backdrop" role="presentation">
      <div class="dialog" role="alertdialog" aria-labelledby="save-title">
        <p id="save-title">Save changes to <b>{prompt.name}</b>?</p>
        <p class="muted">Your changes will be lost if you don't save them.</p>
        <div class="buttons">
          <!-- svelte-ignore a11y_autofocus -->
          <button class="primary" autofocus onclick={() => answer("save")}>Save</button>
          <button onclick={() => answer("discard")}>Don't Save</button>
          <button onclick={() => answer("cancel")}>Cancel</button>
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
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .toolbar button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .toggle {
    display: grid;
    place-items: center;
    width: 28px;
    height: 24px;
    padding: 0;
    color: var(--muted);
  }
  .toggle.on {
    color: var(--fg);
  }
  .toggle svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
  }
  .path {
    margin-left: 4px;
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
    flex: 1;
    min-width: 0;
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
  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--panel);
    font-family: var(--ui);
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
