<script lang="ts" module>
  export type Category = "general" | "editor" | "files" | "shortcuts";
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ENCODING_LABEL, ENCODINGS } from "./encodings";
  import { t, type MessageKey } from "./i18n";
  import { clampFontSize, clampTabSize, resetSettings, settings } from "./settings.svelte";
  import { LANG_LABEL } from "./syntax";

  interface Props {
    /** The page to open on. */
    initial?: Category;
    onclose: () => void;
  }

  let { initial = "general", onclose }: Props = $props();

  const CATEGORIES: [Category, MessageKey][] = [
    ["general", "settings.general"],
    ["editor", "settings.editor"],
    ["files", "settings.files"],
    ["shortcuts", "settings.shortcuts"],
  ];
  const FONTS = ["Cascadia Mono", "Consolas", "D2Coding", "Courier New", "Lucida Console", "JetBrains Mono"];

  let category = $state<Category>(untrack(() => initial));
  let panel: HTMLElement;

  let shortcuts = $derived<[string, string][]>([
    ["Alt+F, E, S, V, H / F10", t("shortcut.menu")],
    ["Ctrl+N", t("shortcut.new")],
    ["Ctrl+O", t("shortcut.open")],
    ["Ctrl+S", t("shortcut.save")],
    ["Ctrl+Shift+S", t("shortcut.saveAs")],
    ["Ctrl+W", t("shortcut.closeTab")],
    ["Ctrl+K W", t("shortcut.closeAll")],
    ["Ctrl+K U", t("shortcut.closeSaved")],
    ["Ctrl+Tab, Ctrl+Shift+Tab", t("shortcut.nextTab")],
    ["Ctrl+B", t("shortcut.explorer")],
    ["Ctrl+,", t("shortcut.settings")],
    ["Ctrl+Z, Ctrl+Y", t("shortcut.undo")],
    ["Ctrl+C, Ctrl+X, Ctrl+V", t("shortcut.clipboard")],
    ["Ctrl+A", t("shortcut.selectAll")],
    ["Ctrl+F, F3, Shift+F3", t("shortcut.find")],
    ["Ctrl+F3, Ctrl+Shift+F3", t("shortcut.findSelection")],
    ["Ctrl+H", t("shortcut.replace")],
    ["Ctrl+Alt+Enter", t("shortcut.replaceAll")],
    ["Ctrl+\\", t("shortcut.split")],
    ["Ctrl+1 … Ctrl+9", t("shortcut.focusPane")],
    ["Ctrl+Alt+←, Ctrl+Alt+→", t("shortcut.moveTab")],
    ["Shift+Alt+0", t("menu.flipLayout")],
    ["Ctrl+G", t("shortcut.goto")],
    [t("shortcut.boxKeys"), t("shortcut.box")],
    ["Alt+C", t("shortcut.columnMode")],
    ["Ctrl+Home, Ctrl+End", t("shortcut.documentEnds")],
  ]);

  // The dialog is modal: focus stays in it, away from the editor's input.
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "Tab") {
      const items = [...panel.querySelectorAll<HTMLElement>("button, input, select")].filter(
        (item) => !(item as HTMLInputElement).disabled,
      );
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (at !== -1 && at !== (e.shiftKey ? 0 : items.length - 1)) return;
      e.preventDefault();
      items[e.shiftKey ? items.length - 1 : 0]?.focus();
    }
  }

  onMount(() => panel.querySelector<HTMLElement>("nav button")?.focus());
</script>

<svelte:window {onkeydown} />

