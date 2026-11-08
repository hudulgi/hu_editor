// The menu bar, with the mouse and with the keyboard: what each item does, when
// it is available, and where the keyboard goes afterwards.

const DECK = "GRID    1       0.\nGRID    2       1.\nCQUAD4  1       1\n";

export default async function (t) {
  t.write({ "a.bdf": DECK, "b.bdf": "SOL 101\n" });
  const app = await t.launch({ settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".empty");
  const { until, check } = t;
  const SLOT = ".slot:not(.hidden)";
  const TITLE = ".menubar .title";
  const PANEL = ".menubar .panel";
  const FIND = ".findbar input[placeholder=Find]";
  // By regular expression: a marked letter splits the text for an exact match.
  const title = (name) => `${TITLE}:text-matches('^${name}$')`;
  const label = (name) => `${PANEL} .label:text-matches('^${name}$')`;
  const openMenu = async () => ((await page.locator(PANEL).count()) ? page.textContent(`${TITLE}.open`) : null);
  /** Items as `label|shortcut`, marked `-` when unavailable and `✓` when on. */
  const items = () =>
    page.$$eval(`${PANEL} .item`, (els) =>
      els.map((e) => `${e.disabled ? "-" : ""}${e.querySelector(".check").textContent}${e.querySelector(".label").textContent.trim()}|${e.querySelector(".shortcut")?.textContent ?? ""}`),
    );
  const available = async () => (await items()).filter((item) => !item.startsWith("-")).map((item) => item.split("|")[0]);
  const focusIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.tagName === "TEXTAREA") return "editor";
      if (el.matches(".title")) return `title ${el.textContent}`;
      if (el.matches(".item")) return `item ${el.querySelector(".label").textContent.trim()}`;
      return el.getAttribute("placeholder") ?? el.tagName;
    });
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const closed = () => until("the menu closes", openMenu, null);

  // ---- With nothing open ---------------------------------------------------

  check("the menus", await page.$$eval(TITLE, (els) => els.map((e) => e.textContent)), ["File", "Edit", "Selection", "Search", "View", "Help"]);
  await page.click(title("File"));
  await until("a click opens", openMenu, "File");
  check("the file menu", await items(), [
    "New Text File|Ctrl+N",
    "New File…|",
    "New Window|Ctrl+Shift+N",
    "Open…|Ctrl+O",
    "Open Folder…|",
    "Open Recent|›",
    "-Save|Ctrl+S",
    "-Save As…|Ctrl+Shift+S",
    "-Save All|Ctrl+K S",
    "-Encoding…|",
    "Auto Save|",
    "-Revert File|",
    "-Close Tab|Ctrl+W",
    "Close Window|Ctrl+Shift+W",
    "Settings…|Ctrl+,",
    "Exit|",
  ]);
  check("separators", await page.locator(`${PANEL} .separator`).count(), 6);
  await page.hover(title("Edit"));
  await until("hovering another title switches", openMenu, "Edit");
  check("no document: nothing to edit", await available(), []);
  await page.hover(title("Search"));
  await until("the search menu", openMenu, "Search");
  check("no document: only the files to search", await available(), ["Find in Files", "Replace in Files"]);
  await page.hover(title("View"));
  await until("the view menu", openMenu, "View");
  check("the view menu shows what is on", await items(), [
    "Command Palette…|Ctrl+Shift+P",
    "✓Explorer|Ctrl+B",
    "✓Line Numbers|",
    "✓Highlight Current Line|",
    "✓Syntax Highlighting|",
    "✓Field Shading|",
    "Rainbow Columns|",
    "-Open Preview|Ctrl+Shift+V",
    "-Open Preview to the Side|Ctrl+K V",
    "Editor Layout|›",
    "-Move Tab to Other Pane|Ctrl+Alt+←/→",
    "-Switch Pane|Ctrl+1…9",
  ]);
  await page.click(title("View"));
  await closed();

  // A click on an unavailable item does nothing, and the menu stays.
  await page.click(title("File"));
  await page.click(label("Save"), { force: true });
  check("an unavailable item stays", await openMenu(), "File");
  await page.mouse.click(700, 400);
  await closed();

  // ---- File ----------------------------------------------------------------

  await app.menu("File", "New Text File");
  await until("new", app.tabs, ["*Untitled-1"]);
  await until("the keyboard is in the editor", focusIn, "editor");
  await page.keyboard.type("hello");
  await until("typing after a menu", async () => (await app.lines())[0], "hello");

  await page.click(title("File"));
  await until("save is available now", available, [
    "New Text File",
    "New File…",
    "New Window",
    "Open…",
    "Open Folder…",
    "Open Recent",
    "Save",
    "Save As…",
    "Save All",
    "Encoding…",
    "Auto Save",
    "Close Tab",
    "Close Window",
    "Settings…",
    "Exit",
  ]);
  await page.mouse.click(700, 400);
  await closed();
  await app.answerDialog(t.path("new.txt"));
  await app.menu("File", "Save");
  await until("save asks for a name", app.path, t.path("new.txt"));
  await until("and writes it", () => t.read("new.txt"), "hello");

  await page.keyboard.type("!");
  await until("unsaved again", async () => (await app.status()).includes("Modified"), true);
  await app.menu("File", "Save");
  await until("save writes in place", () => t.read("new.txt"), "hello!");
  await app.answerDialog(t.path("copy.txt"));
  await app.menu("File", "Save As…");
  await until("save as", app.path, t.path("copy.txt"));

  await app.answerDialog(t.path("a.bdf"));
  await app.menu("File", "Open…");
  await until("open", app.path, t.path("a.bdf"));
  await page.waitForSelector(`${SLOT} .lines .line`);

  await app.menu("File", "Encoding…");
  await page.waitForSelector(".menu");
  await page.keyboard.press("Escape");
  await until("the encoding menu opens and closes", () => page.locator(".menu").count(), 0);

  await app.menu("File", "Settings…");
  await page.waitForSelector(".settings");
  check("settings open on their first page", await page.textContent(".settings nav button.on"), "General");
  await page.keyboard.press("Escape");
  await until("settings close", () => page.locator(".settings").count(), 0);
  await until("back in the editor", focusIn, "editor");

  await app.menu("File", "Close Tab");
  await until("close tab", app.tabs, ["*copy.txt"]);
  await app.open(t.path("a.bdf"));

  // ---- Edit ----------------------------------------------------------------

  const clickAt = async (row, col) => page.mouse.click(...(await app.at(row, col)));
  await clickAt(0, 0);
  await press("Shift+End");
  await until("a line selected", app.position, "Ln 1, Col 19 (18 selected)");
  await app.menu("Edit", "Copy");
  await until("copy", app.clipboard, "GRID    1       0.");
  await until("copying leaves the selection", app.position, "Ln 1, Col 19 (18 selected)");
  await app.menu("Edit", "Cut");
  await until("cut", async () => (await app.lines())[0], "");
  await app.menu("Edit", "Undo");
  await until("undo", async () => (await app.lines())[0], "GRID    1       0.");
  await app.menu("Edit", "Redo");
  await until("redo", async () => (await app.lines())[0], "");
  await app.menu("Edit", "Undo");
  await until("undo again", async () => (await app.lines())[0], "GRID    1       0.");
  await press("Control+End");
  await app.menu("Edit", "Paste");
  await until("paste", async () => (await app.lines()).at(-1), "GRID    1       0.");
  await until("the keyboard is in the editor", focusIn, "editor");
  await page.keyboard.type("Z");
  await until("typing right after it", async () => (await app.lines()).at(-1), "GRID    1       0.Z");
  await press("Control+z", "Control+z");
  await until("back to the original", app.lines, [...DECK.split("\n")]);

  await app.menu("Selection", "Select All");
  await until("select all", app.position, `Ln 4, Col 1 (${DECK.length} selected)`);
  await app.menu("Selection", "Column Mode");
  await until("column mode on", async () => (await app.status()).includes("COL"), true);
  await page.click(title("Selection"));
  check("it shows on", (await items()).at(-1), "✓Column Mode|Alt+C");
  await page.click(label("Column Mode"));
  await until("column mode off", async () => (await app.status()).includes("COL"), false);

  // A box stays while the menu is used, and the commands work on it.
  await app.altDrag(await app.at(0, 0), await app.at(1, 4));
  await until("a box", app.position, "Ln 2 · Box 2 × 4");
  await app.menu("Edit", "Copy");
  await until("copy a box", app.clipboard, "GRID\nGRID");
  check("the box stays", await app.position(), "Ln 2 · Box 2 × 4");
  await app.altDrag(await app.at(0, 8), await app.at(1, 9));
  await until("another box", app.position, "Ln 2 · Box 2 × 1");
  await app.menu("Edit", "Paste");
  await until("paste into a box", async () => (await app.lines()).slice(0, 2), ["GRID    GRID       0.", "GRID    GRID       1."]);
  await page.keyboard.press("Escape");
  await press("Control+z");
  await until("undone in one step", app.lines, [...DECK.split("\n")]);

  // ---- Search --------------------------------------------------------------

  await page.mouse.click(...(await app.at(2, 2)), { clickCount: 2 });
  await until("a word selected", app.position, "Ln 3, Col 7 (6 selected)");
  await app.menu("Search", "Find…");
  await until("find takes the selection", () => page.inputValue(FIND), "CQUAD4");
  await until("and has the keyboard", focusIn, "Find");
  await page.fill(FIND, "GRID");
  await clickAt(0, 0);
  await app.menu("Search", "Find Next");
  await until("find next", app.position, "Ln 1, Col 5 (4 selected)");
  await until("the keyboard stays in the editor", focusIn, "editor");
  await app.menu("Search", "Find Next");
  await until("find next again", app.position, "Ln 2, Col 5 (4 selected)");
  await app.menu("Search", "Find Previous");
  await until("find previous", app.position, "Ln 1, Col 5 (4 selected)");
  await page.mouse.click(...(await app.at(2, 2)), { clickCount: 2 });
  await app.menu("Search", "Find Selection");
  await until("find selection", () => page.inputValue(FIND), "CQUAD4");
  await page.focus(FIND);
  await page.click(title("Edit"));
  await page.keyboard.press("Escape");
  await closed();
  await until("esc gives the keyboard back to the find box", focusIn, "Find");
  await page.keyboard.press("Escape");
  await until("the find bar closes", () => page.locator(".findbar").count(), 0);

  await page.mouse.click(...(await app.at(2, 2)), { clickCount: 2 });
  await app.menu("Search", "Replace…");
  await until("replace waits for the replacement", focusIn, "Replace");
  await page.keyboard.press("Escape");
  await app.menu("Search", "Go to Line…");
  await page.waitForSelector(".goto input");
  await until("go to line has the keyboard", () => page.evaluate(() => document.activeElement.closest(".goto") !== null), true);
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await until("go to line", app.position, "Ln 2, Col 1");

  // A menu shows over the find bar.
  await press("Control+f");
  await page.waitForSelector(FIND);
  await page.setViewportSize({ width: 620, height: 500 });
  await page.click(title("Help"));
  const onTop = await page.$$eval(`${PANEL} .item`, (els) =>
    els.every((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".item") === el;
    }),
  );
  check("a menu is on top", onTop, true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Escape");
  await until("the find bar is gone", () => page.locator(".findbar").count(), 0);

  // ---- View ----------------------------------------------------------------

  await app.menu("View", "Line Numbers");
  await until("line numbers off", () => page.locator(`${SLOT} .gutter`).count(), 0);
  await until("the file has it", () => app.savedSettings()?.lineNumbers, false);
  await app.menu("View", "Line Numbers");
  await until("line numbers on", () => page.locator(`${SLOT} .gutter`).count(), 1);
  await app.menu("View", "Syntax Highlighting");
  await until("syntax off", () => app.savedSettings()?.syntaxHighlight, false);
  await until("no colors", () => page.locator(`${SLOT} .lines .card`).count(), 0);
  await app.menu("View", "Syntax Highlighting");
  await until("colors again", async () => (await page.locator(`${SLOT} .lines .card`).count()) > 0, true);
  await app.menu("View", "Highlight Current Line");
  await until("current line off", () => app.savedSettings()?.highlightLine, false);
  await app.menu("View", "Highlight Current Line");
  await app.menu("View", "Field Shading");
  await until("shading off", () => app.savedSettings()?.fieldShading, false);
  await app.menu("View", "Field Shading");
  await app.menu("View", "Explorer");
  await until("explorer off", () => page.locator(".sidebar.hidden").count(), 1);
  check("the text takes its place, beside the activity bar", (await page.locator(".panes").boundingBox()).x, 48);
  await page.click(title("View"));
  check("it shows off", (await items())[1], "Explorer|Ctrl+B");
  await page.click(label("Explorer"));
  await until("explorer on", () => page.locator(".sidebar.hidden").count(), 0);
  await until("the keyboard is in the editor", focusIn, "editor");
  const sidebar = await page.locator(".sidebar").boundingBox();
  check("the text stands clear of it", (await page.locator(".panes").boundingBox()).x - (sidebar.x + sidebar.width), 6);
  const lines = await page.$eval(".sash", (e) => getComputedStyle(e).boxShadow.match(/inset/g)?.length);
  check("with a line on each side of the space", lines, 2);

  // ---- Help ----------------------------------------------------------------

  await app.menu("Help", "Keyboard Shortcuts");
  await page.waitForSelector(".settings table");
  check("the shortcuts page", await page.textContent(".settings nav button.on"), "Shortcuts");
  await until("the list names the menu keys", async () => (await page.textContent(".settings table")).includes("Open a menu"), true);
  await page.keyboard.press("Escape");
  await app.menu("Help", "About HU Editor");
  await page.waitForSelector(".dialog");
  check("about", [await page.textContent(".dialog .product"), await page.textContent(".dialog .muted")], ["HU Editor", "Version 9.9.9"]);
  await app.shot("about");
  await until("its button has the keyboard", () => page.evaluate(() => document.activeElement.textContent), "Close");
  await press("Tab");
  check("the keyboard stays in it", await page.evaluate(() => document.activeElement.textContent), "Close");
  await press("Control+n", "Alt+f");
  await page.keyboard.type("q");
  check("everything waits", [await app.tabs(), await openMenu(), (await app.lines())[0]], [["copy.txt", "*a.bdf"], null, "GRID    1       0."]);
  await page.keyboard.press("Escape");
  await until("esc closes about", () => page.locator(".dialog").count(), 0);
  await until("back in the editor", focusIn, "editor");
  await app.menu("Help", "About HU Editor");
  await page.waitForSelector(".dialog");
  await page.keyboard.press("Enter");
  await until("enter closes about", () => page.locator(".dialog").count(), 0);

  // ---- The keyboard --------------------------------------------------------

  await clickAt(0, 0);
  await press("Alt+f");
  await until("alt+f opens with the first item", async () => [await openMenu(), await focusIn()], ["File", "item New Text File"]);
  await app.shot("menu-file");
  await press("ArrowDown");
  await until("down", focusIn, "item New File…");
  await press("ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
  await until("down to Open Recent", focusIn, "item Open Recent");
  await press("ArrowDown");
  await until("down skips what is unavailable", focusIn, "item Save As…");
  await press("ArrowUp");
  await until("up skips it too", focusIn, "item Open Recent");
  await press("End");
  await until("end", focusIn, "item Exit");
  await press("ArrowDown");
  await until("down wraps", focusIn, "item New Text File");
  await press("ArrowUp");
  await until("up wraps", focusIn, "item Exit");
  await press("Home");
  await until("home", focusIn, "item New Text File");
  await press("ArrowRight");
  await until("right opens the next menu", async () => [await openMenu(), await focusIn()], ["Edit", `item ${(await available())[0]}`]);
  await press("ArrowLeft", "ArrowLeft");
  await until("left wraps round", async () => [await openMenu(), await focusIn()], ["Help", "item Keyboard Shortcuts"]);
  await press("Escape");
  await closed();
  await until("esc gives the keyboard back", focusIn, "editor");
  await page.keyboard.type("x");
  await until("typing goes on", async () => (await app.lines())[0], "xGRID    1       0.");

  // Letters pick items; they never reach the document.
  await press("Alt+e", "u");
  await until("alt+e u: undo", async () => (await app.lines())[0], "GRID    1       0.");
  await until("and the menu closes", openMenu, null);
  await press("Alt+s", "g");
  await page.waitForSelector(".goto input");
  await page.keyboard.press("Escape");
  await press("Alt+v", "n");
  await until("alt+v n: line numbers", () => page.locator(`${SLOT} .gutter`).count(), 0);
  await press("Alt+v", "n");
  await until("back on", () => page.locator(`${SLOT} .gutter`).count(), 1);
  await press("Alt+e", "z", "q");
  check("other letters do nothing", [await openMenu(), (await app.lines())[0]], ["Edit", "GRID    1       0."]);
  await press("Alt+f");
  await until("alt+letter switches menus", openMenu, "File");
  await press("s");
  check("a letter of an unavailable item does nothing", await openMenu(), "File");
  await press("n");
  await until("alt+f n: new", app.tabs, ["copy.txt", "a.bdf", "*Untitled-2"]);
  await press("Control+w");
  await until("closed it", app.tabs, ["copy.txt", "*a.bdf"]);

  // A menu opening under a resting mouse leaves the keyboard's place alone.
  await page.mouse.move(180, 90);
  await press("Alt+v");
  await until("opened by the keyboard", openMenu, "View");
  await page.waitForTimeout(250);
  check("the mouse under it takes nothing", await focusIn(), "item Command Palette…");
  await press("ArrowDown");
  check("down goes on from there", await focusIn(), "item Explorer");
  await press("Escape");
  await page.mouse.move(1000, 700);

  // Enter and space run the item.
  await press("Alt+v", "ArrowDown", "ArrowDown", "Enter");
  await until("enter runs it", () => page.locator(`${SLOT} .gutter`).count(), 0);
  await press("Alt+v", "ArrowDown", "ArrowDown", " ");
  await until("space runs it", () => page.locator(`${SLOT} .gutter`).count(), 1);

  // Alt alone and F10 go to the titles; down opens, and they come back out.
  await press("Alt");
  await until("alt alone goes to the titles", async () => [await focusIn(), await openMenu()], ["title File", null]);
  await press("ArrowRight");
  await until("right moves along them", async () => [await focusIn(), await openMenu()], ["title Edit", null]);
  await press("ArrowLeft", "ArrowLeft");
  await until("left wraps", focusIn, "title Help");
  await press("ArrowDown");
  await until("down opens", async () => [await openMenu(), await focusIn()], ["Help", "item Keyboard Shortcuts"]);
  await press("Escape");
  await until("esc comes back", focusIn, "editor");
  await press("Alt");
  await until("alt again", focusIn, "title File");
  await press("Alt");
  await until("and alt leaves", focusIn, "editor");
  await press("F10");
  await until("f10 goes to the titles", focusIn, "title File");
  await press("v");
  await until("a letter opens one", async () => [await openMenu(), await focusIn()], ["View", "item Command Palette…"]);
  await press("F10");
  await until("f10 leaves", async () => [await focusIn(), await openMenu()], ["editor", null]);
  await press("Alt");
  await page.mouse.click(700, 400);
  await until("a click elsewhere leaves", focusIn, "editor");

  // Alt with something else is not Alt alone.
  await app.altDrag(await app.at(0, 0), await app.at(1, 4));
  await until("alt+drag makes a box", app.position, "Ln 2 · Box 2 × 4");
  await until("and stays out of the menu", focusIn, "editor");
  await press("Alt+f");
  await until("alt+f over a box", openMenu, "File");
  await press("Escape");
  check("keeps the box", await app.position(), "Ln 2 · Box 2 × 4");
  await press("Escape");
  await clickAt(0, 0);
  await press("Alt+Shift+ArrowDown");
  await until("alt+shift+down", app.position, "Ln 2 · Box 2 × 0");
  await until("stays out of the menu", focusIn, "editor");
  await press("Escape");
  await press("Alt+c");
  await until("alt+c still is column mode", async () => [(await app.status()).includes("COL"), await focusIn(), await openMenu()], [true, "editor", null]);
  await press("Alt+c");

  // A shortcut with a menu open: it closes and the shortcut acts where the keyboard was.
  await press("Alt+f", "Control+g");
  await page.waitForSelector(".goto input");
  check("the menu closed", await openMenu(), null);
  await page.keyboard.press("Escape");

  // The dialogs hold the keyboard.
  await page.keyboard.type("y");
  await press("Control+w");
  await page.waitForSelector(".dialog");
  await until("a question takes the keyboard", () => page.evaluate(() => document.activeElement.textContent), "Save");
  await press("Alt+f");
  check("it waits for its answer", await openMenu(), null);
  const typed = (await app.lines())[0];
  await page.keyboard.type("q");
  check("typing does not reach the document", (await app.lines())[0], typed);
  await press("Escape");
  await until("esc is cancel", () => page.locator(".dialog").count(), 0);
  await until("the keyboard is back", focusIn, "editor");
  await press("Control+,");
  await page.waitForSelector(".settings");
  await press("Alt+f");
  check("settings keep it", await openMenu(), null);
  await press("Alt");
  check("alt alone as well", await page.evaluate(() => document.activeElement.closest(".menubar")), null);
  await page.keyboard.press("Escape");

  // ---- Exit ----------------------------------------------------------------

  await app.menu("File", "Exit");
  await page.waitForSelector(".dialog");
  check("exit asks about unsaved changes", await page.textContent(".dialog p"), "Save changes to a.bdf?");
  await page.click(".dialog button:has-text('Cancel')");
  await until("cancel keeps the window", app.destroyed, 0);
  await press("Control+z");
  await until("no changes left", async () => (await app.tabs()).at(-1), "*a.bdf");
  await app.menu("File", "Exit");
  await until("exit closes the window", app.destroyed, 1);

  // ---- Korean --------------------------------------------------------------

  const korean = await t.launch({ settings: { language: "ko" } });
  const kp = korean.page;
  await kp.waitForSelector(".empty");
  check("korean titles", await kp.$$eval(TITLE, (els) => els.map((e) => e.textContent)), ["파일(F)", "편집(E)", "선택 영역(T)", "찾기(S)", "보기(V)", "도움말(H)"]);
  await kp.click(TITLE);
  check(
    "korean items",
    await kp.$$eval(`${PANEL} .label`, (els) => els.map((e) => e.textContent.trim())),
    [
      "새 텍스트 파일(N)",
      "새 파일(F)…",
      "새 창(W)",
      "열기(O)…",
      "폴더 열기(D)…",
      "최근 항목 열기(R)",
      "저장(S)",
      "다른 이름으로 저장(A)…",
      "모두 저장(L)",
      "인코딩(E)…",
      "자동 저장(U)",
      "파일 되돌리기(V)",
      "탭 닫기(C)",
      "창 닫기(I)",
      "설정(T)…",
      "끝내기(X)",
    ],
  );
  await korean.shot("menu-korean");
  await kp.keyboard.press("n");
  await until("the letter works", korean.tabs, ["*제목 없음-1"]);

  // English: the letter is in the word that starts with it.
  await page.click(title("File"));
  check(
    "the marked letters",
    await page.$$eval(`${PANEL} .label`, (els) => els.map((e) => `${e.querySelector("u").previousSibling?.textContent ?? ""}[${e.querySelector("u").textContent}]`)),
    ["[N]", "New [F]", "New [W]", "[O]", "Open Fol[d]", "Open [R]", "[S]", "Save [A]", "Save A[l]", "[E]", "A[u]", "Re[v]", "[C]", "Close W[i]", "Se[t]", "E[x]"],
  );
  await page.keyboard.press("Escape");
}
