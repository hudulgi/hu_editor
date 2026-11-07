<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import { formatNumber } from "./format";
  import { describeError, t } from "./i18n";

  interface Target {
    /** Waits for the keys typed so far to reach the document. */
    flush(): Promise<void>;
    /** Selects `[from, to)` and scrolls it into view. */
    select(from: number, to: number): void;
    /** Selection as `[anchor, caret]`. */
    selection(): [number, number];
    replaceSelection(text: string): Promise<void>;
    /** Shows a change made elsewhere, keeping the place. */
    applyResult(result: api.EditResult): Promise<void>;
  }

  interface Props {
    doc: api.DocInfo;
    /** The document's length, for progress, and version, for counting again. */
    docState: api.DocState;
    viewer: Target;
    /** What the editor last said of its caret: the selection may have moved. */
    caret?: { selected: number };
    /** Whether the replace row is open. */
    replacing?: boolean;
    /** What to find outlives the bar: the app keeps it. */
    needle: string;
    replacement: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
    preserveCase: boolean;
    /** Find in Selection: where it looks, in this document. */
    scope: [number, number] | null;
    ontogglescope: () => void;
    onclose: () => void;
  }

  let {
    doc,
    docState,
    viewer,
    caret,
    replacing = $bindable(false),
    needle = $bindable(),
    replacement = $bindable(),
    caseSensitive = $bindable(),
    wholeWord = $bindable(),
    regex = $bindable(),
    preserveCase = $bindable(),
    scope,
    ontogglescope,
    onclose,
  }: Props = $props();

  let bar: HTMLDivElement;
  let input: HTMLInputElement;
  let replaceInput = $state<HTMLInputElement>();
  let searching = $state(false);
  let searched = $state(0);
  /** What the last search or replace said. */
  let message = $state("");
  /** The last search went round the end, which the count shows once it is there. */
  let wrapped = $state(false);
  /** The last search found nothing. */
  let failed = $state(false);
  /** Why the needle cannot be searched for: a bad regular expression. */
  let problem = $state("");

  let query = $derived<api.Query>({
    needle,
    caseSensitive,
    wholeWord,
    regex,
    scope: scope ? [scope[0], scope[1]] : null,
  });
  let queryKey = $derived(JSON.stringify(query));

  // ---- Counting -----------------------------------------------------------
  // Again as the query, the text or the selection changes; the core keeps the
  // count, so only a new query or text reads the document again.

  let count = $state<api.MatchCount | null>(null);
  let countRead = $state(0);
  /** A count that takes long enough to show its progress. */
  let countSlow = $state(false);
  let countSeq = 0;

  // A message or a count is about the last search, in this tab. A scope
  // that only moved with an edit is the same search.
  let docId = $derived(doc.id);
  let searchKey = $derived(JSON.stringify([docId, needle, caseSensitive, wholeWord, regex, !!scope]));
  $effect(() => {
    void searchKey;
    message = "";
    wrapped = false;
    failed = false;
    problem = "";
    count = null;
  });
  let seq = 0;

  let percent = $derived(docState.len ? Math.min(100, Math.floor((searched / docState.len) * 100)) : 0);

  // After an edit the whole text is read again, so not while typing goes on.
  let countedVersion = -1;
  $effect(() => {
    const id = docId;
    const asked = JSON.parse(queryKey) as api.Query;
    const version = docState.version;
    void caret;
    if (!asked.needle) return;
    const edited = countedVersion >= 0 && version !== countedVersion;
    const timer = setTimeout(() => {
      countedVersion = version;
      recount(id, asked);
    }, edited ? 400 : 60);
    return () => clearTimeout(timer);
  });

  async function recount(id: number, asked: api.Query) {
    const mine = ++countSeq;
    countRead = 0;
    const slow = setTimeout(() => mine === countSeq && (countSlow = true), 300);
    try {
      const [anchor, at] = viewer.selection();
      const counted = await api.countMatches(id, asked, anchor, at, (n) => mine === countSeq && (countRead = n));
      // Null: a newer count stopped this one.
      if (mine === countSeq && counted) count = counted;
    } catch (e) {
      if (mine === countSeq) problem = describeError(e);
    } finally {
      clearTimeout(slow);
      if (mine === countSeq) countSlow = false;
    }
  }

  let countPercent = $derived(docState.len ? Math.min(100, Math.floor((countRead / docState.len) * 100)) : 0);

  let countText = $derived.by(() => {
    if (!needle || count?.total === 0) return t("find.noResults");
    if (countSlow) return t("find.counting", { percent: countPercent });
    if (!count) return "";
    return t("find.count", { index: count.index === null ? "?" : formatNumber(count.index), total: formatNumber(count.total) });
  });
  /** What the status says: the last message, else the count; going round the end is said until the count says it. */
  let said = $derived(message || (wrapped && !count ? t("find.wrapped") : countText));
  let nothing = $derived(!!needle && (failed || count?.total === 0 || !!problem));

  export function focus(field: "find" | "replace" = "find") {
    const target = field === "replace" && replaceInput ? replaceInput : input;
    target.focus();
    target.select();
  }

  /** Runs a search or replace; a newer one supersedes it. */
  async function track(work: (mine: number) => Promise<void>) {
    const mine = ++seq;
    searching = true;
    searched = 0;
    message = "";
    wrapped = false;
    failed = false;
    try {
      // From where the keys typed so far leave the text.
      await viewer.flush();
      await work(mine);
    } catch (e) {
      if (mine !== seq) return;
      // A bad pattern is said under the input already.
      if (isPatternError(e)) problem = describeError(e);
      else message = describeError(e);
    } finally {
      if (mine === seq) searching = false;
    }
  }

  const isPatternError = (e: unknown) => /^\{"code":"(badRegex|regexLineBreak|regexNotAscii)"/.test(String(e));

  const progress = (mine: number) => (n: number) => {
    if (mine === seq) searched = n;
  };

  /** Next match after the selection (the one before it with `backward`). */
  export async function run(backward: boolean) {
    if (!needle) return;
    await track(async (mine) => {
      const [anchor, at] = viewer.selection();
      const [start, end] = [Math.min(anchor, at), Math.max(anchor, at)];
      const result = await api.find(doc.id, query, anchor, at, backward, progress(mine));
      if (mine !== seq) return;
      if (result.kind === "found") {
        // Back where it was, or before it: round the end.
        wrapped = backward
          ? result.offset >= start
          : result.offset < start || (result.offset === start && result.len === end - start && end > start);
        viewer.select(result.offset, result.offset + result.len);
      } else if (result.kind === "notFound") {
        failed = true;
        message = t("find.noResults");
      }
    });
  }

  /** Replaces the selected match, then finds the next one. */
  async function replaceOne() {
    if (!needle) return;
    await viewer.flush();
    const [anchor, at] = viewer.selection();
    try {
      const text = await api.replacementFor(doc.id, query, replacement, preserveCase, anchor, at);
      // The search goes on from the caret, after the replacement, so it is never matched again.
      if (text !== null) await viewer.replaceSelection(text);
    } catch (e) {
      if (isPatternError(e)) problem = describeError(e);
      else message = describeError(e);
      return;
    }
    await run(false);
  }

  async function replaceAll() {
    if (!needle) return;
    await track(async (mine) => {
      const [anchor, at] = viewer.selection();
      const outcome = await api.replaceAll(doc.id, query, replacement, preserveCase, anchor, at, progress(mine));
      if (mine !== seq) return;
      if (outcome.kind === "cancelled") {
        message = t("find.cancelled");
        return;
      }
      message = outcome.count ? t("find.replaced", { count: formatNumber(outcome.count) }) : t("find.noResults");
      failed = !outcome.count;
      if (outcome.result) await viewer.applyResult(outcome.result);
    });
  }

  function cancel() {
    seq++;
    searching = false;
    message = t("find.cancelled");
    api.cancelFind(doc.id);
  }

  export function close() {
    if (searching) cancel();
    countSeq++;
    api.cancelFind(doc.id);
    onclose();
  }

  function findKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    run(e.shiftKey);
  }

  function replaceKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.altKey) replaceAll();
    else replaceOne();
  }

  /** In the bar: Escape cancels a search, then closes; Alt+C matches case, as in VS Code (in the text it is column mode). */
  function onkeydown(e: KeyboardEvent) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyC") {
      e.preventDefault();
      caseSensitive = !caseSensitive;
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (searching) cancel();
    else close();
  }

  onMount(() => {
    bar.addEventListener("keydown", onkeydown);
    return () => bar.removeEventListener("keydown", onkeydown);
  });

  /** Where the bar is on screen, for the editor to keep a found match clear of it. */
  export function box() {
    return bar.getBoundingClientRect();
  }