{#snippet number(value: number, low: number, high: number, clamp: (value: number) => number, set: (value: number) => void, disabled = false)}
  <input
    type="number"
    min={low}
    max={high}
    {value}
    {disabled}
    oninput={(e) => {
      // Half-typed values wait for the end of typing.
      const typed = e.currentTarget.valueAsNumber;
      if (Number.isInteger(typed) && typed >= low && typed <= high) set(typed);
    }}
    onchange={(e) => {
      const usable = clamp(e.currentTarget.valueAsNumber);
      set(usable);
      e.currentTarget.value = String(usable);
    }}
  />
{/snippet}

{#snippet check(label: string, value: boolean, set: (value: boolean) => void)}
  <label class="check">
    <input type="checkbox" checked={value} onchange={(e) => set(e.currentTarget.checked)} />
    {label}
  </label>
{/snippet}

<div class="backdrop" role="presentation">
  <div class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" bind:this={panel}>
    <h1 id="settings-title">{t("settings.title")}</h1>
    <nav>
      {#each CATEGORIES as [id, label] (id)}
        <button class:on={category === id} onclick={() => (category = id)}>{t(label)}</button>
      {/each}
    </nav>
    <div class="page">
      {#if category === "general"}
        <label class="field">
          <span>{t("settings.language")}</span>
          <select bind:value={settings.language}>
            <option value="en">English</option>
            <option value="ko">한국어</option>
          </select>
        </label>
        {@render check(t("settings.restoreSession"), settings.restoreSession, (on) => (settings.restoreSession = on))}
        {@render check(t("settings.showHidden"), settings.showHidden, (on) => (settings.showHidden = on))}
      {:else if category === "editor"}
        <label class="field">
          <span>{t("settings.fontFamily")}</span>
          <input
            class="wide"
            list="settings-fonts"
            placeholder={t("settings.fontDefault")}
            spellcheck="false"
            bind:value={settings.fontFamily}
          />
          <datalist id="settings-fonts">
            {#each FONTS as font (font)}
              <option value={font}></option>
            {/each}
          </datalist>
        </label>
        <p class="hint">{t("settings.fontHint")}</p>
        <label class="field">
          <span>{t("settings.fontSize")}</span>
          {@render number(settings.fontSize, 8, 32, clampFontSize, (size) => (settings.fontSize = size))}
        </label>
        {@render check(t("settings.lineNumbers"), settings.lineNumbers, (on) => (settings.lineNumbers = on))}
        {@render check(t("settings.highlightLine"), settings.highlightLine, (on) => (settings.highlightLine = on))}
        {@render check(t("settings.previewEditors"), settings.previewEditors, (on) => (settings.previewEditors = on))}
        <label class="field">
          <span>{t("settings.tabKey")}</span>
          <select
            value={settings.tabSpaces ? "spaces" : "tab"}
            onchange={(e) => (settings.tabSpaces = e.currentTarget.value === "spaces")}
          >
            <option value="spaces">{t("settings.tabSpaces")}</option>
            <option value="tab">{t("settings.tabCharacter")}</option>
          </select>
        </label>
        <label class="field">
          <span>{t("settings.tabSize")}</span>
          {@render number(settings.tabSize, 1, 16, clampTabSize, (size) => (settings.tabSize = size), !settings.tabSpaces)}
        </label>
        <p class="hint">{t("settings.tabSizeHint")}</p>
        {@render check(t("settings.syntaxHighlight"), settings.syntaxHighlight, (on) => (settings.syntaxHighlight = on))}
        {@render check(t("settings.fieldShading"), settings.fieldShading, (on) => (settings.fieldShading = on))}
      {:else if category === "files"}
        <label class="field">
          <span>{t("settings.newFileEncoding")}</span>
          <select bind:value={settings.newFileEncoding}>
            {#each ENCODINGS as [encoding, hint] (encoding)}
              <option value={encoding}>{ENCODING_LABEL[encoding]} ({t(hint)})</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>{t("settings.newFileEol")}</span>
          <select bind:value={settings.newFileEol}>
            <option value="os">{t("settings.eolOs")}</option>
            <option value="crlf">CRLF</option>
            <option value="lf">LF</option>
          </select>
        </label>
        <label class="field">
          <span>{t("settings.fallbackEncoding")}</span>
          <select bind:value={settings.fallbackEncoding}>
            {#each ENCODINGS.filter(([encoding]) => encoding !== "utf8") as [encoding, hint] (encoding)}
              <option value={encoding}>{ENCODING_LABEL[encoding]} ({t(hint)})</option>
            {/each}
          </select>
        </label>
        <p class="hint">{t("settings.fallbackHint")}</p>
        <label class="field">
          <span>{t("settings.blkDefault")}</span>
          <select bind:value={settings.blkDefault}>
            <option value="nastran">{LANG_LABEL.nastran}</option>
            <option value="abaqus">{LANG_LABEL.abaqus}</option>
          </select>
        </label>
      {:else}
        <table>
          <tbody>
            {#each shortcuts as [keys, what] (keys)}
              <tr>
                <td class="keys">{keys}</td>
                <td>{what}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
    <footer>
      <button onclick={resetSettings}>{t("settings.reset")}</button>
      <button class="primary" onclick={onclose}>{t("settings.close")}</button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .settings {
    display: grid;
    grid-template: auto minmax(0, 1fr) auto / 150px minmax(0, 1fr);
    width: 680px;
    max-width: 92vw;
    height: 520px;
    max-height: 92vh;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  h1 {
    grid-column: 1 / -1;
    margin: 0;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
    font-weight: 600;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-right: 1px solid var(--border);
  }
  nav button {
    padding: 5px 10px;
    border: none;
    background: transparent;
    text-align: left;
  }
  nav button:hover {
    background: #2a2d2e;
  }
  nav button.on {
    background: #37373d;
  }
  .page {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 18px;
    overflow-y: auto;
  }
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .field input,
  .field select {
    flex: none;
    box-sizing: border-box;
    width: 200px;
  }
  .field input[type="number"] {
    width: 72px;
  }
  .field input:disabled {
    opacity: 0.5;
  }
  .field input.wide {
    width: 240px;
  }
  select {
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #3c3c3c;
    color: inherit;
    font: inherit;
    outline: none;
  }
  select:focus {
    border-color: var(--accent);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .check input {
    margin: 0;
    accent-color: var(--accent);
  }
  .hint {
    margin: -6px 0 2px;
    color: var(--muted);
    font-size: 12px;
  }
  table {
    border-collapse: collapse;
  }
  td {
    padding: 3px 12px 3px 0;
    vertical-align: top;
  }
  .keys {
    color: var(--muted);
    font-family: var(--ui);
    white-space: nowrap;
  }
  footer {
    display: flex;
    grid-column: 1 / -1;
    justify-content: space-between;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
