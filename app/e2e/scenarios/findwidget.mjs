// The find widget as VS Code has it: over the text at the top right, with a
// count, regular expressions, Preserve Case and Find in Selection.

const pad = (text, n) => String(text).padEnd(n);
const GRIDS = Array.from({ length: 80 }, (_, i) => `GRID    ${pad(i + 1, 8)}0.      ${pad(`${i}.`, 8)}0.`);
const DECK = [
  "*Heading",
  "** steel plate: Steel, STEEL, steel",
  ...GRIDS,
  `${" ".repeat(100)}TARGET far right`,
  "TARGET at the left",
  ...Array.from({ length: 60 }, (_, i) => `** filler ${i}`),
  "",
].join("\n");

export default async function (t) {
  const { until, check } = t;
  // 가 in CP949, which is not UTF-8.
  t.write({ "deck.bdf": DECK, "cp949.txt": Buffer.from([0x2a, 0x2a, 0x20, 0xb0, 0xa1, 0x0a]) });
  const app = await t.launch({ launchPath: t.path("deck.bdf") });
  const { page } = app;
  await page.waitForSelector(".line");
  const FIND = ".findbar input[placeholder=Find]";
  const REPLACE = ".findbar input[placeholder=Replace]";
  const status = async () => (await page.textContent(".findbar .status")).trim();
  const button = (title) => `.findbar button[title^='${title}']`;
  const pressed = (title) => page.getAttribute(button(title), "aria-pressed");
  const red = () => page.$eval(".findbar .field", (e) => e.classList.contains("nothing"));
  const problem = async () => ((await page.locator(".findbar .problem").count()) ? page.textContent(".findbar .problem") : null);
  const line = async (n) => (await app.lines())[n - (await app.firstLine())];
  /** The text marked as matches on each line on screen. */
  const marked = () =>
    page.$$eval(".slot:not(.hidden) .lines .line", (lines) =>
      lines.map((line) => {
        const found = [];
        let run = null;
        for (const span of line.children) {
          if (span.matches(".match, .found")) run = (run ?? "") + span.textContent;
          else if (run !== null) {
            found.push(run);
            run = null;
          }
        }
        if (run !== null) found.push(run);
        return found.join("|");
      }),
    );
  const scoped = () => page.$$eval(".slot:not(.hidden) .lines .scope", (els) => els.map((e) => e.textContent).join(""));
  const rects = () =>
    page.evaluate(() => {
      const box = (el) => el && JSON.parse(JSON.stringify(el.getBoundingClientRect()));
      return {
        bar: box(document.querySelector(".findbar")),
        editors: box(document.querySelector(".pane .editors")),
        text: box(document.querySelector(".slot:not(.hidden) .text")),
        found: box(document.querySelector(".slot:not(.hidden) .found")),
      };
    });
  /** The keyboard back in the text, clear of the widget. */
  const toText = async () => page.mouse.click(...(await app.at(10, 0)));
  const apart = (a, b) => a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
  const gotoLine = async (n) => {
    await page.keyboard.press("Control+g");
    await page.waitForSelector(".goto input");
    await page.keyboard.type(String(n));
    await page.keyboard.press("Enter");
    await until(`at line ${n}`, app.firstLine, n);
  };

  // ---- Where it is, and the count ---------------------------------------------------------

  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+f");
  await page.keyboard.type("GRID");
  await until("the matches counted, none selected", status, "? of 80");
  const placed = await rects();
  check("over the text, at the top right of the pane, clear of its top", [
    Math.round(placed.bar.top - placed.editors.top) === 8,
    placed.bar.right < placed.editors.right - 14,
    placed.bar.left > placed.text.left,
  ], [true, true, true]);
  await page.keyboard.press("Enter");
  await until("the first", status, "1 of 80");
  await page.keyboard.press("Enter");
  await until("the next", async () => [await status(), await app.position()], ["2 of 80", "Ln 4, Col 5 (4 selected)"]);
  await page.keyboard.press("Shift+Enter");
  await until("back", status, "1 of 80");
  await page.keyboard.press("Shift+Enter");
  await until("round the start, without a word: the count says so", status, "80 of 80");
  await toText();
  await page.keyboard.press("Control+Home");
  await page.mouse.click(...(await app.at(5, 2)));
  await until("a click on a match: which one it is not yet", status, "? of 80");
  await page.mouse.dblclick(...(await app.at(5, 2)));
  await until("a match selected by hand is counted", status, "4 of 80");
  // A new needle's count is not the old one's, not even until it comes.
  await page.fill(FIND, "GRID    1");
  check("a new needle: the old count is gone at once", await status(), "");
  await until("its own", status, "? of 11");
  await page.fill(FIND, "nowhere");
  await until("nothing found: in red", async () => [await status(), await red()], ["No results", true]);
  await page.fill(FIND, "");
  await until("nothing asked: not red", async () => [await status(), await red()], ["No results", false]);
  await app.shot("count");

  // ---- A match under the widget is scrolled clear of it --------------------------------------

  await gotoLine(83);
  await page.focus(FIND);
  await page.fill(FIND, "target");
  await page.keyboard.press("Enter");
  await until("the match at the right of the top line", app.position, "Ln 83, Col 107 (6 selected)");
  const clear = await rects();
  check("is scrolled down, clear of the widget", [(await app.firstLine()) < 83, apart(clear.bar, clear.found)], [true, true]);
  await app.shot("clear");
  await gotoLine(84);
  await page.focus(FIND);
  await page.keyboard.press("Enter");
  await until("one at the left of the top line", app.position, "Ln 84, Col 7 (6 selected)");
  check("is not under it: nothing moves", await app.firstLine(), 84);

  // ---- Regular expressions ------------------------------------------------------------------

  await toText();
  await page.keyboard.press("Control+Home");
  await page.focus(FIND);
  await page.fill(FIND, "GRID\\s+(\\d+)");
  await until("not a regex yet", status, "No results");
  await page.click(button("Use regular expression"));
  check("the toggle", await pressed("Use regular expression"), "true");
  await until("a regex", status, "? of 80");
  await until("its matches marked, from the core", async () => (await marked()).slice(2, 4), ["GRID    1", "GRID    2"]);
  await page.focus(FIND);
  await page.keyboard.press("Enter");
  await until("found", app.position, "Ln 3, Col 10 (9 selected)");
  await page.fill(FIND, "(x");
  await until("a bad one says why", async () => [await problem(), await red()], ["Invalid regular expression: unclosed group", true]);
  await app.shot("bad-regex");
  await page.fill(FIND, "a\\nb");
  await until("nor across lines", problem, "A regular expression is matched within a line: it cannot find line breaks.");
  await page.keyboard.press("Alt+r");
  await until("alt+r: a needle again, with a backslash and an n", async () => [await pressed("Use regular expression"), await problem(), await status()], ["false", null, "No results"]);
  await page.keyboard.press("Alt+r");

  // Groups in the replacement, one at a time and all at once.
  await page.keyboard.press("Control+h");
  await page.waitForSelector(REPLACE);
  await page.fill(FIND, "^GRID\\s+(\\d+)");
  await page.fill(REPLACE, "NODE $1,");
  await toText();
  await page.keyboard.press("Control+Home");
  await page.click(button("Replace (Enter)"));
  await until("the first replace finds", app.position, "Ln 3, Col 10 (9 selected)");
  await page.click(button("Replace (Enter)"));
  await until("the next replaces with the group", async () => [await line(3), await app.position()], [
    "NODE 1,       0.      0.      0.",
    "Ln 4, Col 10 (9 selected)",
  ]);
  await until("one less to count", status, "1 of 79");
  await page.click(button("Replace all"));
  await until("all of them", async () => [await status(), await line(4)], ["Replaced 79", "NODE 2,       0.      1.      0."]);
  await gotoLine(82);
  check("down to the last", await line(82), "NODE 80,      0.      79.     0.");
  await toText();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await until("undone", async () => [await line(3), await line(4)], [GRIDS[0], GRIDS[1]]);

  // At every line start: empty matches.
  await page.fill(FIND, "^");
  await until("empty matches count", async () => (await status()).replace(/^.* of /, ""), "145");

  // Ctrl+F escapes what it takes from the selection.
  await toText();
  await page.keyboard.press("Control+Home");
  await until("at the top", app.firstLine, 1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await until("0. selected", app.position, "Ln 3, Col 33 (2 selected)");
  await page.keyboard.press("Control+f");
  await until("the selection, escaped", () => page.inputValue(FIND), "0\\.");
  await page.click(button("Use regular expression"));

  // ---- Preserve Case ----------------------------------------------------------------------

  await page.fill(FIND, "steel");
  await page.fill(REPLACE, "alu");
  await page.keyboard.press("Alt+p");
  check("alt+p", await pressed("Preserve case"), "true");
  await page.click(button("Replace all"));
  await until("each in the case it replaces", async () => [await status(), await line(2)], ["Replaced 4", "** alu plate: Alu, ALU, alu"]);
  await page.click(button("Preserve case"));
  await toText();
  await page.keyboard.press("Control+z");

  // ---- Find in Selection --------------------------------------------------------------------

  await page.fill(FIND, "GRID");
  await toText();
  await page.keyboard.press("Control+Home");
  await until("undone first", async () => (await app.lines())[1], "** steel plate: Steel, STEEL, steel");
  check("nothing selected: nothing to find in", await page.isDisabled(button("Find in selection")), true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Alt+l");
  check("alt+l: in the selection", await pressed("Find in selection"), "true");
  await until("the scope shows", scoped, GRIDS.slice(0, 3).join(""));
  await until("counted in it", status, "? of 3");
  await until("only its matches marked", async () => (await marked()).slice(1, 7), ["", "GRID", "GRID", "GRID", "", ""]);
  await page.focus(FIND);
  await page.keyboard.press("Enter");
  await until("the first in it", status, "1 of 3");
  await page.keyboard.press("Enter");
  await until("the second", status, "2 of 3");
  await page.keyboard.press("Enter");
  await until("the third", status, "3 of 3");
  await page.keyboard.press("Enter");
  await until("round inside it", async () => [await status(), await app.position()], ["1 of 3", "Ln 3, Col 5 (4 selected)"]);
  // An edit before the scope moves it.
  await toText();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("xx");
  await until("typed", () => line(1), "xx*Heading");
  await until("the scope moves with its text", scoped, GRIDS.slice(0, 3).join(""));
  await page.keyboard.press("F3");
  await until("and is still where it looks", async () => [await status(), await app.position()], ["1 of 3", "Ln 3, Col 5 (4 selected)"]);
  await app.shot("in-selection");
  await page.fill(REPLACE, "G");
  await page.click(button("Replace all"));
  await until("replace all in it only", async () => [await status(), await line(5), await line(6)], ["Replaced 3", "G    3       0.      2.      0.", GRIDS[3]]);
  await page.keyboard.press("Alt+l");
  await until("everywhere again", async () => [await pressed("Find in selection"), await status(), await scoped()], ["false", "? of 77", ""]);
  await toText();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await until("undone", async () => [await line(1), await line(5)], ["*Heading", GRIDS[2]]);

  // ---- Alt+C: case in the widget, column mode in the text ---------------------------------------

  await page.focus(FIND);
  await page.keyboard.press("Alt+c");
  check("alt+c in the widget", await pressed("Match case"), "true");
  await toText();
  await page.keyboard.press("Alt+c");
  check("alt+c in the text: column mode", [await pressed("Match case"), await page.locator(".statusbar .mode").count()], ["true", 1]);
  await page.keyboard.press("Alt+c");
  await page.click(button("Match case"));
  await toText();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Alt+l");
  check("on again", await pressed("Find in selection"), "true");
  await page.focus(FIND);
  await page.keyboard.press("Escape");
  await until("closed", () => page.locator(".findbar").count(), 0);
  await page.keyboard.press("Control+f");
  await until("closing ended Find in Selection", async () => [await pressed("Find in selection"), await scoped()], ["false", ""]);

  // ---- A file not in UTF-8 ----------------------------------------------------------------------

  await app.open(t.path("cp949.txt"));
  await page.keyboard.press("Control+f");
  await page.fill(FIND, "가");
  await until("a literal needle in CP949", status, "? of 1");
  await page.click(button("Use regular expression"));
  await until("a regex only in ASCII", problem, "In a file not in UTF-8, a regular expression can only have ASCII characters.");
  await page.fill(FIND, "\\*+");
  await until("an ASCII one", async () => [await problem(), await status()], [null, "? of 1"]);
  await t.close(app);

  // ---- In Korean ---------------------------------------------------------------------------------

  const korean = await t.launch({ locale: "ko-KR", launchPath: t.path("deck.bdf") });
  const ko = korean.page;
  await ko.waitForSelector(".line");
  await ko.keyboard.press("Control+h");
  await ko.keyboard.type("GRID");
  await ko.keyboard.press("Enter");
  await until("its count", async () => (await ko.textContent(".findbar .status")).trim(), "1/80");
  const titles = await ko.$$eval(".findbar button", (els) => els.map((e) => e.title).filter(Boolean));
  check("its titles", titles, [
    "바꾸기 표시/숨기기 (Ctrl+H)",
    "대소문자 구분 (Alt+C)",
    "단어 단위로 (Alt+W)",
    "정규식 사용 (Alt+R)",
    "이전 찾기 (Shift+Enter, Shift+F3)",
    "다음 찾기 (Enter, F3)",
    "선택 영역에서 찾기 (Alt+L)",
    "닫기 (Esc)",
    "대/소문자 보존 (Alt+P)",
    "바꾸기 (Enter)",
    "모두 바꾸기 (Ctrl+Alt+Enter)",
  ]);
  await korean.shot("korean");
}