</script>

<div class="findbar" class:replacing role="search" bind:this={bar}>
  <button
    class="toggle"
    title={t("find.toggleReplace")}
    aria-label={t("find.toggleReplace")}
    aria-expanded={replacing}
    onclick={() => (replacing = !replacing)}
  >
    <svg class:open={replacing} viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
  </button>
  <div class="rows">
    <div class="field" class:nothing>
      <input bind:this={input} bind:value={needle} placeholder={t("find.find")} spellcheck="false" onkeydown={findKeydown} />
      <button class="option" class:on={caseSensitive} title={t("find.matchCase")} aria-pressed={caseSensitive} onclick={() => (caseSensitive = !caseSensitive)}>Aa</button>
      <button class="option word" class:on={wholeWord} title={t("find.wholeWord")} aria-pressed={wholeWord} onclick={() => (wholeWord = !wholeWord)}>ab</button>
      <button class="option" class:on={regex} title={t("find.regex")} aria-pressed={regex} onclick={() => (regex = !regex)}>.*</button>
      {#if problem}
        <div class="problem" role="alert">{problem}</div>
      {/if}
    </div>
    <div class="controls">
      <span class="status" class:nothing title={searching ? "" : said}>
        {#if searching}
          {t("find.searching", { percent })}
          <button class="cancel" onclick={cancel}>{t("find.cancel")}</button>
        {:else}
          {said}
        {/if}
      </span>
      <button class="icon" title={t("find.previous")} aria-label={t("find.previous")} onclick={() => run(true)}>
        <svg viewBox="0 0 16 16"><path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" /></svg>
      </button>
      <button class="icon" title={t("find.next")} aria-label={t("find.next")} onclick={() => run(false)}>
        <svg viewBox="0 0 16 16"><path d="M8 3v9.5M3.5 8 8 12.5 12.5 8" /></svg>
      </button>
      <button
        class="icon"
        class:on={!!scope}
        title={t("find.inSelection")}
        aria-label={t("find.inSelection")}
        aria-pressed={!!scope}
        disabled={!scope && !caret?.selected}
        onclick={ontogglescope}
      >
        <svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" /></svg>
      </button>
      <button class="icon" title={t("find.close")} aria-label={t("find.close")} onclick={close}>
        <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </div>
    {#if replacing}
      <div class="field">
        <input bind:this={replaceInput} bind:value={replacement} placeholder={t("find.replace")} spellcheck="false" onkeydown={replaceKeydown} />
        <button class="option" class:on={preserveCase} title={t("find.preserveCase")} aria-pressed={preserveCase} onclick={() => (preserveCase = !preserveCase)}>AB</button>
      </div>
      <div class="controls">
        <button class="icon" title={t("find.replaceOneTitle")} aria-label={t("find.replaceOne")} onclick={replaceOne}>
          <svg viewBox="0 0 16 16">
            <path d="M3 7.5V5a2 2 0 0 1 2-2h2.5M1.5 6l1.5 1.5L4.5 6" />
            <rect x="1.5" y="9" width="6.5" height="5.5" rx="1" />
            <text x="4.75" y="13.2">c</text>
            <text class="small" x="11.5" y="7.5">b</text>
          </svg>
        </button>
        <button class="icon" title={t("find.replaceAllTitle")} aria-label={t("find.replaceAll")} onclick={replaceAll}>
          <svg viewBox="0 0 16 16">
            <path d="M3 7.5V5a2 2 0 0 1 2-2h1.5M1.5 6l1.5 1.5L4.5 6" />
            <rect x="1.5" y="9" width="11" height="5.5" rx="1" />
            <text x="7" y="13.2">ac</text>
            <text class="small" x="11" y="6.5">ab</text>
          </svg>
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Over the text at the top right, like VS Code's; a match found under it is
     scrolled clear (see the editor's `select`). */
  .findbar {
    position: absolute;
    top: 8px;
    right: 18px;
    z-index: 10;
    display: flex;
    gap: 3px;
    width: 440px;
    max-width: calc(100% - 30px);
    box-sizing: border-box;
    padding: 4px 6px 4px 3px;
    background: var(--panel);
    border: 1px solid #454545;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
    font-size: 13px;
  }
  .rows {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(80px, 1fr) auto;
    gap: 4px 3px;
    align-items: center;
    min-width: 0;
  }
  .field {
    position: relative;
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
  .option.on {
    border-color: var(--accent);
    background: rgba(36, 137, 219, 0.51);
    color: #fff;
  }
  /* VS Code's mark for a whole word: a bar under it. */
  .word {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 1px;
    min-width: 0;
  }
  .status {
    flex: none;
    min-width: 69px;
    max-width: 140px;
    overflow: hidden;
    padding: 0 4px 0 2px;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.nothing {
    color: #f48771;
  }
  .cancel {
    padding: 0 4px;
    border: none;
    background: transparent;
    color: #3794ff;
    font-size: 12px;
  }
  .icon,
  .toggle {
    display: grid;
    flex: none;
    place-items: center;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg);
  }
  .icon {
    width: 22px;
    height: 22px;
  }
  .icon:hover:not(:disabled),
  .toggle:hover {
    background: rgba(90, 93, 94, 0.5);
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .icon.on {
    background: rgba(36, 137, 219, 0.51);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .toggle {
    align-self: stretch;
    width: 18px;
    color: var(--muted);
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
  .toggle svg {
    width: 14px;
    height: 14px;
    stroke-width: 1.4;
    transition: transform 0.1s;
  }
  .toggle svg.open {
    transform: rotate(90deg);
  }
  /* Under the input, over what is below, as VS Code shows a bad pattern. */
  .problem {
    position: absolute;
    top: calc(100% + 1px);
    left: -1px;
    right: -1px;
    z-index: 1;
    padding: 4px 6px;
    border: 1px solid #be1100;
    background: #5a1d1d;
    color: #fff;
    font-size: 12px;
    white-space: normal;
  }
</style>
