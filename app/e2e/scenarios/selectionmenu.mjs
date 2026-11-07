// The Selection menu's items from VS Code that need no multiple carets:
// growing and shrinking the selection, moving and copying lines, duplicating,
// and carets added above and below, which are a box of no width.

const DECK = "*Heading\n*Node\n1, 0.5, 2.0\n2, 1.5, 3.0\n*Element\n1, 1, 2\n";
const BULK = "GRID    101             -1.5E+3\nCQUAD4  1       1\n";

export default async function (t) {
  const { until, check } = t;
  t.write({ "deck.inp": DECK, "b.bdf": BULK });
  const app = await t.launch({ launchPath: t.path("deck.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const PANEL = ".menubar .panel";
  const lines = async () => (await app.lines()).join("\n");
  /** The selected text, by way of the clipboard. */
  const selected = async () => {
    await page.keyboard.press("Control+c");
    return app.clipboard();
  };
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());

  // ---- The menu ------------------------------------------------------------------------------

  await page.click(".menubar .title:text-matches('^Selection$')");
  check("the selection menu", await page.$$eval(`${PANEL} .item`, (els) => els.map((e) => `${e.querySelector(".label").textContent.trim()}|${e.querySelector(".shortcut")?.textContent ?? ""}`)), [
    "Select All|Ctrl+A",
    "Expand Selection|Ctrl+Shift+Alt+→",
    "Shrink Selection|Ctrl+Shift+Alt+←",
    "Copy Line Up|Ctrl+Shift+Alt+↑",
    "Copy Line Down|Ctrl+Shift+Alt+↓",
    "Move Line Up|Alt+↑",
    "Move Line Down|Alt+↓",
    "Duplicate Selection|Ctrl+D",
    "Add Cursor Above|Ctrl+Alt+↑",
    "Add Cursor Below|Ctrl+Alt+↓",
    "Column Mode|Alt+C",
  ]);
  await page.keyboard.press("Escape");

  // ---- Moving lines ---------------------------------------------------------------------------

  await page.mouse.click(...(await app.at(2, 3)));
  await press("Alt+ArrowDown");
  await until("alt+down: the line goes down, the caret with it", async () => [await lines(), await app.position()], [
    "*Heading\n*Node\n2, 1.5, 3.0\n1, 0.5, 2.0\n*Element\n1, 1, 2\n",
    "Ln 4, Col 4",
  ]);
  await press("Shift+ArrowUp", "Alt+ArrowUp");
  await until("two lines go up together", async () => [await lines(), await app.position()], [
    "*Heading\n2, 1.5, 3.0\n1, 0.5, 2.0\n*Node\n*Element\n1, 1, 2\n",
    "Ln 2, Col 4 (12 selected)",
  ]);
  await press("Control+z", "Control+z");
  await until("one undo step each", lines, DECK);
  await page.mouse.click(...(await app.at(0, 0)));
  await press("Alt+ArrowUp");
  check("the first line has nowhere to go", await lines(), DECK);
  await app.menu("Selection", "Move Line Down");
  await until("from the menu", lines, "*Node\n*Heading\n1, 0.5, 2.0\n2, 1.5, 3.0\n*Element\n1, 1, 2\n");
  await press("Control+z");

  // ---- Copying lines and the selection ----------------------------------------------------------

  await page.mouse.click(...(await app.at(2, 0)));
  await press("Control+Shift+Alt+ArrowDown");
  await until("a copy below, the caret on it", async () => [(await app.lines()).slice(2, 4), await app.position()], [["1, 0.5, 2.0", "1, 0.5, 2.0"], "Ln 4, Col 1"]);
  await press("Control+Shift+Alt+ArrowUp");
  await until("a copy above, the caret staying", async () => [(await app.lines()).slice(2, 5), await app.position()], [["1, 0.5, 2.0", "1, 0.5, 2.0", "1, 0.5, 2.0"], "Ln 4, Col 1"]);
  await press("Control+z", "Control+z");
  await page.mouse.dblclick(...(await app.at(2, 4)));
  await press("Control+d");
  await until("ctrl+d: the selection once more, selected", async () => [(await app.lines())[2], await app.position()], ["1, 0.50.5, 2.0", "Ln 3, Col 10 (3 selected)"]);
  await press("Control+z");
  await page.mouse.click(...(await app.at(5, 2)));
  await press("Control+d");
  await until("without a selection, the line", async () => (await app.lines()).slice(5, 7), ["1, 1, 2", "1, 1, 2"]);
  await press("Control+z");
  await until("undone", lines, DECK);

  // ---- Carets added above and below --------------------------------------------------------------

  await page.mouse.click(...(await app.at(2, 0)));
  await press("Control+Alt+ArrowDown", "Control+Alt+ArrowDown");
  await until("carets on three lines: a box of no width", app.position, "Ln 5 · Box 3 × 0");
  await page.keyboard.type("X");
  await until("typing goes in on all of them", async () => (await app.lines()).slice(2, 5), ["X1, 0.5, 2.0", "X2, 1.5, 3.0", "X*Element"]);
  await press("Escape", "Control+z");
  await until("in one step", lines, DECK);
  await page.mouse.click(...(await app.at(3, 1)));
  await app.menu("Selection", "Add Cursor Above");
  await until("above, from the menu", app.position, "Ln 3 · Box 2 × 0");
  await press("Escape");

  // ---- Growing and shrinking ----------------------------------------------------------------------

  await page.mouse.click(...(await app.at(2, 4)));
  const grow = [
    ["the word", "0.5"],
    ["the line's text", "1, 0.5, 2.0"],
    ["the line", "1, 0.5, 2.0\n"],
    ["the keyword's block", "*Node\n1, 0.5, 2.0\n2, 1.5, 3.0\n"],
    ["everything", DECK],
  ];
  for (const [step, text] of grow) {
    await press("Control+Shift+Alt+ArrowRight");
    await until(`grows to ${step}`, selected, text);
  }
  for (const [step, text] of grow.slice(0, -1).reverse()) {
    await press("Control+Shift+Alt+ArrowLeft");
    await until(`shrinks back to ${step}`, selected, text);
  }
  await press("Control+Shift+Alt+ArrowLeft");
  await until("and to the caret", app.position, "Ln 3, Col 5");
  // Moved elsewhere since: there is nothing to shrink back to.
  await press("Control+Shift+Alt+ArrowRight");
  await until("grown again", selected, "0.5");
  await page.mouse.click(...(await app.at(5, 1)));
  await press("Control+Shift+Alt+ArrowLeft");
  await page.waitForTimeout(100);
  check("a click since: shrinking leaves the caret", await app.position(), "Ln 6, Col 2");

  // Nastran: a field of fixed columns, then the card.
  await app.open(t.path("b.bdf"));
  await page.mouse.click(...(await app.at(0, 26)));
  await press("Control+Shift+Alt+ArrowRight");
  await until("the word", selected, "1.5E");
  await press("Control+Shift+Alt+ArrowRight");
  await until("the field", selected, "-1.5E+3");
  await app.menu("Selection", "Expand Selection");
  await until("from the menu, the line's text", selected, "GRID    101             -1.5E+3");

  // ---- Korean -------------------------------------------------------------------------------------

  const korean = await t.launch({ locale: "ko-KR", launchPath: t.path("deck.inp") });
  const ko = korean.page;
  await ko.waitForSelector(".line");
  await ko.click(".menubar .title:text-matches('^선택 영역')");
  check("in Korean", await ko.$$eval(`${PANEL} .label`, (els) => els.map((e) => e.textContent.trim())), [
    "모두 선택(A)",
    "선택 영역 확장(E)",
    "선택 영역 축소(S)",
    "위에 줄 복사(C)",
    "아래에 줄 복사(D)",
    "줄 위로 이동(M)",
    "줄 아래로 이동(O)",
    "중복된 선택 영역(U)",
    "위에 커서 추가(B)",
    "아래에 커서 추가(W)",
    "컬럼 모드(L)",
  ]);
}
