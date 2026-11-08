// What is at the right of a pane's tabs: the split button, the unlock button, and
// the more-actions menu with what it holds: the list of tabs, closing many at
// once, preview tabs and locked panes.

const LINES = 300;
const DECK = Array.from({ length: LINES }, (_, i) => `GRID    ${i + 1}`).join("\n") + "\n";

export default async function (t) {
  const { until, check } = t;
  t.write({ "deck.bdf": DECK, "a.inp": "*Node\n", "b.inp": "*Element\n", "c.inp": "*Step\n", "d.inp": "*Part\n" });
  const app = await t.launch({ launchPath: t.path("deck.bdf"), settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".line");

  const PANE = (i) => `.pane[data-pane="${i}"]`;
  const MENU = ".drop-menu";
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const paneCount = () => page.locator(".pane").count();
  const focused = () => page.$eval(".pane.focused", (e) => Number(e.dataset.pane));
  const focusedPane = () => page.$eval(".pane.focused", (e) => Number(e.dataset.pane));
  const keyboardIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.tagName === "TEXTAREA") return `editor ${el.closest(".pane").dataset.pane}`;
      if (el.closest(".drop-menu")) return "menu";
      return el.tagName;
    });
  /** Tabs as `*name ●`, with `~` for a preview. */
  const tabsOf = (i) =>
    page.$$eval(`${PANE(i)} .strip .tab`, (els) =>
      els.map((e) => `${e.classList.contains("preview") ? "~" : ""}${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}${e.classList.contains("dirty") ? " ●" : ""}`),
    );
  const tabIn = (i, name) => `${PANE(i)} .strip .tab:has(.name:text-is('${name}'))`;
  const fractions = () =>
    page.evaluate(() => {
      const room = document.querySelector(".panes").getBoundingClientRect();
      return [...document.querySelectorAll(".pane")]
        .sort((a, b) => a.dataset.pane - b.dataset.pane)
        .map((e) => {
          const box = e.getBoundingClientRect();
          return [(box.x - room.x) / room.width, (box.y - room.y) / room.height, box.width / room.width, box.height / room.height].map((v) => Math.round(v * 100) / 100);
        });
    });
  const openMore = async (i = 0) => {
    await page.click(`${PANE(i)} .actions .more`);
    await page.waitForSelector(MENU);
  };
  const entries = (where = page) =>
    where.$$eval(`${MENU} > *`, (els) =>
      els.map((e) => (e.classList.contains("separator") ? "—" : `${e.querySelector(".check").textContent}${e.querySelector(".label").textContent}${e.querySelector(".shortcut") ? `|${e.querySelector(".shortcut").textContent}` : ""}`)),
    );
  const more = async (label, i = 0) => {
    await openMore(i);
    await page.click(`${MENU} .label:text-is('${label}')`);
  };
  const row = (name) => `.tree .row:has(.name:text-is('${name}'))`;
  const position = app.position;
  const closeEverything = async () => {
    await app.layout("Single");
    await until("one pane", paneCount, 1);
    await more("Close All");
    if (await page.locator(".dialog").count()) await page.click(`.dialog button:has-text("Don't Save")`);
    await until("nothing open", () => page.locator(".strip .tab").count(), 0);
  };
  let before = 0;
  const held = async () => (await app.heldDocuments()) - before;

  // ---- The buttons --------------------------------------------------------------

  check("split and more to start with", await page.$$eval(`${PANE(0)} .actions button`, (els) => els.map((e) => e.classList[1])), ["split", "more"]);
  check("what they say", await page.$$eval(`${PANE(0)} .actions button`, (els) => els.map((e) => e.title)), ["Split Editor Right (Alt: Down)", "More Actions…"]);
  await app.shot("actions");
  await press("Control+g");
  await page.waitForSelector(".goto input");
  await page.keyboard.type("150");
  await press("Enter");
  await until("at line 150", position, "Ln 150, Col 1");
  await page.click(`${PANE(0)} .actions .split`);
  await until("the split button splits to the right", fractions, [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]);
  await until("into an empty pane, with the keyboard, for what opens next", async () => [await tabsOf(1), await focusedPane(), await keyboardIn()], [[], 1, "BODY"]);
  await app.open(t.path("a.inp"));

  await page.keyboard.down("Alt");
  await page.click(`${PANE(1)} .actions .split`);
  await page.keyboard.up("Alt");
  await until("with alt, downwards", fractions, [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]);
  await until("nothing went to the menu bar: the new pane has it", async () => [await focusedPane(), await keyboardIn()], [2, "BODY"]);

  await page.click(`${PANE(0)} .actions .split`);
  await until("a button belongs to its own pane, with the keyboard elsewhere", fractions, [[0, 0, 0.25, 1], [0.25, 0, 0.25, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]);
  await until("and takes the keyboard there", focusedPane, 1);
  await app.layout("Single");
  await until("one pane", paneCount, 1);

  // A narrow pane keeps its buttons, and the tabs scroll behind them.
  await app.open(t.path("a.inp"));
  await app.open(t.path("b.inp"));
  await app.open(t.path("c.inp"));
  await app.layout("Three Columns");
  const stays = await page.$eval(`${PANE(0)} .actions`, (e) => {
    const box = e.getBoundingClientRect();
    const pane = e.closest(".pane").getBoundingClientRect();
    return box.right <= pane.right && box.left >= pane.left;
  });
  check("in a narrow pane, the buttons stay inside it", stays, true);

  // ---- The menu ------------------------------------------------------------------

  await openMore();
  check("the menu, in its order", await entries(), [
    "Show Opened Editors",
    "—",
    "Close All|Ctrl+K W",
    "Close Saved|Ctrl+K U",
    "—",
    "✓Enable Preview Editors",
    "—",
    "Lock Group",
    "—",
    "Configure Editors",
  ]);
  await app.shot("actions-menu");
  const fits = await page.$eval(MENU, (e) => {
    const box = e.getBoundingClientRect();
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
  });
  check("it is all in the window", fits, true);
  const hangs = await page.evaluate((pane) => {
    const menu = document.querySelector(".drop-menu").getBoundingClientRect();
    const button = document.querySelector(`${pane} .actions .more`).getBoundingClientRect();
    return Math.abs(menu.top - button.bottom) < 6 && Math.abs(menu.right - button.right) < 2;
  }, PANE(0));
  check("under its button", hangs, true);
  check("it holds the keyboard", await keyboardIn(), "menu");
  const textBefore = await app.lines();
  await page.keyboard.type("xy");
  check("typing reaches nothing", await app.lines(), textBefore);
  await press("ArrowDown");
  check("down goes to the first item", await page.$eval(`${MENU} button:focus .label`, (e) => e.textContent), "Show Opened Editors");
  await press("End");
  check("end to the last", await page.$eval(`${MENU} button:focus .label`, (e) => e.textContent), "Configure Editors");
  await press("ArrowDown");
  check("and around", await page.$eval(`${MENU} button:focus .label`, (e) => e.textContent), "Show Opened Editors");
  await press("Escape");
  await until("escape closes it, the keyboard back in the text", async () => [await page.locator(MENU).count(), await keyboardIn()], [0, "editor 0"]);
  await openMore();
  await page.click(`${PANE(0)} .actions .more`);
  await until("its button closes it", () => page.locator(MENU).count(), 0);
  await openMore();
  await page.mouse.click(10, 500);
  await until("a click elsewhere closes it", () => page.locator(MENU).count(), 0);
  await press("Control+2");
  await app.open(t.path("a.inp"));
  await until("a tab in the second pane", () => tabsOf(1), ["*a.inp"]);
  await press("Control+1");
  await openMore();
  await page.click(`${PANE(1)} .actions .more`);
  await until("another pane's button moves it there", async () => [await page.locator(MENU).count(), await focused()], [1, 1]);
  await press("Escape");
  await press("Control+1");
  await openMore();
  await press("Control+b");
  await until("a shortcut closes it and acts", async () => [await page.locator(MENU).count(), await page.locator(".sidebar.hidden").count()], [0, 1]);
  await page.setViewportSize({ width: 480, height: 400 });
  await openMore();
  check("in the smallest window, without the explorer, the first of three still has it all in view", await page.$eval(MENU, (e) => e.getBoundingClientRect().left >= 0), true);
  await press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await press("Control+b");

  // While it is open, keys are for it alone: escape closes it, not the find bar behind it.
  await press("Control+f");
  await page.waitForSelector(".findbar");
  await openMore();
  await press("Escape");
  await until("the menu goes", () => page.locator(MENU).count(), 0);
  check("the find bar stays", await page.locator(".findbar").count(), 1);
  await press("Escape");
  await until("then the find bar", () => page.locator(".findbar").count(), 0);

  // Hovering marks an item without taking a resting pointer for a choice.
  await openMore();
  await page.hover(`${MENU} .label:text-is('Close Saved')`);
  check("hovering marks it", await page.$eval(`${MENU} button:focus .label`, (e) => e.textContent), "Close Saved");
  await press("Escape");

  // In Korean, as the words of VS Code's menu.
  const korean = await t.launch({ settings: { language: "ko" }, launchPath: t.path("a.inp") });
  await korean.page.waitForSelector(".line");
  check("the buttons in Korean", await korean.page.$$eval(".actions button", (els) => els.map((e) => e.title)), ["편집기 오른쪽으로 분할 (Alt: 아래쪽으로)", "기타 작업…"]);
  await korean.page.click(".actions .more");
  await korean.page.waitForSelector(MENU);
  check("the menu in Korean", await entries(korean.page), ["열려 있는 편집기 표시", "—", "모두 닫기|Ctrl+K W", "저장된 항목 닫기|Ctrl+K U", "—", "✓미리 보기 편집기 사용", "—", "그룹 잠금", "—", "편집기 구성"]);
  await t.close(korean);
  before = (await app.heldDocuments()) - 4;

  // ---- Show Opened Editors ------------------------------------------------------

  await app.layout("Single");
  await until("one pane", paneCount, 1);
  await page.click(tabIn(0, "b.inp"));
  const ROWS = ".picker .row";
  const listed = () => page.$$eval(ROWS, (els) => els.map((e) => `${e.classList.contains("selected") ? "*" : ""}${e.querySelector(".name").textContent}${e.querySelector(".mark") ? " ●" : ""}`));
  await more("Show Opened Editors");
  await until("the pane's tabs, the one showing marked", listed, ["deck.bdf", "a.inp", "*b.inp", "c.inp"]);
  await app.shot("actions-list");
  check("the keyboard in its box", await page.evaluate(() => document.activeElement.tagName), "INPUT");
  await press("ArrowDown");
  await until("down", listed, ["deck.bdf", "a.inp", "b.inp", "*c.inp"]);
  await press("ArrowDown");
  await until("and around", listed, ["*deck.bdf", "a.inp", "b.inp", "c.inp"]);
  await press("ArrowUp");
  await until("up, and around", listed, ["deck.bdf", "a.inp", "b.inp", "*c.inp"]);
  await press("Enter");
  await until("enter shows it, the keyboard back in the text", async () => [await tabsOf(0), await keyboardIn(), await page.locator(".picker").count()], [["deck.bdf", "a.inp", "b.inp", "*c.inp"], "editor 0", 0]);

  await more("Show Opened Editors");
  await page.waitForSelector(ROWS);
  await page.keyboard.type("A.I");
  await until("typing filters, in any case", listed, ["*a.inp"]);
  await page.keyboard.press("Control+w");
  await page.waitForTimeout(50);
  check("while it is open, a shortcut does nothing behind it", (await tabsOf(0)).length, 4);
  await press("Backspace", "Backspace", "Backspace");
  await page.keyboard.type("paneactions");
  await until("by the path too", listed, ["*deck.bdf", "a.inp", "b.inp", "c.inp"]);
  await page.fill(".picker input", "");
  await page.keyboard.type("nothing like this");
  await until("nothing found", () => page.textContent(".picker .none"), "No matching editor");
  await press("Enter");
  check("enter has nothing to pick", await page.locator(".picker").count(), 1);
  await press("Escape");
  await until("escape closes it, the keyboard back", async () => [await page.locator(".picker").count(), await keyboardIn(), (await tabsOf(0))[3]], [0, "editor 0", "*c.inp"]);

  await more("Show Opened Editors");
  await page.click(`${ROWS}:has(.name:text-is('a.inp'))`);
  await until("a click picks", async () => [(await tabsOf(0))[1], await keyboardIn()], ["*a.inp", "editor 0"]);
  await more("Show Opened Editors");
  await page.waitForSelector(ROWS);
  await page.mouse.click(10, 500);
  await until("a click elsewhere closes it", () => page.locator(".picker").count(), 0);

  await press("Control+1");
  await until("the keyboard in the text", keyboardIn, "editor 0");
  await page.keyboard.type("!");
  await app.splitTab();
  await until("split", paneCount, 2);
  await app.open(t.path("d.inp"));
  await more("Show Opened Editors", 1);
  await until("only the tabs of that pane, unsaved marked", listed, ["a.inp ●", "*d.inp"]);
  await press("Escape");
  await press("Control+1", "Control+z");
  await until("clean again", () => page.locator(".tab.dirty").count(), 0);

  // ---- Closing many -----------------------------------------------------------------

  await closeEverything();
  await until("no document held", held, 0);
  for (const name of ["a.inp", "b.inp", "c.inp"]) await app.open(t.path(name));
  await page.click(tabIn(0, "b.inp"));
  await press("Control+Home");
  await page.keyboard.type("q");
  await more("Close Saved");
  await until("close saved keeps what is unsaved, keys just typed included", () => tabsOf(0), ["*b.inp ●"]);
  await until("and lets go of the rest", held, 1);
  check("without a question", await page.locator(".dialog").count(), 0);

  await more("Close All");
  await page.waitForSelector(".dialog");
  check("close all asks about what is unsaved", await page.textContent(".dialog p"), "Save changes to b.inp?");
  await page.click(".dialog button:has-text('Cancel')");
  await until("cancelled: nothing closes", () => tabsOf(0), ["*b.inp ●"]);
  await until("the keyboard back", keyboardIn, "editor 0");
  await more("Close All");
  await page.click(".dialog button:has-text('Save')");
  await until("saved", () => t.read("b.inp"), "q*Element\n");
  await until("and closed", async () => [await page.locator(".strip .tab").count(), await held()], [0, 0]);
  t.write({ "b.inp": "*Element\n" });

  for (const name of ["a.inp", "b.inp", "c.inp"]) {
    await app.open(t.path(name));
    if (name !== "b.inp") await page.keyboard.type("z");
  }
  await until("two unsaved", () => page.locator(".tab.dirty").count(), 2);
  await more("Close All");
  await page.waitForSelector(".dialog");
  check("many are asked about at once", await page.textContent(".dialog p"), "Save changes to these 2 files?");
  check("by name", await page.$$eval(".dialog li", (els) => els.map((e) => e.textContent)), ["a.inp", "c.inp"]);
  await page.click(`.dialog button:has-text("Don't Save")`);
  await until("all closed, none written", async () => [await page.locator(".strip .tab").count(), t.read("a.inp"), t.read("c.inp")], [0, "*Node\n", "*Step\n"]);

  // A document that another pane shows is not asked about, and stays.
  await app.open(t.path("a.inp"));
  await page.keyboard.type("k");
  await app.splitTab();
  await until("split", paneCount, 2);
  await app.open(t.path("b.inp"));
  await more("Close All", 1);
  await until("the pane closes, no question", async () => [await paneCount(), await page.locator(".dialog").count()], [1, 0]);
  await until("the document stays, unsaved", () => tabsOf(0), ["*a.inp ●"]);
  await until("only that one held", held, 1);
  await press("Control+z");
  await until("clean", () => tabsOf(0), ["*a.inp"]);

  // ---- Ctrl+K ------------------------------------------------------------------------

  const chordShown = async () => (await page.textContent(".statusbar")).includes("(Ctrl+K)");
  await app.open(t.path("b.inp"));
  await app.open(t.path("c.inp"));
  await press("Control+k");
  await until("ctrl+k says it waits", chordShown, true);
  check("the keyboard away from the text meanwhile: an IME must not compose the next key", await keyboardIn(), "BODY");
  await press("x");
  await until("another key ends it", chordShown, false);
  await until("nothing typed, the keyboard back", async () => [await page.locator(".tab.dirty").count(), await keyboardIn()], [0, "editor 0"]);
  await page.keyboard.type("ok");
  await until("typing goes on", async () => (await app.lines())[0].startsWith("ok"), true);
  await press("Control+z");
  await until("clean", () => page.locator(".tab.dirty").count(), 0);
  await press("Control+k");
  await page.mouse.click(...(await app.at(0, 2)));
  await until("a click ends it too", chordShown, false);
  await press("w");
  await page.waitForTimeout(50);
  check("and the next key is just a key", (await app.lines())[0].startsWith("*wStep") || (await app.lines())[0].includes("w"), true);
  await press("Control+z");
  await until("clean", () => page.locator(".tab.dirty").count(), 0);

  await page.click(tabIn(0, "b.inp"));
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("u");
  await press("Control+k", "u");
  await until("ctrl+k u closes what is saved", () => tabsOf(0), ["*b.inp ●"]);
  await press("Control+k", "w");
  await page.waitForSelector(".dialog");
  await page.click(`.dialog button:has-text("Don't Save")`);
  await until("ctrl+k w closes all", () => page.locator(".strip .tab").count(), 0);
  await app.open(t.path("a.inp"));
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.press("w");
  await page.keyboard.up("Control");
  await until("with ctrl held throughout too", () => page.locator(".strip .tab").count(), 0);
  await app.open(t.path("a.inp"));
  await app.open(t.path("b.inp"));
  await press("Control+k", "Control+w");
  await until("and with ctrl pressed again for the second key", () => page.locator(".strip .tab").count(), 0);

  // ---- Locked panes ---------------------------------------------------------------------

  await app.open(t.path("a.inp"));
  await app.layout("Two Columns");
  await press("Control+2");
  await app.open(t.path("b.inp"));
  await press("Control+1");
  await more("Lock Group");
  await until("a lock shows on the pane", async () => [await page.locator(`${PANE(0)} .actions .lock`).count(), await page.locator(`${PANE(1)} .actions .lock`).count()], [1, 0]);
  check("saying how to undo it", await page.getAttribute(`${PANE(0)} .actions .lock`, "title"), "Unlock Group");
  await app.shot("actions-locked");
  await until("the keyboard back in the text", keyboardIn, "editor 0");
  await openMore();
  check("the menu says so", (await entries()).includes("✓Lock Group"), true);
  await press("Escape");
  await openMore(1);
  check("not for the other pane", (await entries()).includes("Lock Group"), true);
  await press("Escape");
  await press("Control+1");

  await page.keyboard.type("l");
  await until("a locked pane still edits", () => tabsOf(0), ["*a.inp ●"]);
  await press("Control+z");
  await until("clean", () => page.locator(".tab.dirty").count(), 0);

  await app.open(t.path("c.inp"));
  await until("a file opened from it goes to the other pane", async () => [await tabsOf(0), await tabsOf(1), await focused()], [["*a.inp"], ["b.inp", "*c.inp"], 1]);
  await press("Control+1", "Control+n");
  await until("a new file too", async () => [(await tabsOf(0)).length, (await tabsOf(1)).length, await focused()], [1, 3, 1]);
  await press("Control+w");
  await press("Control+1");
  await page.click(row("d.inp"));
  await until("a file picked in the explorer too", async () => [await tabsOf(0), (await tabsOf(1)).at(-1), await focused()], [["*a.inp"], "~*d.inp", 1]);
  await press("Control+1");
  await app.open(t.path("a.inp"));
  await until("a file it already shows stays here", async () => [await tabsOf(0), await focused()], [["*a.inp"], 0]);
  await press("Control+Alt+ArrowRight");
  check("no tab comes in from here: it moved", await paneCount(), 1);
  await until("the locked pane's last tab closed it", () => page.locator(".actions .lock").count(), 0);

  // Moved in on purpose, a tab goes in all the same.
  await app.layout("Two Columns");
  await press("Control+2");
  await app.open(t.path("deck.bdf"));
  await press("Control+1");
  await more("Lock Group");
  await until("locked", () => page.locator(`${PANE(0)} .actions .lock`).count(), 1);
  await press("Control+2");
  await press("Control+Alt+ArrowLeft");
  await until("ctrl+alt+left moves a tab into a locked pane", () => tabsOf(1).then((tabs) => tabs.includes("*deck.bdf")), false);
  await until("it is there", async () => (await tabsOf(0)).some((tab) => tab.includes("deck.bdf")), true);

  // All locked: a new pane.
  await app.layout("Two Columns");
  await press("Control+2");
  await app.open(t.path("b.inp"));
  await until("a tab in the second pane", () => tabsOf(1), ["*b.inp"]);
  await more("Lock Group", 1);
  await until("both locked", () => page.locator(".actions .lock").count(), 2);
  await press("Control+1");
  const panesBefore = await paneCount();
  await app.open(t.path("b.inp"));
  await until("with all locked, a file open elsewhere is only shown", () => paneCount(), panesBefore);
  await press("Control+1");
  t.write({ "new.inp": "*Heading\n" });
  await app.open(t.path("new.inp"));
  await until("a new file makes a new pane beside this one", async () => [await paneCount(), await focused()], [panesBefore + 1, 1]);
  await until("and it is not locked", () => page.locator(`${PANE(1)} .actions .lock`).count(), 0);

  // The button unlocks.
  await page.click(`${PANE(0)} .actions .lock`);
  await until("the button unlocks", () => page.locator(`${PANE(0)} .actions .lock`).count(), 0);
  await until("taking the keyboard to its pane", async () => [await focused(), await keyboardIn()], [0, "editor 0"]);
  t.write({ "after.inp": "*Heading\n" });
  await app.open(t.path("after.inp"));
  await until("files open here again", async () => [await focused(), (await tabsOf(0)).includes("*after.inp")], [0, true]);

  // A session keeps the lock, and a locked pane gets its own files back.
  await press("Control+2");
  await until("in the pane beside it", focused, 1);
  await press("Control+Alt+ArrowRight");
  await until("a file that only the locked pane has", async () => [await paneCount(), await tabsOf(1)], [2, ["b.inp", "*new.inp"]]);
  await page.waitForTimeout(100);
  const beforeReload = [await tabsOf(0), await tabsOf(1)];
  await page.reload();
  await until("the tabs come back where they were", async () => [await tabsOf(0), await tabsOf(1)], beforeReload);
  await until("and the lock", () => page.locator(`${PANE(1)} .actions .lock`).count(), 1);
  await closeEverything();
  await until("the lock went with its tabs", () => page.locator(".actions .lock").count(), 0);
  await app.open(t.path("a.inp"));
  await until("so the next file opens right here", async () => [await paneCount(), await tabsOf(0)], [1, ["*a.inp"]]);
  await more("Lock Group");
  await until("one pane can lock too", () => page.locator(".actions .lock").count(), 1);
  await press("Control+w");
  await until("its last tab gone", () => page.locator(".strip .tab").count(), 0);
  await app.open(t.path("b.inp"));
  await until("the lock is gone with it", async () => [await paneCount(), await tabsOf(0)], [1, ["*b.inp"]]);
  await closeEverything();

  // A blank new document in a locked pane does not give way.
  await press("Control+n");
  await until("a blank one", () => page.locator(".strip .tab").count(), 1);
  await more("Lock Group");
  await until("locked", () => page.locator(".actions .lock").count(), 1);
  await app.open(t.path("a.inp"));
  await until("the file goes to a new pane beside it", async () => [await paneCount(), (await tabsOf(0)).length, await tabsOf(1)], [2, 1, ["*a.inp"]]);
  await page.click(`${PANE(0)} .actions .lock`);
  await closeEverything();

  // ---- Preview tabs ------------------------------------------------------------------------

  await app.open(t.path("deck.bdf"));
  await app.open(t.path("c.inp"));
  await until("permanent tabs", () => tabsOf(0), ["deck.bdf", "*c.inp"]);
  const heldNow = await held();
  await page.click(tabIn(0, "deck.bdf"));
  await page.click(row("a.inp"));
  await until("a click in the explorer opens a preview next to the active tab", () => tabsOf(0), ["deck.bdf", "~*a.inp", "c.inp"]);
  check("in italics", await page.$eval(`${tabIn(0, "a.inp")} .name`, (e) => getComputedStyle(e).fontStyle), "italic");
  check("the others not", await page.$eval(`${tabIn(0, "c.inp")} .name`, (e) => getComputedStyle(e).fontStyle), "normal");
  await app.shot("actions-preview");
  await page.click(tabIn(0, "c.inp"));
  await page.click(row("b.inp"));
  await until("the next one takes its place", () => tabsOf(0), ["deck.bdf", "~*b.inp", "c.inp"]);
  await until("and the one before lets go of its document", held, heldNow + 1);
  await page.click(row("c.inp"));
  await until("a file already open is just shown", () => tabsOf(0), ["deck.bdf", "~b.inp", "*c.inp"]);
  await page.click(row("b.inp"));
  await until("the preview itself too", () => tabsOf(0), ["deck.bdf", "~*b.inp", "c.inp"]);

  await page.dblclick(tabIn(0, "b.inp"));
  await until("a double click on the tab keeps it", () => tabsOf(0), ["deck.bdf", "*b.inp", "c.inp"]);
  await page.click(row("a.inp"));
  await until("so the next is a new tab", () => tabsOf(0), ["deck.bdf", "b.inp", "~*a.inp", "c.inp"]);
  await page.dblclick(row("d.inp"));
  await until("a double click in the explorer opens one tab to stay", () => tabsOf(0), ["deck.bdf", "b.inp", "*d.inp", "c.inp"]);
  await until("the preview before it gone", async () => (await tabsOf(0)).some((tab) => tab.includes("a.inp")), false);

  await page.click(row("a.inp"));
  await until("a preview", async () => (await tabsOf(0)).includes("~*a.inp"), true);
  await press("Control+Home");
  await page.keyboard.type("e");
  await until("an edit keeps it", async () => (await tabsOf(0)).includes("*a.inp ●"), true);
  await press("Control+z");
  await until("even after undoing it", async () => (await tabsOf(0)).includes("*a.inp"), true);

  await press("Control+w");
  await page.click(row("a.inp"));
  await until("a preview again", async () => (await tabsOf(0)).includes("~*a.inp"), true);
  await press("Control+w");
  await until("a preview closed", async () => (await tabsOf(0)).some((tab) => tab.includes("a.inp")), false);
  await page.click(row("a.inp"));
  await until("leaves nothing to replace: the next is a tab of its own", async () => (await tabsOf(0)).includes("~*a.inp"), true);
  check("and none went missing", (await tabsOf(0)).length, 5);
  t.write({ "a.inp": "*Node 2\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(".banner button");
  await page.click(".banner button");
  await until("reloaded, it stays", async () => (await tabsOf(0)).includes("*a.inp"), true);
  check("with the new text", (await app.lines())[0], "*Node 2");
  const tabsThen = (await tabsOf(0)).length;
  await page.click(row("c.inp"));
  await page.click(row("a.inp"));
  check("nothing replaced it", (await tabsOf(0)).length, tabsThen);
  t.write({ "a.inp": "*Node\n" });
  await press("Control+w");
  await page.click(row("a.inp"));
  await until("a preview again", async () => (await tabsOf(0)).includes("~*a.inp"), true);
  await app.open(t.path("a.inp"));
  await until("opening it on purpose keeps it", async () => (await tabsOf(0)).includes("*a.inp"), true);

  await press("Control+w");
  await page.click(row("a.inp"));
  await until("a preview again", async () => (await tabsOf(0)).includes("~*a.inp"), true);
  await app.answerDialog(t.path("a2.inp"));
  await press("Control+Shift+s");
  await until("saving it under a name keeps it", async () => (await tabsOf(0)).includes("*a2.inp"), true);
  await press("Control+w");

  // Each pane has its own; a preview also shown elsewhere stays there.
  await closeEverything();
  await page.click(row("a.inp"));
  await until("a preview", () => tabsOf(0), ["~*a.inp"]);
  await app.splitTab();
  await until("split: the new pane has the tab to stay", async () => [await paneCount(), await tabsOf(1)], [2, ["*a.inp"]]);
  const heldInSplit = await held();
  await press("Control+1");
  await page.click(row("b.inp"));
  await until("this pane's preview gives way", () => tabsOf(0), ["~*b.inp"]);
  await until("the other pane keeps its document", async () => [await tabsOf(1), await held()], [["*a.inp"], heldInSplit + 1]);
  await press("Control+2");
  await page.keyboard.type("v");
  await until("still a document", () => tabsOf(1), ["*a.inp ●"]);
  await press("Control+z");
  await until("clean", () => page.locator(".tab.dirty").count(), 0);
  await closeEverything();

  await page.click(row("a.inp"));
  await until("a preview", () => tabsOf(0), ["~*a.inp"]);
  await app.splitTab();
  await until("two", paneCount, 2);
  await press("Control+2");
  await page.keyboard.type("w");
  await until("an edit in another pane keeps it here too", () => tabsOf(0), ["*a.inp ●"]);
  await press("Control+z");
  await until("clean", () => page.locator(".tab.dirty").count(), 0);
  await closeEverything();

  await app.open(t.path("c.inp"));
  await page.click(row("a.inp"));
  await until("a preview", () => tabsOf(0), ["c.inp", "~*a.inp"]);
  await press("Control+Alt+ArrowRight");
  await until("moved to another pane, it stays", () => tabsOf(1), ["*a.inp"]);
  await closeEverything();

  // A quick double click, the file still opening: one tab.
  const heldBefore = await held();
  await page.dblclick(row("b.inp"));
  await until("one tab to stay", () => tabsOf(0), ["*b.inp"]);
  await page.waitForTimeout(100);
  check("and no more", await tabsOf(0), ["*b.inp"]);
  check("one document", (await held()) - heldBefore, 1);

  // A session keeps which it is.
  await page.click(row("a.inp"));
  await until("a preview", () => tabsOf(0), ["b.inp", "~*a.inp"]);
  await page.waitForTimeout(100);
  await page.reload();
  await until("after a restart, still a preview", () => tabsOf(0), ["b.inp", "~*a.inp"]);
  await page.click(row("c.inp"));
  await until("replaced as before", () => tabsOf(0), ["b.inp", "~*c.inp"]);

  // Turned off: what is a preview stays, and picking opens tabs to stay.
  await openMore();
  await page.click(`${MENU} .label:text-is('Enable Preview Editors')`);
  await until("no preview left", () => tabsOf(0), ["b.inp", "*c.inp"]);
  await until("the file has it", () => app.savedSettings()?.previewEditors, false);
  await openMore();
  check("the menu says so", (await entries()).includes("Enable Preview Editors"), true);
  await press("Escape");
  await page.click(row("a.inp"));
  await until("a click opens a tab to stay", () => tabsOf(0), ["b.inp", "c.inp", "*a.inp"]);
  await page.click(row("d.inp"));
  await until("and another", () => tabsOf(0), ["b.inp", "c.inp", "a.inp", "*d.inp"]);

  // Configure Editors: the settings, where this choice is.
  await more("Configure Editors");
  await page.waitForSelector(".settings");
  await until("the settings, on the editor's page", () => page.locator(".settings label.check:has-text('preview')").count(), 1);
  await app.shot("actions-settings");
  await app.toggleSetting("Open files picked in the explorer as a preview");
  await app.okSettings();
  await until("back in the text", keyboardIn, "editor 0");
  await page.click(row("b.inp"));
  await page.click(row("a.inp"));
  await until("the same choice as the menu's", () => app.savedSettings()?.previewEditors, true);
  await closeEverything();
  await page.click(row("a.inp"));
  await until("previews again", () => tabsOf(0), ["~*a.inp"]);

  // In another window a tab starts to stay, here too.
  await app.layout("Copy Editor into New Window");
  await until("a window", () => app.opened.length, 1);
  await until("this one's preview stays now", () => tabsOf(0), ["*a.inp"]);
}
