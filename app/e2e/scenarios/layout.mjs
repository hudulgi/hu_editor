// Everything that turns pixels into lines and columns, at font sizes other than
// the default: the mouse, the box, the caret, the wheel, the scrollbar, paging.

const LINES = 400;
const DECK =
  Array.from({ length: LINES }, (_, i) => {
    if (i === 2) return "GRID           3";
    if (i === 4) return "$ 한글 comment";
    return `GRID    ${String(i + 1).padStart(8)}0.      1.      2.`;
  }).join("\n") + "\n";

const SLOT = ".slot:not(.hidden)";

/** Rows with the top of the gutter's number, the text and the caret or box, as drawn. */
const rects = (page, selector) =>
  page.$$eval(`${SLOT} ${selector}`, (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));

async function drawnInStep(t, app, label) {
  const lines = await rects(app.page, ".lines .line");
  const numbers = await rects(app.page, ".gutter .ln");
  t.check(`${label}: line numbers sit next to their lines`, numbers, lines);
}

/** The number at the start of a data line, which is its line number. */
const lineNumberOf = (text) => Number(text.slice(8, 16));

const WIDE = "0123456789".repeat(40);

/** Without line numbers the text keeps a margin, and the margin works as part of the text. */
async function margin(t) {
  const { until, check } = t;
  const app = await t.launch({ settings: { lineNumbers: false }, launchPath: t.path("wide.txt") });
  const { page } = app;
  await page.waitForSelector(".line");
  const { cell } = await app.metrics();
  const left = (selector) => page.$eval(`${SLOT} ${selector}`, (e) => e.getBoundingClientRect().left);
  const col = async () => Number((await app.position()).match(/Col (\d+)/)[1]);
  const scrolled = () => page.$eval(`${SLOT} .text`, (e) => e.scrollLeft);
  const inMargin = async (row) => [(await left(".editor")) + 4, (await app.at(row, 0))[1]];
  const drag = async (from, to) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 3 });
    await page.mouse.up();
  };

  check("there is a margin", (await left(".lines .line")) - (await left(".editor")), 12);
  await page.evaluate(() => document.fonts.ready);

  // The caret still sits on the text.
  await page.mouse.click(...(await app.at(0, 5)));
  await until("click in the text", app.position, "Ln 1, Col 6");
  await until("the caret is at its column", async () => Math.abs((await left(".caret")) - (await left(".lines .line")) - 5 * cell) < 1, true);
  await app.shot("margin");

  // A click in the margin goes to the start of that line, and keeps the keyboard.
  await page.mouse.click(...(await inMargin(1)));
  await until("click in the margin", app.position, "Ln 2, Col 1");
  await until("the caret is at the start of the text", async () => Math.abs((await left(".caret")) - (await left(".lines .line"))) < 1, true);
  check("the keyboard stays in the text", await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");
  await page.keyboard.type("A");
  await until("typing after it", async () => (await app.lines())[1].slice(0, 3), "A01");
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.lines())[1], WIDE);

  // Dragging from the margin selects from the start of the line.
  await drag(await inMargin(0), await app.at(1, 3));
  await page.keyboard.press("Control+c");
  await until("drag from the margin", app.clipboard, `${WIDE}\n012`);

  // A box from the margin starts at the first column.
  await app.altDrag(await inMargin(0), await app.at(1, 3));
  await until("a box from the margin", app.position, "Ln 2 · Box 2 × 3");
  check("it is drawn from the start of the text", Math.abs((await left(".box")) - (await left(".lines .line"))) < 1, true);
  await page.keyboard.press("Escape");

  // Scrolled sideways, the margin stands for the first column in view, and the
  // text does not reach into it. At a fractional position, as on a scaled display,
  // and with the older caret call of other engines, which takes whole pixels.
  for (const [shift, whole] of [[0, false], [0.4, false], [0.6, false], [0.6, true]]) {
    const label = (text) => `shifted ${shift}${whole ? " in whole pixels" : ""}: ${text}`;
    await page.$eval(`${SLOT} .editor`, (e, shift) => (e.style.marginLeft = `${shift}px`), shift);
    await page.evaluate((whole) => (document.caretPositionFromPoint = whole ? undefined : Document.prototype.caretPositionFromPoint), whole);
    await page.mouse.click(...(await app.at(0, 0)));
    await page.keyboard.press("End");
    await until(label("scrolled to the end of the line"), async () => (await scrolled()) > 1000, true);
    if (!shift) await app.shot("margin-scrolled");
    const inView = (await scrolled()) / cell;
    await page.mouse.click(...(await inMargin(1)));
    await until(label("click in the margin"), async () => (await app.position()).startsWith("Ln 2,"), true);
    check(label("goes to the first column in view"), Math.abs((await col()) - 1 - inView) <= 1, true);
    await page.mouse.click(...(await inMargin(2)));
    await until(label("on a line that ends before it"), app.position, "Ln 3, Col 6");

    await page.mouse.click(...(await app.at(0, 0)));
    await page.keyboard.press("End");
    await until(label("scrolled again"), async () => (await scrolled()) > 1000, true);
    const box = await left(".text");
    await app.altDrag(await inMargin(1), [box + 12 + 10 * cell, (await app.at(1, 0))[1]]);
    const width = Number((await app.position()).match(/× (\d+)/)?.[1]);
    check(label("a box from there starts at that column"), Math.abs(width - 10) <= 1, true);
    await page.keyboard.press("Escape");
  }
  await page.$eval(`${SLOT} .editor`, (e) => (e.style.marginLeft = ""));
  await page.evaluate(() => (document.caretPositionFromPoint = Document.prototype.caretPositionFromPoint));

  // The line numbers come back in place of the margin.
  await page.keyboard.press("Control+Home");
  await app.page.keyboard.press("Alt+v");
  await app.page.keyboard.press("n");
  await until("line numbers on", () => page.locator(`${SLOT} .gutter`).count(), 1);
  const gutter = await page.$eval(`${SLOT} .gutter`, (e) => e.getBoundingClientRect().right);
  check("the text follows the numbers", await left(".lines .line"), gutter);

  // Dragging over the numbers while scrolled ends at the first column in view, not at the line's end.
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("End");
  await until("scrolled to the end of the line", async () => (await scrolled()) > 1000, true);
  const anchorX = gutter + 200;
  const y = (await app.at(1, 0))[1];
  await page.mouse.click(anchorX, y);
  const anchor = await col();
  await drag([anchorX, y], [gutter - 20, y]);
  check("a drag over the numbers goes left", (await col()) < anchor, true);
}

