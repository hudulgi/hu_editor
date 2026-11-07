// The Edit menu's items from VS Code: toggling comments the way each language
// writes them; and Find and Replace in Files, in the Search menu as UltraEdit
// keeps them, in a search view beside the explorer.

export default async function (t) {
  const { until, check } = t;
  t.write({
    "deck.inp": "*Node\n101, 0.\n*Element\nGRID 101\n",
    "b.bdf": "GRID    101\nCQUAD4  1\n",
    "c.js": "function f() {\n  let a = 1;\n}\n",
    "notes.txt": "plain 101\n",
    "sub/inc.inp": "*Nset\n101, 102\n",
    "results/out.inp": "101\n",
    "indented/i.inp": "  *Node\n",
    "indented/i.bdf": "  GRID 1\n",
  });
  const app = await t.launch({ launchPath: t.path("deck.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const PANEL = ".menubar .panel";
  const items = () =>
    page.$$eval(`${PANEL} .item`, (els) =>
      els.map((e) => `${e.disabled ? "-" : ""}${e.querySelector(".label").textContent.trim()}|${e.querySelector(".shortcut")?.textContent ?? ""}`),
    );
  const line = async (n) => (await app.lines())[n - 1];
  const said = async () => ((await page.locator(".search .said").count()) ? (await page.textContent(".search .said")).trim() : "");
  /** The results as `name folder|count`, each match under its file. */
  const tree = () =>
    page.$$eval(".search .results > button", (els) =>
      els.map((e) =>
        e.classList.contains("file")
          ? `${e.querySelector(".name").textContent} ${e.querySelector(".folder").textContent}`.trim() + `|${e.querySelector(".count").textContent}`
          : `  ${e.textContent.trim()}`,
      ),
    );
  const SEARCH = ".search input[placeholder=Search]";
  const REPLACE = ".search input[placeholder=Replace]";
  const FOLDER = ".search input[placeholder='Folder to search']";

  // ---- The menu ------------------------------------------------------------------------------

  await page.click(".menubar .title:text-matches('^Edit$')");
  check("the edit menu", await items(), [
    "-Undo|Ctrl+Z",
    "-Redo|Ctrl+Y",
    "Cut|Ctrl+X",
    "Copy|Ctrl+C",
    "Paste|Ctrl+V",
    "Toggle Line Comment|Ctrl+/",
    "-Toggle Block Comment|Shift+Alt+A",
  ]);
  await page.hover(".menubar .title:text-matches('^Search$')");
  await until("the search menu", () => page.textContent(".menubar .title.open"), "Search");
  check("the search menu: all the finding", await items(), [
    "Find…|Ctrl+F",
    "Replace…|Ctrl+H",
    "Find Next|F3",
    "Find Previous|Shift+F3",
    "Find Selection|Ctrl+F3",
    "Change All Occurrences|Ctrl+F2",
    "Find in Files|Ctrl+Shift+F",
    "Replace in Files|Ctrl+Shift+H",
    "Go to Line…|Ctrl+G",
  ]);
  await page.keyboard.press("Escape");

  // ---- Toggle Line Comment ---------------------------------------------------------------------

  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Control+/");
  await until("ctrl+/ comments the lines, at their start, as Abaqus wants", async () => [await line(1), await line(2), await line(3), await app.position()], [
    "** *Node",
    "** 101, 0.",
    "*Element",
    "Ln 3, Col 1 (20 selected)",
  ]);
  await page.keyboard.press("Control+/");
  await until("and off again", async () => [await line(1), await line(2), await app.position()], ["*Node", "101, 0.", "Ln 3, Col 1 (14 selected)"]);
  await page.mouse.click(...(await app.at(2, 3)));
  await app.menu("Edit", "Toggle Line Comment");
  await until("from the menu, the caret's line; the caret on its letter", async () => [await line(3), await app.position()], ["** *Element", "Ln 3, Col 7"]);
  await page.keyboard.press("Control+z");
  await until("one undo step", () => line(3), "*Element");

  await app.open(t.path("b.bdf"));
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+/");
  await until("Nastran's $", () => line(1), "$ GRID    101");
  await page.keyboard.press("Control+z");

  // A deck's comment goes at the line's start, indent or not: a solver reads it from column 1.
  for (const [name, plain, commentedLine] of [
    ["indented/i.inp", "  *Node", "**   *Node"],
    ["indented/i.bdf", "  GRID 1", "$   GRID 1"],
  ]) {
    await app.open(t.path(name));
    await page.mouse.click(...(await app.at(0, 4)));
    await page.keyboard.press("Control+/");
    await until(`${name} at column 1`, () => line(1), commentedLine);
    await page.keyboard.press("Control+z");
    await until(`${name} as it was`, () => line(1), plain);
    await page.keyboard.press("Control+w");
    await until(`${name} closed`, async () => (await app.tabs()).some((tab) => tab.includes(name.split("/")[1])), false);
  }
  // Ctrl+/ in a box to type in is not for the text.
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Control+/");
  await page.keyboard.press("Escape");
  check("not from the find bar", await line(1), "GRID    101");

  await app.open(t.path("c.js"));
  await page.mouse.click(...(await app.at(1, 6)));
  await page.keyboard.press("Control+/");
  await until("code, after the indent", () => line(2), "  // let a = 1;");
  await page.keyboard.press("Control+z");
  await page.mouse.dblclick(...(await app.at(1, 6)));
  await page.keyboard.press("Shift+Alt+a");
  await until("shift+alt+a: a block comment round the selection", async () => [await line(2), await app.position()], ["  let /* a */ = 1;", "Ln 2, Col 11 (1 selected)"]);
  await page.keyboard.press("Shift+Alt+a");
  await until("and out of it", () => line(2), "  let a = 1;");

  await app.open(t.path("notes.txt"));
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+/");
  check("plain text has no comments", await line(1), "plain 101");
  await page.click(".menubar .title:text-matches('^Edit$')");
  check("nor the menu items", (await items()).filter((item) => item.includes("Comment")), ["-Toggle Line Comment|Ctrl+/", "-Toggle Block Comment|Shift+Alt+A"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+w");

  // ---- Find in Files --------------------------------------------------------------------------

  await app.open(t.path("deck.inp"));
  await page.mouse.dblclick(...(await app.at(2, 2)));
  await page.keyboard.press("Control+Shift+f");
  await page.waitForSelector(".search input:focus");
  check("with the selected text", await page.inputValue(SEARCH), "Element");
  await page.fill(SEARCH, "");
  check("in the search view, beside the explorer", await page.getAttribute(".activity button[aria-pressed=true]", "title"), "Search (Ctrl+Shift+F)");
  check("in the open file's folder", await page.inputValue(FOLDER), t.path());
  await page.keyboard.type("101");
  await until("as you type: folders first, by name", tree, [
    "out.inp results|1",
    "  101",
    "inc.inp sub|1",
    "  101, 102",
    "b.bdf|1",
    "  GRID    101",
    "deck.inp|2",
    "  101, 0.",
    "  GRID 101",
    "notes.txt|1",
    "  plain 101",
  ]);
  check("the count", await said(), "6 results in 5 files");
  await app.shot("search");
  // By its exact text: Playwright's text matching would take GRID    101 too.
  await page.$$eval(".search .hit", (els) => els.find((e) => e.textContent.trim() === "GRID 101").click());
  await until("a match picked opens there, selected", async () => [await app.path(), await app.position()], [t.path("deck.inp"), "Ln 4, Col 9 (3 selected)"]);

  // Options and filters.
  await page.click(".search .option:text-is('ab')");
  await until("whole words: not in 101, 102? still", async () => (await tree()).length, 11);
  await page.fill(SEARCH, "10");
  await until("whole words only", said, "No results found.");
  await page.click(".search .option:text-is('ab')");
  await page.fill(SEARCH, "GRID\\s+1");
  await page.click(".search .option:text-is('.*')");
  await until("a regex", tree, ["i.bdf indented|1", "  GRID 1", "b.bdf|1", "  GRID    101", "deck.inp|1", "  GRID 101"]);
  await page.fill(SEARCH, "(x");
  await until("a bad one says why", said, "Invalid regular expression: unclosed group");
  await page.click(".search .option:text-is('.*')");
  await page.fill(SEARCH, "101");
  await page.click(".search button[title='Toggle Search Details']");
  await page.fill(".search #search-include", "*.inp");
  await page.fill(".search #search-exclude", "results");
  await until("files to include and to exclude", async () => (await tree()).filter((row) => !row.startsWith(" ")), ["inc.inp sub|1", "deck.inp|2"]);
  await page.fill(".search #search-include", "");
  await page.fill(".search #search-exclude", "");
  await page.fill(FOLDER, "");
  await until("no folder: it asks for one", said, "Choose a folder to search.");
  await page.fill(FOLDER, t.path());

  // An open file is searched as it is in the editor.
  await page.mouse.click(...(await app.at(1, 0)));
  await page.keyboard.type("x");
  await until("typed", () => line(2), "x101, 0.");
  await page.click(".search button[title=Refresh]");
  await until("unsaved changes included", async () => (await tree()).includes("  x101, 0."), true);
  await page.mouse.click(...(await app.at(1, 0)));
  await page.keyboard.press("Control+z");
  await until("undone", () => line(2), "101, 0.");

  // ---- Replace in Files -----------------------------------------------------------------------

  await page.keyboard.press("Control+Shift+h");
  await page.waitForSelector(REPLACE);
  await page.fill(REPLACE, "999");
  await until("what would change, shown", () => page.$$eval(".search .hit:has(del)", (els) => els.length), 6);
  await app.answerMessage("cancel");
  await page.click(".search button[title='Replace All']");
  await until("asked first", async () => (await app.messages()).at(-1)?.message, 'Replace 6 occurrences across 5 files with "999"?');
  check("cancelled: nothing changes", t.read("notes.txt"), "plain 101\n");
  await app.answerMessage("ok");
  await page.click(".search button[title='Replace All']");
  await until("replaced", said, "Replaced 6 occurrences in 5 files.");
  check("files not open are saved", [t.read("notes.txt"), t.read("sub/inc.inp"), t.read("results/out.inp")], ["plain 999\n", "*Nset\n999, 102\n", "999\n"]);
  check("an open one changes in the editor, unsaved", [await line(2), await line(4), t.read("deck.inp")], ["999, 0.", "GRID 999", "*Node\n101, 0.\n*Element\nGRID 101\n"]);
  const unsaved = (await app.tabs()).filter((tab) => tab.endsWith("●")).map((tab) => tab.replace(/^\*/, ""));
  check("both open ones, unsaved", ["b.bdf ●", "deck.inp ●"].every((tab) => unsaved.includes(tab)), true);
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+z");
  await until("in one step", () => line(4), "GRID 101");

  // ---- The activity bar ---------------------------------------------------------------------

  await page.click(".activity button[title^='Search']");
  await until("a click on the view showing hides it", () => page.locator(".sidebar.hidden").count(), 1);
  await page.keyboard.press("Control+Shift+e");
  await until("ctrl+shift+e: the explorer", async () => [await page.locator(".sidebar.hidden").count(), await page.isVisible(".explorer")], [0, true]);

  // ---- Korean ---------------------------------------------------------------------------------

  const korean = await t.launch({ locale: "ko-KR", launchPath: t.path("c.js") });
  const ko = korean.page;
  await ko.waitForSelector(".line");
  await ko.click(".menubar .title:text-matches('^편집')");
  check("the menu in Korean", await ko.$$eval(`${PANEL} .label`, (els) => els.map((e) => e.textContent.trim())), [
    "실행 취소(U)",
    "다시 실행(R)",
    "잘라내기(T)",
    "복사(C)",
    "붙여넣기(P)",
    "줄 주석 설정/해제(O)",
    "블록 주석 설정/해제(B)",
  ]);
  await ko.hover(".menubar .title:text-matches('^찾기')");
  await until("its search menu", () => ko.textContent(".menubar .title.open"), "찾기(S)");
  check("the search menu in Korean", await ko.$$eval(`${PANEL} .label`, (els) => els.map((e) => e.textContent.trim())), [
    "찾기(F)…",
    "바꾸기(R)…",
    "다음 찾기(N)",
    "이전 찾기(P)",
    "선택 항목 찾기(S)",
    "모든 항목 변경(C)",
    "파일에서 찾기(I)",
    "파일에서 바꾸기(E)",
    "줄 이동(G)…",
  ]);
  await ko.keyboard.press("Escape");
  await ko.keyboard.press("Control+Shift+f");
  await ko.waitForSelector(".search input:focus");
  await ko.keyboard.type("let");
  await until("its count", async () => (await ko.textContent(".search .said")).trim(), "파일 1개에서 결과 1개");
}
