<script lang="ts">
  // The sidebar's compare view: a file for each side, then Compare opens the two
  // in a compare window. A side takes a path typed or pasted, a file chosen, the
  // active file, or files dropped from the OS (two at once fill both sides).
  // What is chosen stays for next time.

  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { tick } from "svelte";
  import * as api from "./api";
  import { openTypes } from "./fileTypes";
  import { t } from "./i18n";

  interface Props {
    /** The path of the active file, for Use the Active File. */
    active: string | null;
    oncompare: (left: string, right: string) => void;
  }

  let { active, oncompare }: Props = $props();

  const SIDES = ["left", "right"] as const;
  const STORED = "hu.compare.sides";

  function stored(): string[] {
    try {
      const sides = JSON.parse(localStorage.getItem(STORED) ?? "null");
      if (Array.isArray(sides) && sides.length === 2) return sides.map((one) => (typeof one === "string" ? one : ""));
    } catch {
      // Not ours to keep: start empty.
    }
    return ["", ""];
  }

  let paths = $state(stored());
  $effect(() => localStorage.setItem(STORED, JSON.stringify(paths)));
  let problems = $state<(string | null)[]>([null, null]);
  /** The side files from the OS are over. */
  let over = $state<number | null>(null);
  let slots: HTMLElement[] = $state([]);
  let inputs: HTMLInputElement[] = $state([]);

  // A long path shows its end, where the file name is, unless it is being typed.
  $effect(() => {
    void [paths[0], paths[1]];
    tick().then(() => {
      for (const input of inputs) if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
    });
  });

  /** Windows "Copy as path" wraps the path in quotes. */
  const clean = (path: string) => path.trim().replace(/^"(.*)"$/, "$1");
  const index = (side: api.Side) => (side === "left" ? 0 : 1);
  let ready = $derived(paths.every((path) => clean(path) !== ""));

  export function setSide(side: api.Side, path: string) {
    paths[index(side)] = path;
    problems[index(side)] = null;
  }

  /** The side at this point of the window, while the view shows. */
  export function sideAt(x: number, y: number): api.Side | null {
    const at = slots.findIndex((slot) => {
      const box = slot?.getBoundingClientRect();
      return !!box && box.width > 0 && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    });
    return at < 0 ? null : SIDES[at];
  }

  /** Files from the OS over a side, or not. */
  export function dragOver(side: api.Side | null) {
    over = side === null ? null : index(side);
  }

  /** Files from the OS let go on a side: one goes there, two go one on each side. */
  export function drop(side: api.Side, dropped: string[]) {
    over = null;
    if (dropped.length >= 2) {
      setSide("left", dropped[0]);
      setSide("right", dropped[1]);
    } else if (dropped.length === 1) setSide(side, dropped[0]);
  }

  async function choose(side: api.Side) {
    const path = await openDialog({ multiple: false, directory: false, filters: openTypes() });
    if (typeof path === "string") setSide(side, path);
  }

  function swap() {
    paths = [paths[1], paths[0]];
    problems = [problems[1], problems[0]];
  }

  function clear() {
    paths = ["", ""];
    problems = [null, null];
  }

  async function compare() {
    const wanted = paths.map(clean);
    const kinds = await Promise.all(wanted.map((path) => api.pathKind(path)));
    problems = kinds.map((kind) => (kind === null ? t("comparePanel.notFound") : kind === "dir" ? t("comparePanel.notFile") : null));
    if (problems.every((problem) => problem === null)) oncompare(wanted[0], wanted[1]);
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Enter" && ready) compare();
  }
</script>

<div class="compare-panel">
  <header>
    <span class="title">{t("comparePanel.title")}</span>
    <button class="icon" title={t("comparePanel.swap")} aria-label={t("comparePanel.swap")} disabled={!paths[0] && !paths[1]} onclick={swap}>
      <svg viewBox="0 0 16 16"><path d="M5 2.5v11M2.5 5L5 2.5 7.5 5M11 13.5v-11M8.5 11l2.5 2.5 2.5-2.5" /></svg>
    </button>
    <button class="icon" title={t("comparePanel.clear")} aria-label={t("comparePanel.clear")} disabled={!paths[0] && !paths[1]} onclick={clear}>
      <svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></svg>
    </button>
  </header>
  <div class="form">
    {#each SIDES as side, i (side)}
      <div class="slot" class:over={over === i} data-side={side} bind:this={slots[i]}>
        <label class="label" for="compare-{side}">{side === "left" ? t("comparePanel.left") : t("comparePanel.right")}</label>
        <div class="pair">
          <div class="field" class:nothing={!!problems[i]}>
            <input
              bind:this={inputs[i]}
              id="compare-{side}"
              bind:value={paths[i]}
              placeholder={t("comparePanel.path")}
              spellcheck="false"
              title={paths[i]}
              oninput={() => (problems[i] = null)}
              onblur={(e) => (e.currentTarget.scrollLeft = e.currentTarget.scrollWidth)}
              onkeydown={keydown}
            />
          </div>
          <button class="icon" title={t("comparePanel.choose")} aria-label={t("comparePanel.choose")} onclick={() => choose(side)}>
            <svg viewBox="0 0 16 16"><path d="M1.5 12.5v-9h4L7 5h7.5v7.5z" /></svg>
          </button>
          <button class="icon" title={t("comparePanel.active")} aria-label={t("comparePanel.active")} disabled={!active} onclick={() => active && setSide(side, active)}>
            <svg viewBox="0 0 16 16"><path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v3h3M5.5 9.5h5M8 7v5" /></svg>
          </button>
        </div>
        {#if problems[i]}
          <p class="problem" role="alert">{problems[i]}</p>
        {/if}
      </div>
    {/each}
    <button class="primary" disabled={!ready} onclick={compare}>{t("comparePanel.compare")}</button>
    <p class="hint">{t("comparePanel.hint")}</p>
  </div>
</div>

<style>
  .compare-panel {
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
    flex-direction: column;
    gap: 10px;
    padding: 0 10px 0 14px;
  }
  .slot {
    margin: -4px -6px;
    padding: 4px 6px;
    border: 1px dashed transparent;
    border-radius: 4px;
  }
  .slot.over {
    border-color: var(--accent);
    background: rgba(0, 122, 204, 0.12);
  }
  .label {
    display: block;
    margin-bottom: 3px;
    color: var(--muted);
    font-size: 11px;
  }
  .pair {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .field {
    display: flex;
    flex: 1;
    align-items: center;
    height: 24px;
    min-width: 0;
    box-sizing: border-box;
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
  .icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 24px;
    height: 22px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
  }
  .icon:hover:not(:disabled) {
    background: rgba(90, 93, 94, 0.5);
    color: var(--fg);
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .icon svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    stroke-linejoin: round;
  }
  .problem {
    margin: 3px 0 0;
    color: #f48771;
    font-size: 12px;
  }
  .primary {
    align-self: stretch;
    height: 26px;
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
    user-select: text;
  }
</style>
