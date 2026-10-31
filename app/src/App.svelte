<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import * as api from "./lib/api";
  import { detectLang, LANG_LABEL } from "./lib/syntax";
  import FindBar from "./lib/FindBar.svelte";
  import Viewer from "./lib/Viewer.svelte";

  let doc = $state<api.DocInfo | null>(null);
  let status = $state<api.IndexStatus | null>(null);
  let rate = $state(0);
  let current = $state<api.View | null>(null);
  let lang = $derived(doc ? detectLang(doc.name) : "plain");

  let viewer = $state<ReturnType<typeof Viewer>>();
  let findBar = $state<ReturnType<typeof FindBar>>();
  let findOpen = $state(false);
  let gotoOpen = $state(false);
  let gotoValue = $state("");
  let gotoInput = $state<HTMLInputElement>();
  let notice = $state<string | null>(null);
  let changedOnDisk = $state(false);
  let poll: ReturnType<typeof setInterval> | undefined;

  const number = new Intl.NumberFormat("en-US");
  const fmt = (n: number) => number.format(n);

  function size(bytes: number) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

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
    if (!current) return "";
    if (current.firstLine !== null) return `Ln ${fmt(current.firstLine + 1)}`;
    return `Offset ${fmt(current.top)}`;
  });

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

  async function openPath(path: string) {
    try {
      const next = await api.openDocument(path);
      if (doc) api.closeDocument(doc.id);
      doc = next;
      status = null;
      current = null;
      notice = null;
      findOpen = false;
      gotoOpen = false;
      changedOnDisk = false;
      getCurrentWindow().setTitle(`${next.name} — HU Editor`);
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
    viewer?.gotoLine(Math.min(line, status.lines) - 1);
    gotoOpen = false;
    viewer?.focus();
  }

  function gotoKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") submitGoto();
    else if (e.key === "Escape") {
      gotoOpen = false;
      viewer?.focus();
    } else return;
    e.preventDefault();
  }

  $effect(() => {
    if (gotoOpen && gotoInput) gotoInput.focus();
  });

  function onkeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "o") chooseFile();
    else if (mod && key === "f" && doc) {
      if (findOpen) findBar?.focus();
      else findOpen = true;
    } else if (mod && key === "g" && doc) openGoto();
    else if (e.key === "F3" && findOpen) findBar?.run(e.shiftKey);
    else return;
    e.preventDefault();
  }

  async function checkDisk() {
    if (doc) changedOnDisk = await api.diskChanged(doc.id).catch(() => false);
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop" && e.payload.paths.length) openPath(e.payload.paths[0]);
      })
      .then((u) => (unlisten = u));
    api.launchPath().then((path) => {
      if (path) openPath(path);
    });
    return () => {
      unlisten?.();
      clearInterval(poll);
    };
  });
</script>

<svelte:window {onkeydown} onfocus={checkDisk} />

<main>
  <header class="toolbar">
    <button onclick={chooseFile} title="Open (Ctrl+O)">Open…</button>
    {#if doc}
      <span class="path" title={doc.path}>{doc.path}</span>
    {/if}
  </header>

  {#if changedOnDisk && doc}
    <div class="banner">
      The file changed on disk.
      <button onclick={() => doc && openPath(doc.path)}>Reload</button>
    </div>
  {/if}

  <section class="editor">
    {#if doc}
      <Viewer
        bind:this={viewer}
        {doc}
        {lang}
        indexed={status?.scanned ?? 0}
        lines={status?.lines ?? 0}
        onview={(v) => (current = v)}
      />
      {#if findOpen && viewer}
        <FindBar
          bind:this={findBar}
          {doc}
          {viewer}
          onclose={() => {
            findOpen = false;
            viewer?.focus();
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
        <p>Open a deck with <kbd>Ctrl</kbd>+<kbd>O</kbd> or drop a file here.</p>
        <p class="muted">Abaqus .inp · Nastran .bdf / .dat / .nas</p>
      </div>
    {/if}
    {#if notice}
      <button class="notice" title="Dismiss" onclick={() => (notice = null)}>{notice}</button>
    {/if}
  </section>

  <footer class="statusbar">
    {#if doc}
      <span>{size(doc.len)}</span>
      <span>{position}</span>
      <span class="spacer"></span>
      <span>{indexText}</span>
      <span>{LANG_LABEL[lang]}</span>
    {/if}
  </footer>
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
    gap: 12px;
    padding: 6px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .path {
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
  .editor {
    position: relative;
    flex: 1;
    min-height: 0;
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
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
</style>
