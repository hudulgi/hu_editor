<script lang="ts" module>
  export type Category = "general" | "editor" | "files" | "shortcuts";
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ENCODING_LABEL, ENCODINGS } from "./encodings";
  import { t, type MessageKey } from "./i18n";
  import { clampFontSize, clampTabSize, defaults, settings, type Settings } from "./settings.svelte";
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
  /** Monospaced fonts to offer, of those this machine has. */
  const FONTS = [
    "Cascadia Mono",
    "Cascadia Code",
    "Consolas",
    "D2Coding",
    "NanumGothicCoding",
    "JetBrains Mono",
    "Fira Code",
    "Source Code Pro",
    "Ubuntu Mono",
    "DejaVu Sans Mono",
    "Noto Sans Mono",
    "Lucida Console",
    "Courier New",
    "SF Mono",
    "Menlo",
    "Monaco",
  ];

  /** Whether a font is installed: text in it measures unlike the fallbacks. */
  function installed(name: string) {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return true;
    const sample = "mmmmmmmmmmlli10OoWW@#";
    return ["monospace", "serif", "sans-serif"].some((base) => {
      context.font = `20px ${base}`;
      const fallback = context.measureText(sample).width;
      context.font = `20px "${name}", ${base}`;
      return context.measureText(sample).width !== fallback;
    });
  }

  const fonts = FONTS.filter(installed);

  // The font box is a combo box, as Windows has it: typed into, or picked from
  // a list that always shows every font, whatever is typed.
  let fontsOpen = $state(false);
  /** The item marked in the list: 0 is the default. */
  let fontAt = $state(0);
  let fontList = $state<HTMLElement>();

  function openFonts() {
    fontAt = Math.max(0, fonts.indexOf(draft.fontFamily.trim()) + 1);
    fontsOpen = true;
  }

  function pickFont(at: number) {
    draft.fontFamily = at === 0 ? "" : fonts[at - 1];
    fontsOpen = false;
  }

  async function markFont(at: number) {
    fontAt = (at + fonts.length + 1) % (fonts.length + 1);
    await Promise.resolve();
    fontList?.children[fontAt]?.scrollIntoView({ block: "nearest" });
  }

  function fontKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!fontsOpen) openFonts();
      else markFont(fontAt + (e.key === "ArrowDown" ? 1 : -1));
    } else if (fontsOpen && (e.key === "Enter" || e.key === "Escape")) {
      // The list's, not the dialog's: Enter picks, Esc closes only the list.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter") pickFont(fontAt);
      else fontsOpen = false;
    }
  }

  let category = $state<Category>(untrack(() => initial));
  let panel: HTMLElement;

  // What is changed here goes to the settings only with Apply or OK, as in a
  // Windows dialog; Cancel, Esc and Ctrl+, leave them as they were. Only what
  // was changed here goes: another window may have changed the rest.
  const KEYS = Object.keys(defaults()) as (keyof Settings)[];
  let base = $state.raw<Settings>($state.snapshot(settings));
  let draft = $state<Settings>($state.snapshot(settings));
  let pending = $derived(KEYS.some((key) => draft[key] !== base[key]));

  /** Apply: what was changed here, and the dialog stays. */
  export function apply() {
    for (const key of KEYS) if (draft[key] !== base[key]) Object.assign(settings, { [key]: draft[key] });
    base = $state.snapshot(settings);
    draft = $state.snapshot(settings);
  }

  /** OK: applies and closes. */
  export function confirm() {
    apply();
    onclose();
  }

  /** Reset to Defaults: into the dialog, for Apply or OK to take. */
  function reset() {
    Object.assign(draft, defaults());
  }

  let shortcuts = $derived<[string, [string, string][]][]>([
    [
      t("menu.file"),
      [
        ["Ctrl+N", t("shortcut.new")],
        ["Ctrl+Shift+N", t("menu.newWindow")],
        ["Ctrl+O", t("shortcut.open")],
        ["Ctrl+R", t("shortcut.recent")],
        ["Ctrl+Shift+T", t("menu.reopenClosed")],
        ["Ctrl+S", t("shortcut.save")],
        ["Ctrl+Shift+S", t("shortcut.saveAs")],
        ["Ctrl+K S", t("menu.saveAll")],
        ["Ctrl+W", t("shortcut.closeTab")],
        ["Ctrl+Shift+W", t("menu.closeWindow")],
        ["Ctrl+K W", t("shortcut.closeAll")],
        ["Ctrl+K U", t("shortcut.closeSaved")],
        ["Ctrl+Alt+T", t("shortcut.closeOthers")],
        ["Ctrl+K Enter", t("shortcut.keepOpen")],
        ["Ctrl+K Shift+Enter", t("shortcut.pin")],
        ["Ctrl+K O", t("shortcut.copyToWindow")],
        ["Ctrl+,", t("shortcut.settings")],
      ],
    ],
    [
      t("menu.edit"),
      [
        ["Ctrl+Z, Ctrl+Y", t("shortcut.undo")],
        ["Ctrl+C, Ctrl+X, Ctrl+V", t("shortcut.clipboard")],
        ["Ctrl+/", t("menu.lineComment")],
        ["Shift+Alt+A", t("menu.blockComment")],
      ],
    ],
    [
      t("menu.selection"),
      [
        ["Ctrl+A", t("shortcut.selectAll")],
        ["Ctrl+Shift+Alt+→, ←", t("shortcut.expand")],
        ["Ctrl+Shift+Alt+↑, ↓", t("shortcut.copyLines")],
        ["Alt+↑, Alt+↓", t("shortcut.moveLines")],
        ["Ctrl+D", t("menu.duplicate")],
        ["Ctrl+Alt+↑, ↓", t("shortcut.addCursor")],
        [t("shortcut.boxKeys"), t("shortcut.box")],
        ["Alt+C", t("shortcut.columnMode")],
        ["Ctrl+Home, Ctrl+End", t("shortcut.documentEnds")],
      ],
    ],
    [
      t("menu.search"),
      [
        ["Ctrl+F, F3, Shift+F3", t("shortcut.find")],
        ["Ctrl+F3, Ctrl+Shift+F3", t("shortcut.findSelection")],
        ["Ctrl+H", t("shortcut.replace")],
        ["Ctrl+Alt+Enter", t("shortcut.replaceAll")],
        ["Ctrl+F2", t("shortcut.changeAll")],
        ["Alt+C, W, R, P, L", t("shortcut.findToggles")],
        ["Ctrl+Shift+F, Ctrl+Shift+H", t("shortcut.inFiles")],
        ["Ctrl+G", t("shortcut.goto")],
      ],
    ],
    [
      t("menu.view"),
      [
        ["Alt+F, E, T, S, V, H / F10", t("shortcut.menu")],
        ["Ctrl+Shift+P, F1", t("shortcut.palette")],
        ["Ctrl+B", t("shortcut.explorer")],
        ["Ctrl+Shift+V", t("menu.openPreview")],
        ["Ctrl+K V", t("menu.previewToSide")],
        ["Ctrl+Shift+E", t("shortcut.explorerView")],
        ["Ctrl+Tab, Ctrl+Shift+Tab", t("shortcut.nextTab")],
        ["Ctrl+\\", t("shortcut.split")],
        ["Ctrl+1 … Ctrl+9", t("shortcut.focusPane")],
        ["Ctrl+Alt+←, Ctrl+Alt+→", t("shortcut.moveTab")],
        ["Shift+Alt+0", t("menu.flipLayout")],
      ],
    ],
  ]);

  // The dialog is modal: focus stays in it, away from the editor's input.
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "Enter" && (e.target as HTMLElement).matches?.("input:not([type=checkbox])")) {
      // As a dialog's default button; a number half typed counts as typed.
      e.preventDefault();
      e.target!.dispatchEvent(new Event("change"));
      confirm();
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
          <select bind:value={draft.language}>
            <option value="en">English</option>
            <option value="ko">한국어</option>
          </select>
        </label>
        {@render check(t("settings.restoreSession"), draft.restoreSession, (on) => (draft.restoreSession = on))}
        {@render check(t("settings.autoSave"), draft.autoSave, (on) => (draft.autoSave = on))}
        {@render check(t("settings.showHidden"), draft.showHidden, (on) => (draft.showHidden = on))}
      {:else if category === "editor"}
        <div class="field">
          <label for="settings-font">{t("settings.fontFamily")}</label>
          <div class="combo">
            <input
              id="settings-font"
              class="wide"
              role="combobox"
              aria-expanded={fontsOpen}
              aria-controls="settings-fonts"
              aria-autocomplete="none"
              placeholder={t("settings.fontDefault")}
              spellcheck="false"
              bind:value={draft.fontFamily}
              onkeydown={fontKeydown}
              onblur={() => (fontsOpen = false)}
            />
            <button
              class="drop"
              tabindex="-1"
              title={t("settings.fontList")}
              aria-label={t("settings.fontList")}
              onmousedown={(e) => {
                // The keyboard stays in the box.
                e.preventDefault();
                (e.currentTarget.previousElementSibling as HTMLInputElement).focus();
                if (fontsOpen) fontsOpen = false;
                else openFonts();
              }}
            >
              <svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg>
            </button>
            {#if fontsOpen}
              <ul id="settings-fonts" class="fonts" role="listbox" bind:this={fontList}>
                {#each ["", ...fonts] as font, i (font)}
                  <li
                    role="option"
                    class:marked={i === fontAt}
                    aria-selected={draft.fontFamily.trim() === font}
                    style:font-family={font ? `"${font}"` : null}
                    onmousedown={(e) => {
                      e.preventDefault();
                      pickFont(i);
                    }}
                    onmousemove={() => (fontAt = i)}
                  >
                    {font || t("settings.fontDefault")}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
        <p class="hint">{t("settings.fontHint")}</p>
        <label class="field">
          <span>{t("settings.fontSize")}</span>
          {@render number(draft.fontSize, 8, 32, clampFontSize, (size) => (draft.fontSize = size))}
        </label>
        {@render check(t("settings.lineNumbers"), draft.lineNumbers, (on) => (draft.lineNumbers = on))}
        {@render check(t("settings.highlightLine"), draft.highlightLine, (on) => (draft.highlightLine = on))}
        {@render check(t("settings.previewEditors"), draft.previewEditors, (on) => (draft.previewEditors = on))}
        <label class="field">
          <span>{t("settings.tabKey")}</span>
          <select
            value={draft.tabSpaces ? "spaces" : "tab"}
            onchange={(e) => (draft.tabSpaces = e.currentTarget.value === "spaces")}
          >
            <option value="spaces">{t("settings.tabSpaces")}</option>
            <option value="tab">{t("settings.tabCharacter")}</option>
          </select>
        </label>
        <label class="field">
          <span>{t("settings.tabSize")}</span>
          {@render number(draft.tabSize, 1, 16, clampTabSize, (size) => (draft.tabSize = size), !draft.tabSpaces)}
        </label>
        <p class="hint">{t("settings.tabSizeHint")}</p>
        {@render check(t("settings.syntaxHighlight"), draft.syntaxHighlight, (on) => (draft.syntaxHighlight = on))}
        {@render check(t("settings.fieldShading"), draft.fieldShading, (on) => (draft.fieldShading = on))}
        {@render check(t("settings.rainbowColumns"), draft.rainbowColumns, (on) => (draft.rainbowColumns = on))}
      {:else if category === "files"}
        <label class="field">
          <span>{t("settings.newFileEncoding")}</span>
          <select bind:value={draft.newFileEncoding}>
            {#each ENCODINGS as [encoding, hint] (encoding)}
              <option value={encoding}>{ENCODING_LABEL[encoding]} ({t(hint)})</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>{t("settings.newFileEol")}</span>
          <select bind:value={draft.newFileEol}>
            <option value="os">{t("settings.eolOs")}</option>
            <option value="crlf">CRLF</option>
            <option value="lf">LF</option>
          </select>
        </label>
        <label class="field">
          <span>{t("settings.fallbackEncoding")}</span>
          <select bind:value={draft.fallbackEncoding}>
            {#each ENCODINGS.filter(([encoding]) => encoding !== "utf8") as [encoding, hint] (encoding)}
              <option value={encoding}>{ENCODING_LABEL[encoding]} ({t(hint)})</option>
            {/each}
          </select>
        </label>
        <p class="hint">{t("settings.fallbackHint")}</p>
        <label class="field">
          <span>{t("settings.blkDefault")}</span>
          <select bind:value={draft.blkDefault}>
            <option value="nastran">{LANG_LABEL.nastran}</option>
            <option value="abaqus">{LANG_LABEL.abaqus}</option>
          </select>
        </label>
      {:else}
        <table>
          {#each shortcuts as [group, rows] (group)}
            <tbody>
              <tr><th colspan="2">{group}</th></tr>
              {#each rows as [keys, what] (keys)}
                <tr>
                  <td class="keys">{keys}</td>
                  <td>{what}</td>
                </tr>
              {/each}
            </tbody>
          {/each}
        </table>
      {/if}
    </div>
    <footer>
      <button onclick={reset}>{t("settings.reset")}</button>
      <span class="actions">
        <button class="primary" onclick={confirm}>{t("settings.ok")}</button>
        <button onclick={onclose}>{t("settings.cancel")}</button>
        <button disabled={!pending} onclick={apply}>{t("settings.apply")}</button>
      </span>
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
  .combo {
    position: relative;
    display: flex;
    flex: none;
  }
  .combo input.wide {
    padding-right: 26px;
  }
  .drop {
    position: absolute;
    top: 1px;
    right: 1px;
    bottom: 1px;
    display: grid;
    place-items: center;
    width: 24px;
    padding: 0;
    border: none;
    border-radius: 0 3px 3px 0;
    background: transparent;
    color: var(--muted);
  }
  .drop:hover {
    color: var(--fg);
  }
  .drop svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }
  .fonts {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: 1;
    max-height: 220px;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: #2b2b2b;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }
  .fonts li {
    padding: 3px 10px;
    white-space: nowrap;
    cursor: default;
  }
  .fonts li.marked {
    background: #04395e;
  }
  .fonts li[aria-selected="true"] {
    color: #fff;
    font-weight: 600;
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
  th {
    padding: 12px 0 4px;
    font-weight: 600;
    text-align: left;
  }
  tbody:first-child th {
    padding-top: 0;
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
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    min-width: 76px;
  }
  footer button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
