<script lang="ts">
  import * as api from "./api";
  import { linkedPath } from "./format";
  import { describeError } from "./i18n";

  interface Props {
    id: number;
    /** Bumped by every change to the text, which the preview then follows. */
    version: number;
    /** Where the document is, for the links and images in it; null for a new one. */
    path: string | null;
    /** A link to anything but a place in this preview. */
    onlink: (href: string) => void;
    oncontext: (x: number, y: number) => void;
  }

  let { id, version, path, onlink, oncontext }: Props = $props();

  /** Before each `id` of the HTML, as the backend writes it. */
  const ID_PREFIX = "md-";
  /** Typing goes on for a while: the preview follows a moment after it stops. */
  const SETTLE_MS = 250;

  let view: HTMLDivElement;
  let body: HTMLDivElement;
  let problem = $state<string | null>(null);
  let shown = false;
  let asked = 0;
  /** Each image file read once. */
  const images = new Map<string, Promise<string>>();

  $effect(() => {
    void version;
    void id;
    if (!shown) {
      render();
      return;
    }
    const timer = setTimeout(render, SETTLE_MS);
    return () => clearTimeout(timer);
  });

  async function render() {
    const ask = ++asked;
    let html: string;
    try {
      html = await api.renderMarkdown(id);
    } catch (e) {
      if (ask !== asked) return;
      problem = describeError(e);
      body.replaceChildren();
      return;
    }
    if (ask !== asked) return;
    shown = true;
    problem = null;
    // Inert until shown, so that no image is asked of the app's own server.
    const page = document.createElement("template");
    page.innerHTML = html;
    for (const image of page.content.querySelectorAll("img")) load(image);
    body.replaceChildren(page.content);
  }

  /** A file's image comes through the backend; one on the web as it is. */
  function load(image: HTMLImageElement) {
    const src = image.getAttribute("src");
    if (!src || /^(https?|data):/i.test(src)) return;
    image.removeAttribute("src");
    if (path === null) return;
    const file = linkedPath(path, src.replace(/[?#].*$/, ""));
    let data = images.get(file);
    if (!data) {
      data = api.imageData(file);
      images.set(file, data);
      // Tried again next time: it may be there by then.
      data.catch(() => images.delete(file));
    }
    data.then(
      (url) => (image.src = url),
      // Not there, or not an image: what it says instead shows.
      () => {},
    );
  }

  /** Links are followed here, never by the page itself. */
  function follow(e: MouseEvent) {
    const link = (e.target as Element).closest("a[href]");
    if (!link) return;
    e.preventDefault();
    if (e.button !== 0) return;
    const href = link.getAttribute("href")!;
    if (href.startsWith("#")) goTo(href.slice(1));
    else onlink(href);
  }

  function goTo(fragment: string) {
    let name = fragment;
    try {
      name = decodeURIComponent(fragment);
    } catch {
      // Left as written.
    }
    body.querySelector(`[id="${CSS.escape(ID_PREFIX + name)}"]`)?.scrollIntoView();
  }

  function onkeydown(e: KeyboardEvent) {
    // Select All takes the preview, not the whole window.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyA") {
      e.preventDefault();
      getSelection()?.selectAllChildren(body);
    }
  }

  export function focus() {
    view.focus({ preventScroll: true });
  }

  /** What is selected in the preview, as text. */
  export function selection() {
    const selected = getSelection();
    return selected && !selected.isCollapsed && body.contains(selected.anchorNode) ? selected.toString() : "";
  }

  export function selectAll() {
    getSelection()?.selectAllChildren(body);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (it scrolls by the keys, and follows its links) -->
<div
  class="preview"
  role="document"
  tabindex="0"
  bind:this={view}
  onclick={follow}
  onauxclick={follow}
  {onkeydown}
  oncontextmenu={(e) => {
    e.preventDefault();
    oncontext(e.clientX, e.clientY);
  }}
>
  {#if problem}
    <p class="problem">{problem}</p>
  {/if}
  <div class="body" bind:this={body}></div>
</div>

<style>
  .preview {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 0 26px;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--ui);
    font-size: 14px;
    line-height: 1.6;
    outline: none;
    user-select: text;
    word-wrap: break-word;
  }

  .problem {
    color: var(--muted);
  }

  .body {
    max-width: 900px;
    padding: 12px 0 30vh;
  }

  .body :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin: 24px 0 12px;
    font-weight: 600;
    line-height: 1.25;
  }

  .body :global(h1) {
    font-size: 2em;
  }

  .body :global(:is(h1, h2)) {
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }

  .body :global(h2) {
    font-size: 1.5em;
  }

  .body :global(h3) {
    font-size: 1.25em;
  }

  .body :global(:is(p, ul, ol, table, pre, blockquote, details)) {
    margin: 0 0 14px;
  }

  .body :global(:is(ul, ol)) {
    padding-left: 2em;
  }

  .body :global(li:has(> input[type="checkbox"])) {
    list-style: none;
  }

  .body :global(input[type="checkbox"]) {
    margin: 0 0.4em 0 -1.4em;
    padding: 0;
    vertical-align: middle;
  }

  .body :global(a) {
    color: #3794ff;
    text-decoration: none;
    cursor: pointer;
  }

  .body :global(a:hover) {
    text-decoration: underline;
  }

  .body :global(code) {
    padding: 0.1em 0.35em;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    font-family: var(--mono);
    font-size: 0.9em;
  }

  .body :global(pre) {
    overflow: auto;
    padding: 12px 16px;
    border-radius: 4px;
    background: var(--panel);
    line-height: 1.45;
  }

  .body :global(pre code) {
    padding: 0;
    background: none;
  }

  .body :global(blockquote) {
    padding: 0 16px;
    margin-left: 0;
    border-left: 4px solid #4d4d4d;
    color: var(--muted);
  }

  .body :global(table) {
    border-collapse: collapse;
  }

  .body :global(:is(th, td)) {
    padding: 5px 12px;
    border: 1px solid var(--border);
  }

  .body :global(th) {
    background: var(--panel);
  }

  .body :global(hr) {
    border: 0;
    border-top: 1px solid var(--border);
  }

  .body :global(img) {
    max-width: 100%;
  }

  .body :global(kbd) {
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--panel);
    font-family: var(--mono);
    font-size: 0.85em;
  }

  /* GitHub's alerts, its colours. */
  .body :global(blockquote[class^="markdown-alert-"]) {
    color: var(--fg);
  }

  .body :global(blockquote[class^="markdown-alert-"]::before) {
    display: block;
    padding-top: 6px;
    font-weight: 600;
  }

  .body :global(.markdown-alert-note) {
    border-left-color: #4493f8;
  }

  .body :global(.markdown-alert-note::before) {
    content: "Note";
    color: #4493f8;
  }

  .body :global(.markdown-alert-tip) {
    border-left-color: #3fb950;
  }

  .body :global(.markdown-alert-tip::before) {
    content: "Tip";
    color: #3fb950;
  }

  .body :global(.markdown-alert-important) {
    border-left-color: #ab7df8;
  }

  .body :global(.markdown-alert-important::before) {
    content: "Important";
    color: #ab7df8;
  }

  .body :global(.markdown-alert-warning) {
    border-left-color: #d29922;
  }

  .body :global(.markdown-alert-warning::before) {
    content: "Warning";
    color: #d29922;
  }

  .body :global(.markdown-alert-caution) {
    border-left-color: #f85149;
  }

  .body :global(.markdown-alert-caution::before) {
    content: "Caution";
    color: #f85149;
  }
</style>
