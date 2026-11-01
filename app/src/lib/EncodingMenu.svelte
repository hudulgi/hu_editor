<script lang="ts" module>
  import type { Encoding } from "./api";

  export const ENCODING_LABEL: Record<Encoding, string> = {
    utf8: "UTF-8",
    cp949: "CP949",
    shiftJis: "Shift-JIS",
    gbk: "GBK",
    big5: "Big5",
    windows1252: "Windows-1252",
  };

  const ENCODINGS: [Encoding, string][] = [
    ["utf8", "Unicode"],
    ["cp949", "Korean"],
    ["shiftJis", "Japanese"],
    ["gbk", "Simplified Chinese"],
    ["big5", "Traditional Chinese"],
    ["windows1252", "Western"],
  ];
</script>

<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    current: Encoding;
    /** The user chose `current`, rather than it being detected. */
    chosen: boolean;
    dirty: boolean;
    /** Read the file in this encoding, or the one detected. */
    onread: (encoding: Encoding | null) => void;
    /** Save the file converted to this encoding. */
    onsave: (encoding: Encoding) => void;
    onclose: () => void;
  }

  let { current, chosen, dirty, onread, onsave, onclose }: Props = $props();

  let mode = $state<"read" | "save">("read");
  let panel: HTMLDivElement;

  const items = () => [...panel.querySelectorAll<HTMLButtonElement>("button.item:not(:disabled)")];

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onclose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else {
      return;
    }
    e.preventDefault();
  }

  onMount(() => (panel.querySelector<HTMLElement>("button.current") ?? items()[0])?.focus());
</script>

<svelte:window {onkeydown} />

<div class="scrim" role="presentation" onmousedown={onclose}></div>
<div class="menu" bind:this={panel}>
  <div class="modes">
    <button class:on={mode === "read"} onclick={() => (mode = "read")}>Read as</button>
    <button class:on={mode === "save"} onclick={() => (mode = "save")}>Save as</button>
  </div>
  {#if mode === "read"}
    <p class:warn={dirty}>
      {dirty
        ? "Save or undo your changes first: they are in the current encoding."
        : "Shows the file's bytes in another encoding. The file does not change."}
    </p>
    <button class="item" class:current={!chosen} disabled={dirty} onclick={() => onread(null)}>
      <span class="check">{chosen ? "" : "✓"}</span>Auto-detect<span class="hint"
        >{chosen ? "" : ENCODING_LABEL[current]}</span
      >
    </button>
    {#each ENCODINGS as [encoding, hint] (encoding)}
      {@const selected = chosen && encoding === current}
      <button
        class="item"
        class:current={selected}
        disabled={dirty && encoding !== current}
        onclick={() => onread(encoding)}
      >
        <span class="check">{selected ? "✓" : ""}</span>{ENCODING_LABEL[encoding]}<span class="hint">{hint}</span>
      </button>
    {/each}
  {:else}
    <p>Converts the text and saves the file. A character the encoding lacks stops it, and undo history is cleared.</p>
    {#each ENCODINGS as [encoding, hint] (encoding)}
      <button class="item" class:current={encoding === current} onclick={() => onsave(encoding)}>
        <span class="check">{encoding === current ? "✓" : ""}</span>{ENCODING_LABEL[encoding]}<span class="hint"
          >{hint}</span
        >
      </button>
    {/each}
  {/if}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 49;
  }
  .menu {
    position: fixed;
    right: 90px;
    bottom: 28px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: 300px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    font-size: 13px;
  }
  .modes {
    display: flex;
    gap: 4px;
  }
  .modes button {
    flex: 1;
  }
  .modes button.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  p {
    margin: 8px 4px;
    color: var(--muted);
    font-size: 12px;
  }
  p.warn {
    color: #e2c08d;
  }
  .item {
    display: flex;
    align-items: center;
    padding: 4px;
    border: none;
    background: transparent;
    text-align: left;
  }
  .item:hover:not(:disabled),
  .item:focus {
    outline: none;
    background: rgba(255, 255, 255, 0.1);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .check {
    flex: none;
    width: 20px;
    text-align: center;
  }
  .hint {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
  }
</style>
