<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./api";

  interface Target {
    /** Selects `[from, to)` and scrolls it into view. */
    select(from: number, to: number): void;
    caretOffset(): number;
  }

  interface Props {
    doc: api.DocInfo;
    /** Document length, for progress. */
    len: number;
    viewer: Target;
    onclose: () => void;
  }

  let { doc, len, viewer, onclose }: Props = $props();

  let input: HTMLInputElement;
  let needle = $state("");
  let caseSensitive = $state(false);
  let searching = $state(false);
  let searched = $state(0);
  let message = $state("");
  let last: { offset: number; needle: string; caseSensitive: boolean } | null = null;
  let seq = 0;

  let percent = $derived(len ? Math.min(100, Math.floor((searched / len) * 100)) : 0);

  export function focus() {
    input.focus();
    input.select();
  }

  /** Next match (previous with `backward`), continuing from the last match. */
  export async function run(backward: boolean) {
    if (!needle) return;
    const again = last && last.needle === needle && last.caseSensitive === caseSensitive;
    const from = again ? (backward ? last!.offset : last!.offset + 1) : viewer.caretOffset();
    const mine = ++seq;
    searching = true;
    searched = 0;
    message = "";
    try {
      const result = await api.find(doc.id, needle, from, caseSensitive, backward, (n) => {
        if (mine === seq) searched = n;
      });
      if (mine !== seq) return;
      if (result.kind === "found") {
        last = { offset: result.offset, needle, caseSensitive };
        const wrapped = backward ? result.offset >= from : result.offset < from;
        message = wrapped ? "Wrapped around" : "";
        viewer.select(result.offset, result.offset + result.len);
      } else if (result.kind === "notFound") {
        last = null;
        message = "No results";
      }
    } catch (e) {
      if (mine === seq) message = String(e);
    } finally {
      if (mine === seq) searching = false;
    }
  }

  function cancel() {
    seq++;
    searching = false;
    message = "Cancelled";
    api.cancelFind(doc.id);
  }

  function close() {
    if (searching) cancel();
    onclose();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter") run(e.shiftKey);
    else if (e.key === "Escape") searching ? cancel() : close();
    else return;
    e.preventDefault();
  }

  onMount(focus);
</script>

<div class="findbar">
  <input bind:this={input} bind:value={needle} placeholder="Find" spellcheck="false" {onkeydown} />
  <button class:on={caseSensitive} title="Match case" onclick={() => (caseSensitive = !caseSensitive)}
    >Aa</button
  >
  <button title="Previous match (Shift+Enter, Shift+F3)" onclick={() => run(true)}>↑</button>
  <button title="Next match (Enter, F3)" onclick={() => run(false)}>↓</button>
  <span class="status">
    {#if searching}
      Searching… {percent}%
      <button onclick={cancel}>Cancel</button>
    {:else}
      {message}
    {/if}
  </span>
  <button title="Close (Esc)" onclick={close}>✕</button>
</div>

<style>
  .findbar {
    position: absolute;
    top: 0;
    right: 28px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 6px 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  input {
    width: 260px;
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
