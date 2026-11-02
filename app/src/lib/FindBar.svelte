<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";
  import { formatNumber } from "./format";
  import { describeError, t } from "./i18n";
  import { isMatch } from "./syntax";

  interface Target {
    /** Selects `[from, to)` and scrolls it into view. */
    select(from: number, to: number): void;
    /** Selection as `[anchor, caret]`. */
    selection(): [number, number];
    /** The selected text if it lies on one visible line. */
    selectedText(): string | null;
    replaceSelection(text: string): Promise<void>;
    /** Shows a change made elsewhere, keeping the place. */
    applyResult(result: api.EditResult): Promise<void>;
  }

  interface Props {
    doc: api.DocInfo;
    /** Document length, for progress. */
    len: number;
    viewer: Target;
    /** Whether the replace row is open. */
    replacing?: boolean;
    /** What to find outlives the bar: the app keeps it. */
    needle: string;
    replacement: string;
    caseSensitive: boolean;
    onclose: () => void;
  }

  let {
    doc,
    len,
    viewer,
    replacing = $bindable(false),
    needle = $bindable(),
    replacement = $bindable(),
    caseSensitive = $bindable(),
    onclose,
  }: Props = $props();

  let bar: HTMLDivElement;
  let input: HTMLInputElement;
  let replaceInput = $state<HTMLInputElement>();
  let searching = $state(false);
  let searched = $state(0);
  let message = $state("");

  // A message is about the last search, in this tab.
  let docId = $derived(doc.id);
  $effect(() => {
    void docId;
    void needle;
    void caseSensitive;
    message = "";
  });
  let seq = 0;

  let percent = $derived(len ? Math.min(100, Math.floor((searched / len) * 100)) : 0);

  export function focus(field: "find" | "replace" = "find") {
    const target = field === "replace" && replaceInput ? replaceInput : input;
    target.focus();
    target.select();
  }

  /** The selection is a match already: found before, or selected by hand. */
  function onMatch() {
    const text = viewer.selectedText();
    return text !== null && isMatch(text, needle, caseSensitive);
  }

  /** Runs a search or replace; a newer one supersedes it. */
  async function track(work: (mine: number) => Promise<void>) {
    const mine = ++seq;
    searching = true;
    searched = 0;
    message = "";
    try {
      await work(mine);
    } catch (e) {
      if (mine === seq) message = describeError(e);
    } finally {
      if (mine === seq) searching = false;
    }
  }

  const progress = (mine: number) => (n: number) => {
    if (mine === seq) searched = n;
  };

  /** Next match (previous with `backward`) from the selection or the caret. */
  export async function run(backward: boolean) {
    if (!needle) return;
    const [anchor, caret] = viewer.selection();
    const start = Math.min(anchor, caret);
    const from = backward ? start : onMatch() ? start + 1 : caret;
    await track(async (mine) => {
      const result = await api.find(doc.id, needle, from, caseSensitive, backward, progress(mine));
      if (mine !== seq) return;
      if (result.kind === "found") {
        const wrapped = backward ? result.offset >= from : result.offset < from;
        message = wrapped ? t("find.wrapped") : "";
        viewer.select(result.offset, result.offset + result.len);
      } else if (result.kind === "notFound") {
        message = t("find.noResults");
      }
    });
  }

  /** Replaces the selected match, then finds the next one. */
  async function replaceOne() {
    if (!needle) return;
    // The search goes on from the caret, after the replacement, so it is never matched again.
    if (onMatch()) await viewer.replaceSelection(replacement);
    await run(false);
  }

  async function replaceAll() {
    if (!needle) return;
    const [anchor, caret] = viewer.selection();
    await track(async (mine) => {
      const outcome = await api.replaceAll(doc.id, needle, replacement, caseSensitive, anchor, caret, progress(mine));
      if (mine !== seq) return;
      if (outcome.kind === "cancelled") {
        message = t("find.cancelled");
        return;
      }
      message = outcome.count ? t("find.replaced", { count: formatNumber(outcome.count) }) : t("find.noResults");
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

  /** Escape anywhere in the bar (inputs or buttons) cancels a search, then closes. */
  function onkeydown(e: KeyboardEvent) {
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
</script>

<div class="findbar" role="search" bind:this={bar}>
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
    <div class="row">
      <input bind:this={input} bind:value={needle} placeholder={t("find.find")} spellcheck="false" onkeydown={findKeydown} />
      <button class:on={caseSensitive} title={t("find.matchCase")} onclick={() => (caseSensitive = !caseSensitive)}
        >Aa</button
      >
      <button title={t("find.previous")} onclick={() => run(true)}>↑</button>
      <button title={t("find.next")} onclick={() => run(false)}>↓</button>
      <span class="status">
        {#if searching}
          {t("find.searching", { percent })}
          <button onclick={cancel}>{t("find.cancel")}</button>
        {:else}
          {message}
        {/if}
      </span>
      <button title={t("find.close")} onclick={close}>✕</button>
    </div>
    {#if replacing}
      <div class="row">
        <input bind:this={replaceInput} bind:value={replacement} placeholder={t("find.replace")} spellcheck="false" onkeydown={replaceKeydown} />
        <button title={t("find.replaceOneTitle")} onclick={replaceOne}>{t("find.replaceOne")}</button>
        <button title={t("find.replaceAllTitle")} onclick={replaceAll}>{t("find.replaceAll")}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .findbar {
    position: absolute;
    top: 0;
    right: 28px;
    z-index: 10;
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 6px 8px 6px 4px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 6px 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  input {
    width: 260px;
  }
  .toggle {
    display: grid;
    place-items: center;
    width: 20px;
    height: 24px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--muted);
  }
  .toggle svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    transition: transform 0.1s;
  }
  .toggle svg.open {
    transform: rotate(90deg);
  }
  .status {
    min-width: 120px;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  button.on {
    background: var(--accent);
    color: #fff;
  }
</style>