async function exercise(t, app, size) {
  const { page } = app;
  const { until } = t;
  const label = (text) => `size ${size}: ${text}`;
  const { lineH, cell } = await app.metrics();
  t.check(label("the line height follows the font"), lineH, Math.round(size * 1.54));

  // The rows fill the pane.
  const paneH = await page.$eval(`${SLOT} .text`, (e) => e.clientHeight);
  const rows = Math.floor(paneH / lineH);
  await until(label("as many rows as fit"), async () => (await app.lines()).length, rows);
  await drawnInStep(t, app, label("at the top"));

  // A click lands on the line and column under it.
  await page.mouse.click(...(await app.at(3, 16)));
  await until(label("click"), app.position, "Ln 4, Col 17");
  const caretGap = await page.evaluate((slot) => {
    const caret = document.querySelector(`${slot} .caret`).getBoundingClientRect();
    const line = document.querySelectorAll(`${slot} .lines .line`)[3].getBoundingClientRect();
    return Math.abs(caret.top - line.top);
  }, SLOT);
  t.check(label("the caret sits on the line"), caretGap < 2, true);

  // A click past the end of a line goes to its end.
  await page.mouse.click(...(await app.at(2, 60)));
  await until(label("click past the end"), app.position, "Ln 3, Col 17");

  // Alt+drag: a box over columns 16-24, across a line too short to reach them.
  const original = await app.lines();
  await app.altDrag(await app.at(0, 16), await app.at(3, 24));
  await until(label("alt+drag"), app.position, "Ln 4 · Box 4 × 8");
  const { first, last } = await page.evaluate((slot) => {
    const boxes = [...document.querySelectorAll(`${slot} .box`)].map((b) => b.getBoundingClientRect());
    return { first: boxes[0], last: boxes.at(-1) };
  }, SLOT);
  const top = (await app.metrics()).y;
  t.check(label("the box starts on the first row"), Math.round(first.top), Math.round(top));
  t.check(label("and ends on the fourth"), Math.round(last.top), Math.round(top + 3 * lineH));
  t.check(label("the box is 8 columns wide"), Math.abs(first.width - 8 * cell) < 1, true);
  await app.shot(`layout-box-${size}`);
  await page.keyboard.press("Control+c");
  await until(label("copy the box"), app.clipboard, "0.      \n0.      \n\n0.      ");
  await page.keyboard.type("9.");
  await until(label("type in the box"), async () => (await app.lines()).slice(0, 4), [
    "GRID           19.1.      2.",
    "GRID           29.1.      2.",
    "GRID           39.",
    "GRID           49.1.      2.",
  ]);
  await page.keyboard.press("Control+z");
  await until(label("undo in the box"), app.lines, original);
  await page.keyboard.press("Escape");

  // Past a line's end, the box counts columns of space (the short third line).
  await app.altDrag(await app.at(2, 40), await app.at(2, 44));
  await until(label("a box past the end of a line"), app.position, "Ln 3 · Box 1 × 4");
  await page.keyboard.press("Escape");

  // Hangul takes two columns at any size.
  await app.altDrag(await app.at(4, 2), await app.at(4, 4));
  await page.keyboard.press("Backspace");
  await until(label("box over Hangul"), async () => (await app.lines())[4], "$ 글 comment");
  await page.keyboard.press("Control+z");
  await until(label("undone"), async () => (await app.lines())[4], "$ 한글 comment");
  await page.keyboard.press("Escape");

  // The wheel: one line's height per line, and parts of a line add up.
  await page.mouse.move(...(await app.at(5, 5)));
  await page.mouse.wheel(0, lineH * 10);
  await until(label("wheel 10 lines"), app.firstLine, 11);
  await page.mouse.wheel(0, lineH / 2);
  await page.mouse.wheel(0, lineH / 2);
  await until(label("two half lines make one"), app.firstLine, 12);
  await page.mouse.wheel(0, -lineH * 11);
  await until(label("wheel back"), app.firstLine, 1);

  // A click after scrolling, with the line numbers still in step.
  await page.mouse.wheel(0, lineH * 50);
  await until(label("scrolled"), app.firstLine, 51);
  await page.mouse.click(...(await app.at(2, 0)));
  await until(label("click after scrolling"), async () => (await app.position()).startsWith("Ln 53,"), true);
  await drawnInStep(t, app, label("scrolled"));

  // Page keys move a screenful less a line, and scroll with the caret.
  await page.keyboard.press("PageDown");
  await until(label("page down"), async () => (await app.position()).startsWith(`Ln ${53 + rows - 1},`), true);
  await page.keyboard.press("PageUp");
  await until(label("page up"), async () => (await app.position()).startsWith("Ln 53,"), true);

  // The scrollbar: a click in the track pages, the thumb goes to the end.
  const before = await app.firstLine();
  const track = await page.locator(`${SLOT} .vscroll`).boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + track.height - 5);
  await until(label("a click in the track pages"), app.firstLine, before + rows - 1);
  const thumb = await page.locator(`${SLOT} .thumb`).boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, track.y + track.height + 50, { steps: 4 });
  await page.mouse.up();
  await until(label("dragging the thumb to the end shows the end"), async () => (await app.lines()).at(-1), "");
  await until(label("as many rows as fit at the end"), async () => (await app.lines()).length, rows);
  await drawnInStep(t, app, label("at the end"));

  // The scrollbar leaves the keyboard in the editor.
  t.check(label("the editor keeps the focus"), await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");

  // Ctrl+End and Ctrl+Home; go to line.
  await page.keyboard.press("Control+Home");
  await until(label("ctrl+home"), async () => [await app.firstLine(), await app.position()], [1, "Ln 1, Col 1"]);
  await page.keyboard.press("Control+End");
  await until(label("ctrl+end"), app.position, `Ln ${LINES + 1}, Col 1`);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+g");
  await page.keyboard.type("200");
  await page.keyboard.press("Enter");
  await until(label("go to line"), async () => (await app.position()).startsWith("Ln 200,"), true);
  const row = (await app.lines()).findIndex((text) => lineNumberOf(text) === 200);
  t.check(label("the line is on screen"), row >= 0 && row < rows, true);
  await page.keyboard.press("Control+Home");
}

