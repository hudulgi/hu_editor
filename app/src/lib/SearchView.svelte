<script lang="ts">
  // Find in Files, as VS Code's search view has it. There is no workspace, so
  // it searches a folder of its own, the open file's to start with; a file open
  // in the editor is searched as it is there.

  import { open as openDialog, message as askDialog } from "@tauri-apps/plugin-dialog";
  import * as api from "./api";
  import { baseName, dirName, formatNumber, parentName } from "./format";
  import { describeError, t } from "./i18n";
  import { settings } from "./settings.svelte";

  interface Props {
    /** The open file's folder, where a search starts if none is chosen. */
    near: string | null;
    /** Opens `path` with `[start, end)` selected. */
    onopen: (path: string, start: number, end: number) => void;
    /** Replace in Files changed documents open here: they show it. */
    onreplaced: (done: api.FileReplaced[]) => void;
  }

  let { near, onopen, onreplaced }: Props = $props();

  let input = $state<HTMLInputElement>();
  let replaceInput = $state<HTMLInputElement>();
  let needle = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let regex = $state(false);
  let preserveCase = $state(false);
  let replacing = $state(false);
  let details = $state(false);
  let folder = $state("");
  let include = $state("");
  let exclude = $state("");

  let results = $state<(api.FileMatches & { closed: boolean })[]>([]);
  let summary = $state<api.Searched | null>(null);
  let searching = $state(false);
  let searchedFiles = $state(0);
  let problem = $state("");
  let message = $state("");
  let seq = 0;

  let query = $derived<api.Query>({ needle, caseSensitive, wholeWord, regex, scope: null });
  let where = $derived(folder.trim());

  /** Ctrl+Shift+F, Ctrl+Shift+H: the keyboard to what to find, the open file's folder if none is set. */
  export function focus(replace = false, seed: string | null = null) {
    if (replace) replacing = true;
    if (seed) needle = seed;
    if (!folder && near) folder = near;
    const target = replace && seed ? replaceInput : input;
    queueMicrotask(() => {
      target?.focus();
      target?.select();
    });
  }

  // Again as what is asked changes, once typing stops.
  $effect(() => {
    const asked = { query: { ...query }, folder: where, include, exclude };
    const timer = setTimeout(() => run(asked), 300);
    return () => clearTimeout(timer);
  });

  async function run(asked: { query: api.Query; folder: string; include: string; exclude: string } = { query: { ...query }, folder: where, include, exclude }) {
    const mine = ++seq;
    results = [];
    summary = null;
    problem = "";
    message = "";
    if (!asked.query.needle || !asked.folder) {
      searching = false;
      api.cancelSearchFiles();
      return;
    }
    searching = true;
    searchedFiles = 0;
    try {
      const done = await api.searchFiles(
        asked.folder,
        asked.query,
        asked.include,
        asked.exclude,
        settings.fallbackEncoding,
        (found) => mine === seq && results.push({ ...found, closed: false }),
        (files) => mine === seq && (searchedFiles = files),
      );
      if (mine === seq) summary = done;
    } catch (e) {
      if (mine === seq) problem = describeError(e);
    } finally {
      if (mine === seq) searching = false;
    }
  }

  function clear() {
    needle = "";
    replacement = "";
    input?.focus();
  }

  async function chooseFolder() {
    const path = await openDialog({ multiple: false, directory: true, defaultPath: where || near || undefined });
    if (typeof path === "string") folder = path;
  }

  let total = $derived(results.reduce((n, file) => n + file.hits.length, 0));

  async function replaceAll() {
    if (!total) return;
    const files = results.map((file) => file.path);
    const answer = await askDialog(
      t(files.length === 1 ? "search.replaceAskOne" : "search.replaceAsk", {
        count: formatNumber(total),
        files: formatNumber(files.length),
        replacement,
      }),
      { title: t("search.replaceAll"), kind: "warning", buttons: { ok: t("search.replace"), cancel: t("search.cancel") } },
    );
    if (answer !== t("search.replace")) return;
    try {
      const done = await api.replaceInFiles(files, { ...query }, replacement, preserveCase, settings.fallbackEncoding);
      onreplaced(done);
      const count = done.reduce((n, one) => n + one.count, 0);
      const failed = done.find((one) => one.error);
      await run();
      message = failed?.error ? describeError(failed.error) : t("search.replaced", { count: formatNumber(count), files: formatNumber(done.filter((one) => one.count).length) });
    } catch (e) {
      message = describeError(e);
    }
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  }

  let said = $derived.by(() => {
    if (problem) return problem;
    if (message) return message;
    if (searching) return t("search.searching", { files: formatNumber(searchedFiles) });
    if (!where && needle) return t("search.noFolder");
    if (!summary) return "";
    if (!summary.matches) return t("search.none");
    const text = t(results.length === 1 ? "search.foundOne" : "search.found", { count: formatNumber(summary.matches), files: formatNumber(results.length) });
    return summary.limited ? `${text} ${t("search.limited")}` : text;
  });
