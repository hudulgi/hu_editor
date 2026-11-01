<script lang="ts">
  import { onMount } from "svelte";
  import type { Encoding } from "./api";
  import { ENCODING_LABEL, ENCODINGS } from "./encodings";
  import { t } from "./i18n";

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
    <button class:on={mode === "read"} onclick={() => (mode = "read")}>{t("encoding.readAs")}</button>
    <button class:on={mode === "save"} onclick={() => (mode = "save")}>{t("encoding.saveAs")}</button>
  </div>
  {#if mode === "read"}
    <p class:warn={dirty}>
      {t(dirty ? "encoding.readBlocked" : "encoding.readHint")}
    </p>
    <button class="item" class:current={!chosen} disabled={dirty} onclick={() => onread(null)}>
      <span class="check">{chosen ? "" : "✓"}</span>{t("encoding.auto")}<span class="hint"
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
        <span class="check">{selected ? "✓" : ""}</span>{ENCODING_LABEL[encoding]}<span class="hint">{t(hint)}</span>
      </button>
    {/each}
  {:else}
    <p>{t("encoding.saveHint")}</p>
    {#each ENCODINGS as [encoding, hint] (encoding)}
      <button class="item" class:current={encoding === current} onclick={() => onsave(encoding)}>
        <span class="check">{encoding === current ? "✓" : ""}</span>{ENCODING_LABEL[encoding]}<span class="hint">{t(hint)}</span>
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