export default async function (t) {
  t.write({ "deck.bdf": DECK, "other.bdf": DECK, "wide.txt": `${WIDE}\n${WIDE}\nshort\n\n${WIDE}\n` });

  await margin(t);

  for (const size of [20, 9, 13]) {
    const app = await t.launch({ settings: { fontSize: size }, launchPath: t.path("deck.bdf") });
    await app.page.waitForSelector(".line");
    await exercise(t, app, size);
  }

  // Changing the size with a file open and scrolled keeps the place.
  const app = await t.launch({ launchPath: t.path("deck.bdf") });
  const { page } = app;
  await page.waitForSelector(".line");
  const { until } = t;
  await page.mouse.move(...(await app.at(5, 5)));
  await page.mouse.wheel(0, 20 * 100);
  await until("scrolled to line 101", app.firstLine, 101);
  await page.mouse.click(...(await app.at(2, 5)));
  await until("caret on line 103", async () => (await app.position()).startsWith("Ln 103,"), true);
  await app.setFontSize(20);
  await until("the line height changes", async () => (await app.metrics()).lineH, 31);
  await until("the same line stays on top", app.firstLine, 101);
  const paneH = await page.$eval(`${SLOT} .text`, (e) => e.clientHeight);
  await until("the rows follow", async () => (await app.lines()).length, Math.floor(paneH / 31));
  await until(
    "the caret follows its line",
    () =>
      page.evaluate((slot) => {
        const caret = document.querySelector(`${slot} .caret`).getBoundingClientRect();
        const line = document.querySelectorAll(`${slot} .lines .line`)[2].getBoundingClientRect();
        return Math.abs(caret.top - line.top) < 2;
      }, SLOT),
    true,
  );
  await drawnInStep(t, app, "after the change");

  // A box drawn at one size is redrawn at the next.
  await app.altDrag(await app.at(0, 16), await app.at(2, 24));
  await until("a box", app.position, "Ln 103 · Box 3 × 8");
  await app.setFontSize(9);
  await until("the box's rows follow the new size", async () => {
    const { y, lineH } = await app.metrics();
    const tops = await rects(page, ".box");
    return tops.map((top) => Math.round((top - y) / lineH));
  }, [0, 1, 2]);
  await page.keyboard.press("Escape");

  // A hidden tab follows too.
  await app.setFontSize(13);
  await until("back at 13", async () => (await app.metrics()).lineH, 20);
  await app.open(t.path("other.bdf"));
  await page.click(".strip .tab:has-text('deck.bdf')");
  await app.setFontSize(20);
  await page.click(".strip .tab:has-text('other.bdf')");
  await until("a tab that was hidden has the new height", async () => (await app.metrics()).lineH, 31);
  await until("and the rows for it", async () => (await app.lines()).length, Math.floor(paneH / 31));
}