</script>

<div class="search">
  <header>
    <span class="title">{t("search.title")}</span>
    <button class="icon" title={t("search.refresh")} aria-label={t("search.refresh")} disabled={!needle || !where} onclick={() => run()}>
      <svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" /></svg>
    </button>
    <button class="icon" title={t("search.clear")} aria-label={t("search.clear")} disabled={!needle && !replacement} onclick={clear}>
      <svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></svg>
    </button>
    <button class="icon" title={t("search.collapse")} aria-label={t("search.collapse")} disabled={!results.length} onclick={() => results.forEach((file) => (file.closed = true))}>
      <svg viewBox="0 0 16 16"><path d="M3.5 2.5h9v11h-9zM6 8h4" /></svg>
    </button>
  </header>
  <div class="form">
    <button class="toggle" title={t("search.toggleReplace")} aria-label={t("search.toggleReplace")} aria-expanded={replacing} onclick={() => (replacing = !replacing)}>
      <svg class:open={replacing} viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
    </button>
    <div class="fields">
      <div class="field" class:nothing={!!problem || summary?.matches === 0}>
        <input bind:this={input} bind:value={needle} placeholder={t("search.find")} spellcheck="false" onkeydown={keydown} />
        <button class="option" class:on={caseSensitive} title={t("find.matchCase")} aria-pressed={caseSensitive} onclick={() => (caseSensitive = !caseSensitive)}>Aa</button>
        <button class="option word" class:on={wholeWord} title={t("find.wholeWord")} aria-pressed={wholeWord} onclick={() => (wholeWord = !wholeWord)}>ab</button>
        <button class="option" class:on={regex} title={t("find.regex")} aria-pressed={regex} onclick={() => (regex = !regex)}>.*</button>
      </div>
      {#if replacing}
        <div class="pair">
          <div class="field">
            <input bind:this={replaceInput} bind:value={replacement} placeholder={t("search.replace")} spellcheck="false" />
            <button class="option" class:on={preserveCase} title={t("find.preserveCase")} aria-pressed={preserveCase} onclick={() => (preserveCase = !preserveCase)}>AB</button>
          </div>
          <button class="icon" title={t("search.replaceAll")} aria-label={t("search.replaceAll")} disabled={!total || searching} onclick={replaceAll}>
            <svg viewBox="0 0 16 16">
              <path d="M3 7.5V5a2 2 0 0 1 2-2h1.5M1.5 6l1.5 1.5L4.5 6" />
              <rect x="1.5" y="9" width="11" height="5.5" rx="1" />
              <text x="7" y="13.2">ac</text>
              <text class="small" x="11" y="6.5">ab</text>
            </svg>
          </button>
        </div>
      {/if}
      <div class="pair">
        <div class="field">
          <input bind:value={folder} placeholder={t("search.folder")} spellcheck="false" title={folder} onkeydown={keydown} />
        </div>
        <button class="icon" title={t("search.chooseFolder")} aria-label={t("search.chooseFolder")} onclick={chooseFolder}>
          <svg viewBox="0 0 16 16"><path d="M1.5 12.5v-9h4L7 5h7.5v7.5z" /></svg>
        </button>
        <button class="icon" class:on={details} title={t("search.details")} aria-label={t("search.details")} aria-expanded={details} onclick={() => (details = !details)}>
          <svg viewBox="0 0 16 16"><path d="M4 8h.01M8 8h.01M12 8h.01" /></svg>
        </button>
      </div>
      {#if details}
        <label class="label" for="search-include">{t("search.include")}</label>
        <div class="field"><input id="search-include" bind:value={include} placeholder={t("search.includeHint")} spellcheck="false" onkeydown={keydown} /></div>
        <label class="label" for="search-exclude">{t("search.exclude")}</label>
        <div class="field"><input id="search-exclude" bind:value={exclude} placeholder={t("search.excludeHint")} spellcheck="false" onkeydown={keydown} /></div>
      {/if}
    </div>
  </div>
  {#if said}
    <p class="said" class:problem={!!problem} role="status">{said}</p>
  {/if}
  <div class="results" role="tree">
    {#each results as file (file.path)}
      <button class="file" role="treeitem" aria-expanded={!file.closed} aria-selected="false" title={file.path} onclick={() => (file.closed = !file.closed)}>
        <svg class="chevron" class:open={!file.closed} viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
        <span class="name">{baseName(file.path)}</span>
        <span class="folder">{file.path === dirName(file.path) ? "" : (dirName(file.path).startsWith(where) ? dirName(file.path).slice(where.length).replace(/^[\\/]/, "") : parentName(file.path))}</span>
        <span class="count">{file.hits.length}</span>
      </button>
      {#if !file.closed}
        {#each file.hits as hit (hit.start)}
          <button class="hit" role="treeitem" aria-selected="false" title={t("search.line", { line: formatNumber(hit.line + 1) })} onclick={() => onopen(file.path, hit.start, hit.end)}>
            {#if hit.cut}<span class="cut">…</span>{/if}{hit.preview.slice(0, hit.from)}{#if replacing && replacement && !regex}<del>{hit.preview.slice(hit.from, hit.to)}</del><ins>{replacement}</ins>{:else}<mark>{hit.preview.slice(hit.from, hit.to)}</mark>{/if}{hit.preview.slice(hit.to)}
          </button>
        {/each}
      {/if}
    {/each}
  </div>
</div>

<style>
  .search {
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
  .form {
    display: flex;
    flex: none;
    gap: 2px;
    padding: 0 10px 6px 2px;
  }
  .fields {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .pair {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .pair .field {
    flex: 1;
  }
  .field {
    display: flex;
    align-items: center;
    height: 24px;
    min-width: 0;
    box-sizing: border-box;
    padding-right: 2px;
    background: #3c3c3c;
    border: 1px solid #3c3c3c;
    border-radius: 3px;
  }
  .field:focus-within {
    border-color: var(--accent);
  }
  .field.nothing {
    border-color: #be1100;
  }
  .field input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 4px;
    border: none;
    background: transparent;
  }
  .label {
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }
  .option {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 18px;
    margin-left: 1px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    font-size: 12px;
    line-height: 1;
  }
  .option:hover {
    background: rgba(90, 93, 94, 0.5);
  }
  .option.on,
  .icon.on {
    border-color: var(--accent);
    background: rgba(36, 137, 219, 0.51);
    color: #fff;
  }
  .word {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .icon,
  .toggle {
    display: grid;
    flex: none;
    place-items: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
  }
  .icon {
    width: 24px;
    height: 22px;
  }
  .toggle {
    align-self: flex-start;
    width: 16px;
    height: 24px;
  }
  .icon:hover:not(:disabled),
  .toggle:hover {
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
  svg text {
    fill: currentColor;
    stroke: none;
    font: 600 6.5px var(--ui);
    text-anchor: middle;
  }
  svg text.small {
    font-size: 6px;
  }
  .toggle svg,
  .chevron {
    width: 14px;
    height: 14px;
    flex: none;
    transition: transform 0.1s;
  }
  .toggle svg.open,
  .chevron.open {
    transform: rotate(90deg);
  }
  .said {
    flex: none;
    margin: 0;
    padding: 2px 12px 6px 20px;
    color: var(--muted);
    font-size: 12px;
  }
  .said.problem {
    color: #f48771;
  }
  .results {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  .file,
  .hit {
    display: flex;
    align-items: center;
    width: 100%;
    height: 22px;
    padding: 0 10px 0 4px;
    border: none;
    border-radius: 0;
    background: transparent;
    text-align: left;
    white-space: pre;
    overflow: hidden;
    cursor: pointer;
  }
  .file {
    gap: 4px;
  }
  .hit {
    display: block;
    padding-left: 38px;
    line-height: 22px;
    text-overflow: ellipsis;
  }
  .file:hover,
  .hit:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .name {
    flex: none;
  }
  .folder {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
  }
  .count {
    flex: none;
    min-width: 12px;
    padding: 0 5px;
    border-radius: 9px;
    background: #4d4d4d;
    font-size: 11px;
    line-height: 16px;
    text-align: center;
  }
  mark,
  del {
    background: rgba(234, 92, 0, 0.33);
    color: inherit;
  }
  del {
    background: rgba(255, 0, 0, 0.2);
  }
  ins {
    background: rgba(156, 204, 44, 0.25);
    text-decoration: none;
  }
  .cut {
    color: var(--muted);
  }
</style>
