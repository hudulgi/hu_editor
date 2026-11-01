// Box selection, on the keyboard and with the mouse.

const DECK = "GRID    1       0.      0.      0.\nGRID    2       1.      0.      0.\nGRID    3\nGRID    4       3.      0.      0.\n$ 한글 comment\n";

export default async function (t) {
  t.write({ "box.bdf": DECK });
  const app = await t.launch({ launchPath: t.path("box.bdf") });
  const { page } = app;
  await page.waitForSelector(".line");
  const { until } = t;
  const original = await app.lines();

  // Alt+drag: field 3 (columns 16-24) of the four GRID lines.
  await app.altDrag(await app.at(0, 16), await app.at(3, 24));
  await until("alt+drag makes a 4 × 8 box", app.position, "Ln 4 · Box 4 × 8");
  await app.shot("box");
  await page.keyboard.press("Control+c");
  await until("copy a box", app.clipboard, "0.      \n1.      \n\n3.      ");

  await page.keyboard.type("9.");
  await until(
    "typing replaces the column on every line, padding the short one",
    async () => (await app.lines()).slice(0, 4),
    ["GRID    1       9.0.      0.", "GRID    2       9.0.      0.", "GRID    3       9.", "GRID    4       9.0.      0."],
  );
  await until("then the box is a column of carets", app.position, "Ln 4 · Box 4 × 0");
  await page.keyboard.press("Control+z");
  await until("one undo restores every line", app.lines, original);

  // Keyboard box: Alt+Shift+arrows from the caret, then Delete.
  await page.keyboard.press("Escape");
  await page.mouse.click(...(await app.at(0, 8)));
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await until("alt+shift+arrows", app.position, "Ln 3 · Box 3 × 1");
  await page.keyboard.press("Delete");
  await until(
    "delete a column",
    async () => (await app.lines()).slice(0, 3),
    ["GRID           0.      0.      0.", "GRID           1.      0.      0.", "GRID    "],
  );
  await page.keyboard.press("Control+z");
  await until("undo", app.lines, original);

  // Column mode: plain Shift+arrows make a box.
  await page.keyboard.press("Escape");
  await page.mouse.click(...(await app.at(0, 32)));
  await page.keyboard.press("Alt+c");
  await until("alt+c shows column mode", async () => (await app.status()).includes("COL"), true);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await until("shift+arrows in column mode", app.position, "Ln 3 · Box 3 × 0");
  await page.keyboard.press("Alt+c");
  await until("alt+c again leaves column mode", async () => (await app.status()).includes("COL"), false);

  // A block pasted into the column: one line per row, short lines padded.
  await app.paste("A\nB\nC\n");
  await until("paste a block", async () => (await app.lines()).slice(0, 3), [
    "GRID    1       0.      0.      A0.",
    "GRID    2       1.      0.      B0.",
    "GRID    3                       C",
  ]);
  await page.keyboard.press("Control+z");
  await until("undo the paste", app.lines, original);

  // The Tab key in a box: spaces to the next stop on every line.
  await page.keyboard.press("Escape");
  await page.mouse.click(...(await app.at(0, 32)));
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.keyboard.press("Tab");
  await until("tab in a box", async () => (await app.lines()).slice(0, 2), [
    "GRID    1       0.      0.              0.",
    "GRID    2       1.      0.              0.",
  ]);
  await page.keyboard.press("Control+z");
  await until("undo the tab", app.lines, original);

  // Hangul takes two columns: a box over columns 2-4 is exactly 한.
  await page.keyboard.press("Escape");
  await app.altDrag(await app.at(4, 2), await app.at(4, 4));
  await page.keyboard.press("Backspace");
  await until("box over Hangul", async () => (await app.lines())[4], "$ 글 comment");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Escape");
  await until("escape ends the box", async () => (await app.position()).includes("Box"), false);
}
