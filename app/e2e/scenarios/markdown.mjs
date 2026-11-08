// Markdown previews, as VS Code has them: Open Preview to the Side (Ctrl+K V)
// beside the text, Open Preview (Ctrl+Shift+V) in its place, following the
// typing; links followed by the app, and nothing in the file that runs.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export default async function (t) {
  const { until, check } = t;
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
  t.write({
    "README.md": [
      "# Deck notes",
      "",
      "Some *emphasis*, a [guide](docs/guide.md), a [deck](model.inp), [the web](https://example.com/), [a missing one](gone.md), [a folder](docs) and [the steps](#load-steps).",
      "",
      "![logo](img/logo.png)",
      "",
      "<script>window.__ran = 1</script>",
      '<img src="nothing.png" onerror="window.__ran = 2"> <a href="javascript:window.__ran = 3">sly</a>',
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- [x] done",
      "",
      filler,
      "",
      "## Load steps",
      "",
      "The end.",
      "",
    ].join("\n"),
    "docs/guide.md": "# Guide\n\nBack to the [readme](../README.md).\n",
    "docs/more.txt": "plain\n",
    "model.inp": "*Node\n",
    "img/logo.png": PNG,
  });
  const app = await t.launch({ launchPath: t.path("README.md") });
  const { page } = app;
  await page.waitForSelector(".line");
  const PANE = (i) => `.pane[data-pane="${i}"]`;
  const paneCount = () => page.locator(".pane").count();
  const tabsOf = (i) => page.$$eval(`${PANE(i)} .strip .tab`, (els) => els.map((e) => `${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}`));
  const focusedPane = () => page.$eval(".pane.focused", (e) => Number(e.dataset.pane));
  const buttons = (i) => page.$$eval(`${PANE(i)} .actions .action`, (els) => els.map((e) => e.classList[1]));
  const preview = (i) => `${PANE(i)} .slot:not(.hidden) .preview`;
  const shownText = (i) => page.locator(preview(i)).textContent().then((text) => text.trim(), () => null);
  const link = (i, text) => page.click(`${preview(i)} a:text-is('${text}')`);
  const keyboardIn = () => page.evaluate(() => (document.activeElement?.closest(".preview") ? "preview" : document.activeElement?.closest(".editor") ? "text" : "elsewhere"));

  check("a Markdown file has the two buttons", await buttons(0), ["preview-side", "preview", "split", "more"]);

  // ---- To the side ----------------------------------------------------------------------------

  await page.click(`${PANE(0)} .actions .preview-side`);
  await until("the preview in a new pane on the right", async () => [await paneCount(), await tabsOf(0), await tabsOf(1)], [2, ["*README.md"], ["*Preview README.md"]]);
  check("the keyboard stays in the text", [await focusedPane(), await keyboardIn()], [0, "text"]);
  await until("shown as HTML", () => page.textContent(`${preview(1)} h1`).catch(() => null), "Deck notes");
  check("its heading can be linked to", await page.getAttribute(`${preview(1)} h1`, "id"), "md-deck-notes");
  check("a table and a box that is not to be ticked", [await page.locator(`${preview(1)} table td`).count(), await page.locator(`${preview(1)} input[type=checkbox][disabled]`).count()], [2, 1]);
  await until("an image of the folder, read by the app", () => page.$eval(`${preview(1)} img[alt=logo]`, (e) => e.src.slice(0, 22)), "data:image/png;base64,");
  check("only one Show Source button for the preview", await buttons(1), ["source", "split", "more"]);
  await page.waitForTimeout(300);
  check("nothing in the file ran", await page.evaluate(() => window.__ran ?? null), null);
  check("no script, handler or javascript: link is left", await page.$eval(preview(1), (e) => [e.querySelectorAll("script").length, e.innerHTML.includes("onerror"), e.innerHTML.includes("javascript")]), [0, false, false]);
  await app.shot("markdown-side");

  // The preview follows the typing.
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Typed *now*.");
  await until("typed: in the preview a moment later", () => page.textContent(`${preview(1)} p:last-child`).catch(() => null), "The end.\nTyped now.");
  check("as Markdown", await page.textContent(`${preview(1)} p:last-child em`), "now");
  await page.keyboard.press("Control+k");
  await page.keyboard.press("v");
  await until("Ctrl+K V again: the same preview, no other", async () => [await paneCount(), await tabsOf(1)], [2, ["*Preview README.md"]]);

  // ---- Links ---------------------------------------------------------------------------------------

  const scrolled = () => page.$eval(preview(1), (e) => e.scrollTop);
  check("at the top", await scrolled(), 0);
  await link(1, "the steps");
  await until("a link to a heading goes down to it", async () => (await scrolled()) > 500, true);
  check("in the preview, not the text", await tabsOf(1), ["*Preview README.md"]);
  await link(1, "the web");
  await until("a web link goes to the browser", async () => (await app.launched()).at(-1), ["open_url", "https://example.com/"]);
  await link(1, "a missing one");
  await until("a file not there says so", app.notice, `${t.path("gone.md")} is not there.`);
  await page.click(".notice");
  await link(1, "sly");
  await page.waitForTimeout(200);
  check("a javascript: link has nowhere to go", [await page.evaluate(() => window.__ran ?? null), await app.notice()], [null, null]);
  await link(1, "a folder");
  await until("a folder shows in the explorer", () => page.locator(".explorer .row:has(.name:text-is('more.txt'))").count(), 1);
  await link(1, "guide");
  await until("a Markdown file: its preview, in the preview's pane", async () => [await tabsOf(1), await page.textContent(`${preview(1)} h1`).catch(() => null)], [
    ["Preview README.md", "*Preview guide.md"],
    "Guide",
  ]);
  await link(1, "readme");
  await until("back: the preview there already", () => tabsOf(1), ["*Preview README.md", "Preview guide.md"]);
  await link(1, "deck");
  await until("another file: its text", () => tabsOf(1), ["Preview README.md", "*model.inp", "Preview guide.md"]);
  check("no preview buttons for it", await buttons(1), ["split", "more"]);
  await page.keyboard.press("Control+Shift+V");
  await page.waitForTimeout(100);
  check("nor Ctrl+Shift+V", await tabsOf(1), ["Preview README.md", "*model.inp", "Preview guide.md"]);

  // ---- In place -----------------------------------------------------------------------------------

  await page.click(`${PANE(0)} .strip .tab`);
  await page.click(`${PANE(0)} .actions .preview`);
  await until("Open Preview: in place of the text", async () => [await tabsOf(0), await buttons(0), await page.locator(`${PANE(0)} .slot:not(.hidden) .editor`).count()], [
    ["*Preview README.md"],
    ["source", "split", "more"],
    0,
  ]);
  await until("with the keyboard", keyboardIn, "preview");
  await until("shown", () => page.textContent(`${preview(0)} h1`).catch(() => null), "Deck notes");
  await page.keyboard.press("PageDown");
  await until("which scrolls it", async () => page.$eval(preview(0), (e) => e.scrollTop > 0), true);
  await page.keyboard.press("Control+a");
  check("Select All takes the preview only", await page.evaluate(() => getSelection().toString().includes("Deck notes") && !getSelection().toString().includes("Preview README")), true);
  await page.click(`${preview(0)} h2`, { button: "right" });
  await page.click(".drop-menu .label:text-is('Copy')");
  await until("copied from its menu", async () => (await app.clipboard()).startsWith("Deck notes"), true);
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(100);
  check("nothing to find in by the text's find bar", await page.locator(".findbar").count(), 0);
  await page.keyboard.press("Control+Shift+V");
  await until("Ctrl+Shift+V: the text again", async () => [await tabsOf(0), await keyboardIn(), await buttons(0)], [["*README.md"], "text", ["preview-side", "preview", "split", "more"]]);
  await app.menu("View", "Open Preview");
  await until("from the View menu too", () => tabsOf(0), ["*Preview README.md"]);
  await app.menu("View", "Show Source");
  await until("which then has Show Source", () => tabsOf(0), ["*README.md"]);
  await page.keyboard.press("Control+Shift+V");
  await until("again", () => tabsOf(0), ["*Preview README.md"]);
  await page.click(`${PANE(0)} .actions .source`);
  await until("and its button", () => tabsOf(0), ["*README.md"]);

  // ---- Kept ------------------------------------------------------------------------------------------------

  await page.keyboard.press("Control+s");
  await until("saved", async () => (await tabsOf(0))[0], "*README.md");
  await page.waitForTimeout(100);
  await page.reload();
  await until("previews come back with the session", async () => [await tabsOf(0), await tabsOf(1)], [["*README.md"], ["Preview README.md", "*model.inp", "Preview guide.md"]]);
  await page.click(`${PANE(1)} .strip .tab:has-text('guide')`);
  await until("as previews", () => page.textContent(`${preview(1)} h1`).catch(() => null), "Guide");
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await until("a preview moved to another pane stays one", async () => [await tabsOf(0), await shownText(0).then((text) => text?.startsWith("Guide"))], [["README.md", "*Preview guide.md"], true]);
  // Merged into the other pane, with the keyboard there: each tab as it was.
  await page.click(`${PANE(1)} .strip .tab:has-text('model')`);
  await app.layout("Single");
  await until("and when the panes are merged", async () => [await paneCount(), await tabsOf(0)], [1, ["Preview README.md", "Preview guide.md", "*model.inp"]]);
  await page.click(`${PANE(0)} .strip .tab:has-text('guide')`);
  await app.splitTab();
  await until("split from its tab: a preview beside it", async () => [await paneCount(), await tabsOf(1), await shownText(1).then((text) => text?.startsWith("Guide"))], [2, ["*Preview guide.md"], true]);
  await app.layout("Single");
  await page.click(`${PANE(0)} .strip .tab:has-text('README')`);
  await page.keyboard.press("Control+Shift+V");
  await until("the text", () => tabsOf(0).then((tabs) => tabs.find((tab) => tab.startsWith("*"))), "*README.md");
  await page.keyboard.press("Control+k");
  await page.keyboard.press("v");
  await until("Ctrl+K V: its preview beside it", async () => [await paneCount(), await tabsOf(1), await focusedPane(), await keyboardIn()], [2, ["*Preview README.md"], 0, "text"]);
  await app.layout("Single");

  // ---- Too large ------------------------------------------------------------------------------------------

  t.write({ "big.md": "# Big\n" + "x".repeat(17 << 20) });
  await app.open(t.path("big.md"));
  await page.keyboard.press("Control+Shift+V");
  await until("too large: says so", () => page.textContent(`${preview(0)} .problem`).catch(() => null), "Too large to preview (18 MB; the limit is 16 MB).");
}
