// The text's own menu, from a right click; the command palette; rainbow columns.

const ABAQUS = "*Node\n1, 0., 0., 0.\n2, 1.5, 2.5, 3.5\n*Element, type=C3D8R\n1, 1, 2, 3, 4, 5, 6, 7, 8\n";
const NASTRAN = "GRID    1       0       0.      1.      2.\nGRID*   2               0               0.\n*       1.              2.\nCQUAD4,1,2,3,4,5,6\n$ comment\n";
const CSV = 'name,value,"a, b",4\nx,1,"q",z\n';
const WORDS = "GRID    1\nGRIDX   2\nCQUAD4  GRID\n";

export default async function (t) {
  const { until, check } = t;
  t.write({ "deck.inp": ABAQUS, "deck.bdf": NASTRAN, "table.csv": CSV, "table.tsv": "a\tb\tc\n", "words.bdf": WORDS });

  // ---- Fields, by themselves ---------------------------------------------------

  const empty = await t.launch();
  const fields = await empty.page.evaluate(async () => {
    const { fieldAt, tokenizeLines } = await import("/src/lib/syntax.ts");
    const classes = (line, lang) => tokenizeLines([line], lang).tokens[0].map((token) => `${token.cls}:${token.text}`);
    let random = 99;
    const next = (n) => (random = (random * 48271) % 2147483647) % n;
    const pieces = ["1", ",", " ", '"', "\t", "*", "GRID", "0.5", "ab", "$", "="];
    let lost = 0;
    for (let i = 0; i < 4000; i++) {
      const line = Array.from({ length: next(12) }, () => pieces[next(pieces.length)]).join("");
      for (const lang of ["abaqus", "nastran", "csv", "tsv"]) {
        if (tokenizeLines([line], lang).tokens[0].map((token) => token.text).join("") !== line) lost++;
      }
    }
    return {
      lost,
      abaqus: classes("1, 0., 2.5", "abaqus"),
      keyword: classes("*Node, nset=A", "abaqus"),
      small: classes("GRID    1       0       0.", "nastran"),
      free: classes("CQUAD4,1,2", "nastran"),
      csv: classes('x,"a, b",3', "csv"),
      tsv: classes("a\tb", "tsv"),
      at: [
        fieldAt("abaqus", "1, 0., 2.5", 0),
        fieldAt("abaqus", "1, 0., 2.5", 7),
        fieldAt("abaqus", "*Node", 2),
        fieldAt("nastran", "GRID    1       0", 3),
        fieldAt("nastran", "GRID    1       0", 8),
        fieldAt("nastran", "GRID    1       0", 17),
        fieldAt("nastran", "GRID    1       0       1.      2.      3.      4.      5.      6.      +A", 76),
        fieldAt("nastran", "GRID*   2               0               0.", 8),
        fieldAt("nastran", "GRID*   2               0               0.", 30),
        fieldAt("nastran", "GRID*   2               0               0.               1.              +B", 75),
        fieldAt("nastran", "CQUAD4,1,2", 9),
        fieldAt("nastran", "$ comment", 3),
        fieldAt("nastran", "SOL 101", 4),
        fieldAt("csv", 'x,"a, b",3', 5),
        fieldAt("csv", 'x,"a, b",3', 9),
        fieldAt("tsv", "a\tb", 2),
        fieldAt("plain", "a,b", 2),
      ],
    };
  });
  check("no field splitting loses a character", fields.lost, 0);
  check("an Abaqus data line, field by field", fields.abaqus, ["rb0:1", "punct:,", "rb1: 0.", "punct:,", "rb2: 2.5"]);
  check("its keyword lines as before", fields.keyword, ["keyword:*Node", "punct:, ", "param:nset", "punct:=", "value:A"]);
  check("Nastran small fields", fields.small, ["card:GRID    ", "fa rb1:1       ", "fb rb2:0       ", "fa rb3:0."]);
  check("Nastran free fields", fields.free, ["card:CQUAD4", "punct:,", "fa rb1:1", "punct:,", "fb rb2:2"]);
  check("CSV, a quoted separator inside its field", fields.csv, ["rb0:x", "punct:,", 'rb1:"a, b"', "punct:,", "rb2:3"]);
  check("TSV", fields.tsv, ["rb0:a", "punct:\t", "rb1:b"]);
  check("the field under a column", fields.at, [1, 3, null, 1, 2, 3, 10, 2, 3, 6, 3, null, null, 2, 3, 2, null]);
  await t.close(empty);

  const app = await t.launch({ launchPath: t.path("deck.inp"), settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".line");
  const MENU = ".drop-menu:not(.sub)";
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const keyboardIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.tagName === "TEXTAREA") return "editor";
      if (el.closest(".drop-menu")) return "menu";
      if (el.closest(".picker")) return "picker";
      return el.getAttribute("placeholder") ?? el.tagName;
    });
  const entries = (where = page) =>
    where.$$eval(`${MENU} > *`, (els) =>
      els.map((e) => {
        if (e.classList.contains("separator")) return "—";
        return `${e.disabled ? "-" : ""}${e.querySelector(".check").textContent}${e.querySelector(".label").textContent}${e.querySelector(".shortcut") ? `|${e.querySelector(".shortcut").textContent}` : ""}`;
      }),
    );
  const menuAt = async (row, col, where = app) => {
    await where.page.mouse.click(...(await where.at(row, col)), { button: "right" });
    await where.page.waitForSelector(MENU);
  };
  const pick = (label) => page.click(`.drop-menu .label:text-is('${label}')`);
  const fieldShown = () => page.$eval(".statusbar .field", (e) => e.textContent).catch(() => null);

  // ---- The menu ------------------------------------------------------------------

  await menuAt(1, 3);
  check("the menu, in its order", await entries(), [
    "Change All Occurrences|Ctrl+F2",
    "—",
    "Cut|Ctrl+X",
    "Copy|Ctrl+C",
    "Paste|Ctrl+V",
    "—",
    "Command Palette…|Ctrl+Shift+P",
    "—",
    "Rainbow Columns",
  ]);
  await app.shot("textmenu");
  const [x, y] = await app.at(1, 3);
  check("it opens at the mouse", await page.$eval(MENU, (e, [x, y]) => {
    const r = e.getBoundingClientRect();
    return Math.abs(r.left - x) <= 1 && Math.abs(r.top - y) <= 1;
  }, [x, y]), true);
  check("it holds the keyboard", await keyboardIn(), "menu");
  await until("the right click put the caret there", app.position, "Ln 2, Col 4");
  await press("Escape");
  await until("escape: the keyboard back in the text", keyboardIn, "editor");

  // Inside the selection, the selection stays; outside, the caret moves.
  await page.mouse.dblclick(...(await app.at(2, 4)));
  await until("a word selected", app.position, "Ln 3, Col 7 (3 selected)");
  await menuAt(2, 5);
  check("a right click on it keeps it", await app.position(), "Ln 3, Col 7 (3 selected)");
  await press("Escape");
  await menuAt(0, 2);
  await until("one elsewhere moves the caret", app.position, "Ln 1, Col 3");
  await press("Escape");

  // Cut, copy, paste.
  await page.mouse.dblclick(...(await app.at(2, 4)));
  await menuAt(2, 4);
  await pick("Copy");
  await until("copy", app.clipboard, "1.5");
  await menuAt(2, 4);
  await pick("Cut");
  await until("cut", async () => [await app.clipboard(), (await app.lines())[2]], ["1.5", "2, , 2.5, 3.5"]);
  await menuAt(0, 5);
  await pick("Paste");
  await until("paste where the right click was", async () => (await app.lines())[0], "*Node1.5");
  await press("Control+z", "Control+z");
  await until("undone", app.lines, ABAQUS.split("\n"));
  await menuAt(1, 2);
  await pick("Copy");
  await until("nothing selected: the whole line", app.clipboard, "1, 0., 0., 0.\n");
  await until("the keyboard back in the text", keyboardIn, "editor");

  // In Korean.
  const korean = await t.launch({ settings: { language: "ko" }, launchPath: t.path("deck.inp") });
  await korean.page.waitForSelector(".line");
  await menuAt(0, 1, korean);
  check("in Korean", (await entries(korean.page)).map((item) => item.split("|")[0]), ["모든 항목 변경", "—", "잘라내기", "복사", "붙여넣기", "—", "명령 팔레트…", "—", "열 색 구분"]);
  await t.close(korean);

  // ---- Change All Occurrences ---------------------------------------------------------

  await app.open(t.path("words.bdf"));
  await page.mouse.click(...(await app.at(0, 2)));
  await menuAt(0, 2);
  await pick("Change All Occurrences");
  await page.waitForSelector(".findbar input[placeholder=Replace]");
  await until("the word at the caret is what to find", () => page.inputValue(".findbar input[placeholder=Find]"), "GRID");
  await until("the keyboard on what to put instead", keyboardIn, "Replace");
  await page.keyboard.type("NODE");
  await press("Control+Alt+Enter");
  await until("all of it changed, in one go", app.lines, ["NODE    1", "NODEX   2", "CQUAD4  NODE", ""]);
  await press("Escape");
  await press("Control+z");
  await until("one undo", app.lines, WORDS.split("\n"));
  await page.mouse.dblclick(...(await app.at(1, 8)));
  await press("Control+F2");
  await until("ctrl+f2, from a selection", () => page.inputValue(".findbar input[placeholder=Find]"), "2");
  await press("Escape");
  await app.menu("Search", "Change All Occurrences");
  await until("and in the search menu", keyboardIn, "Replace");
  await press("Escape");

  // ---- The command palette ------------------------------------------------------------

  const names = () => page.$$eval(".picker .row .name", (els) => els.map((e) => e.textContent));
  const marked = () => page.$$eval(".picker .row", (els) => els.filter((e) => e.querySelector(".mark")).map((e) => e.querySelector(".name").textContent));
  await press("Control+Shift+p");
  await page.waitForSelector(".picker input");
  await app.shot("palette");
  check("the keyboard in it", await keyboardIn(), "picker");
  const all = await names();
  check("the menu bar's commands", ["File: Save As…", "Search: Change All Occurrences", "View: Editor Layout: Two Columns", "Help: About HU Editor"].filter((name) => !all.includes(name)), []);
  check("the pane's and the tab's", ["Pane: Lock Group", "Pane: Close All", "Tab: Pin", "Tab: Close Others"].every((name) => all.includes(name)), true);
  check("each once", all.length, new Set(all).size);
  check("nothing that is somewhere else already", ["Tab: Close All", "Tab: Split Right", "Tab: Copy into New Window", "Pane: Cut"].some((name) => all.includes(name)), false);
  check("nothing unavailable", all.includes("Edit: Undo"), false);
  check("what is on is marked", (await marked()).includes("View: Line Numbers"), true);
  check("with its keys", await page.$eval(".picker .row:has(.name:text-is('File: Save As…')) .shortcut", (e) => e.textContent), "Ctrl+Shift+S");
  await page.keyboard.type("col two");
  await until("words in any order", names, ["View: Editor Layout: Two Columns", "View: Editor Layout: Two Columns Bottom"]);
  await press("Enter");
  await until("enter runs it", () => page.locator(".pane").count(), 2);
  await until("the keyboard back", keyboardIn, "editor");
  await press("F1");
  await page.waitForSelector(".picker input");
  await page.keyboard.type("single");
  await press("Alt");
  check("alt alone stays in it, away from the menu bar", await keyboardIn(), "picker");
  await press("Control+w");
  await page.waitForTimeout(50);
  check("its keys stay in it", (await app.tabs()).length > 0, true);
  await press("Enter");
  await until("f1 too", () => page.locator(".pane").count(), 1);
  await page.keyboard.type("q");
  await press("F1");
  await page.waitForSelector(".picker input");
  await until("undo is there now", async () => (await names()).includes("Edit: Undo"), true);
  await press("Escape");
  await until("escape closes it", async () => [await page.locator(".picker").count(), await keyboardIn()], [0, "editor"]);
  await press("Control+z");
  await menuAt(0, 1);
  await pick("Command Palette…");
  await page.waitForSelector(".picker input");
  await press("Escape");
  await app.menu("View", "Command Palette…");
  await page.waitForSelector(".picker input");
  await press("Escape");

  const koreanPalette = await t.launch({ settings: { language: "ko" }, launchPath: t.path("deck.inp") });
  await koreanPalette.page.waitForSelector(".line");
  await koreanPalette.page.keyboard.press("Control+Shift+p");
  await koreanPalette.page.waitForSelector(".picker input");
  const koreanNames = await koreanPalette.page.$$eval(".picker .row .name", (els) => els.map((e) => e.textContent));
  check("in Korean", ["보기: 편집기 레이아웃: 두 개 열", "칸: 그룹 잠금", "탭: 고정"].every((name) => koreanNames.includes(name)), true);
  await t.close(koreanPalette);

  // ---- Rainbow columns ---------------------------------------------------------------------

  await page.click(".strip .tab:has(.name:text-is('deck.inp'))");
  const colorsOf = (row) => page.$$eval(".pane.focused .slot:not(.hidden) .lines .line", (els, row) => [...els[row].querySelectorAll("span")].filter((s) => s.textContent.trim() && s.textContent !== ",").map((s) => getComputedStyle(s).color), row);
  const distinct = async (row) => new Set(await colorsOf(row)).size;
  check("off to start with: one color for a data line", await distinct(2), 1);
  check("and no field shown", await fieldShown(), null);
  await menuAt(2, 4);
  await pick("Rainbow Columns");
  await until("on: a color for each field", () => distinct(2), 4);
  await app.shot("rainbow");
  const keyword = await colorsOf(0);
  check("keyword lines as before", keyword.length, 1);
  await until("the file has it", () => app.savedSettings()?.rainbowColumns, true);
  await menuAt(2, 4);
  check("the menu says so", (await entries()).includes("✓Rainbow Columns"), true);
  await press("Escape");
  await until("the field at the caret", fieldShown, "Field 2");
  await press("End");
  await until("follows the caret", fieldShown, "Field 4");
  await press("ArrowUp", "ArrowUp");
  await until("none on a keyword line", fieldShown, null);

  await app.open(t.path("deck.bdf"));
  await until("Nastran fields: the card's name and five of its own", () => distinct(0), 6);
  await page.mouse.click(...(await app.at(0, 17)));
  await until("small field 3", fieldShown, "Field 3");
  await page.mouse.click(...(await app.at(1, 25)));
  await until("large field 3", fieldShown, "Field 3");
  await page.mouse.click(...(await app.at(3, 9)));
  await until("free field 3", fieldShown, "Field 3");

  await app.open(t.path("table.csv"));
  await until("a CSV file", app.language, "CSV");
  check("with its badge", await page.textContent(".strip .tab.active .badge"), "CS");
  await until("its fields", () => distinct(0), 4);
  await page.mouse.click(...(await app.at(0, 13)));
  await until("a quoted separator does not count", fieldShown, "Field 3");
  await app.open(t.path("table.tsv"));
  await until("TSV", async () => [await app.language(), await distinct(0)], ["TSV", 3]);

  await app.menu("View", "Rainbow Columns");
  await until("off from the view menu", async () => [await distinct(0), await fieldShown()], [1, null]);
  await app.openSettings("Editor");
  await app.toggleSetting("Rainbow columns");
  await app.closeSettings();
  await until("on from the settings", () => distinct(0), 3);
}
