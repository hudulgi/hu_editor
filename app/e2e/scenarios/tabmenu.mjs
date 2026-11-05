// A tab's own menu, from a right click: it acts on that tab, showing or not.
// Also pinned tabs, which it is the way to.

const LINES = 300;
const DECK = Array.from({ length: LINES }, (_, i) => `GRID    ${i + 1}`).join("\n") + "\n";
const WIDE = "0123456789".repeat(60);

export default async function (t) {
  const { until, check } = t;
  t.write({ "deck.bdf": DECK, "a.inp": "*Node\n", "b.inp": "*Element\n", "c.inp": "*Step\n", "d.inp": "*Part\n", "wide.txt": `${WIDE}\n` });

  // ---- Which pane is next to which -------------------------------------------

  const empty = await t.launch();
  const near = await empty.page.evaluate(async () => {
    const { neighbor, presetLayout, splitAt } = await import("/src/lib/layout.ts");
    const grid = presetLayout("grid", [0, 1, 2, 3]);
    const right = presetLayout("twoRowsRight", [0, 1, 2]);
    const uneven = splitAt(presetLayout("twoColumns", [0, 1]), 1, 2, "bottom");
    const round = (root, key) => ["left", "right", "top", "bottom"].map((side) => neighbor(root, key, side));
    return { grid: [0, 1, 2, 3].map((key) => round(grid, key)), right: [0, 1, 2].map((key) => round(right, key)), uneven: round(uneven, 2), alone: round({ pane: 0 }, 0), none: neighbor(grid, 9, "left") };
  });
  check("a grid's neighbors, left right top bottom", near.grid, [[null, 1, null, 2], [0, null, null, 3], [null, 3, 0, null], [2, null, 1, null]]);
  check("beside two rows, across the whole side", near.right, [[null, 1, null, null], [0, null, null, 2], [0, null, 1, null]]);
  check("in a split pane", near.uneven, [0, null, 1, null]);
  check("no neighbors alone", near.alone, [null, null, null, null]);
  check("a pane not there", near.none, null);
  await t.close(empty);

  const app = await t.launch({ launchPath: t.path("deck.bdf"), settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".line");

  const PANE = (i) => `.pane[data-pane="${i}"]`;
  const MENU = ".drop-menu:not(.sub)";
  const SUB = ".drop-menu.sub";
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const paneCount = () => page.locator(".pane").count();
  const focused = () => page.$eval(".pane.focused", (e) => Number(e.dataset.pane));
  const keyboardIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.tagName === "TEXTAREA") return `editor ${el.closest(".pane").dataset.pane}`;
      if (el.closest(".drop-menu")) return "menu";
      return el.tagName;
    });
  /** Tabs as `*name ●`, with `~` for a preview and `^` for pinned. */
  const tabsOf = (i = 0) =>
    page.$$eval(`${PANE(i)} .strip .tab`, (els) =>
      els.map((e) => `${e.classList.contains("pinned") ? "^" : ""}${e.classList.contains("preview") ? "~" : ""}${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}${e.classList.contains("dirty") ? " ●" : ""}`),
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
  const menuOf = async (name, i = 0) => {
    await page.click(tabIn(i, name), { button: "right" });
    await page.waitForSelector(MENU);
  };
  const entries = (where = page, selector = MENU) =>
    where.$$eval(`${selector} > *`, (els) =>
      els.map((e) => {
        if (e.classList.contains("separator")) return "—";
        const item = e.matches("button") ? e : e.querySelector(":scope > button");
        return `${item.disabled ? "-" : ""}${item.querySelector(".label").textContent}${item.querySelector(".shortcut") ? `|${item.querySelector(".shortcut").textContent}` : ""}`;
      }),
    );
  const LABEL = (label) => `.drop-menu .label:text-is('${label}')`;
  const pick = (label) => page.click(LABEL(label));
  const onTab = async (name, label, i = 0) => {
    await menuOf(name, i);
    await pick(label);
  };
  /** An item of Split & Move, through the mouse. */
  const onTabSub = async (name, label, i = 0) => {
    await menuOf(name, i);
    await page.hover(LABEL("Split & Move"));
    await page.waitForSelector(SUB);
    await pick(label);
  };
  const goTo = async (line) => {
    await press("Control+g");
    await page.waitForSelector(".goto input");
    await page.keyboard.type(String(line));
    await press("Enter");
    await until(`at line ${line}`, app.position, `Ln ${line}, Col 1`);
  };
  const dontSave = () => page.click(`.dialog button:has-text("Don't Save")`);
  const reset = async () => {
    await app.layout("Single");
    await until("one pane", paneCount, 1);
    while (await page.locator(".tab.pinned").count()) {
      const count = await page.locator(".tab.pinned").count();
      await page.click(".tab.pinned >> nth=0 >> .close");
      await until("one fewer pinned", () => page.locator(".tab.pinned").count(), count - 1);
    }
    if (await page.locator(".strip .tab").count()) {
      await press("Control+k", "w");
      await page.waitForSelector(".dialog", { timeout: 300 }).then(dontSave).catch(() => {});
    }
    await until("nothing open", () => page.locator(".strip .tab").count(), 0);
  };
  const openAll = async (...names) => {
    for (const name of names) await app.open(t.path(name));
  };

  // ---- The menu ---------------------------------------------------------------

  await openAll("a.inp", "b.inp", "c.inp");
  await until("four tabs", tabsOf, ["deck.bdf", "a.inp", "b.inp", "*c.inp"]);
  const box = await page.locator(tabIn(0, "a.inp")).boundingBox();
  await page.mouse.click(box.x + 20, box.y + 10, { button: "right" });
  await page.waitForSelector(MENU);
  check("a right click does not switch to the tab", await tabsOf(), ["deck.bdf", "a.inp", "b.inp", "*c.inp"]);
  check("the menu, in its order", await entries(), [
    "Close|Ctrl+W",
    "Close Others|Ctrl+Alt+T",
    "Close to the Right",
    "Close Saved|Ctrl+K U",
    "Close All|Ctrl+K W",
    "—",
    "-Keep Open|Ctrl+K Enter",
    "Pin|Ctrl+K Shift+Enter",
    "—",
    "Split Right",
    "Split & Move|›",
    "—",
    "Move into New Window",
    "Copy into New Window|Ctrl+K O",
  ]);
  await app.shot("tabmenu");
  const place = await page.$eval(MENU, (e) => {
    const r = e.getBoundingClientRect();
    return [r.left, r.top];
  });
  check("it opens at the mouse", [Math.abs(place[0] - box.x - 20) <= 1, Math.abs(place[1] - box.y - 10) <= 1], [true, true]);
  check("it holds the keyboard", await keyboardIn(), "menu");
  await page.keyboard.type("xy");
  check("typing reaches nothing", await page.locator(".tab.dirty").count(), 0);
  await press("Escape");
  await until("escape closes it, the keyboard back in the text", async () => [await page.locator(MENU).count(), await keyboardIn()], [0, "editor 0"]);
  await menuOf("a.inp");
  const leftThen = await page.$eval(MENU, (e) => e.getBoundingClientRect().left);
  await page.click(tabIn(0, "deck.bdf"), { button: "right" });
  await until("a right click on another tab: its menu, there", async () => [await page.locator(MENU).count(), (await page.$eval(MENU, (e) => e.getBoundingClientRect().left)) < leftThen], [1, true]);
  await page.mouse.click(10, 600);
  await until("a click elsewhere closes it", () => page.locator(MENU).count(), 0);

  // By keyboard, into the submenu and back.
  await menuOf("a.inp");
  await press("ArrowDown");
  check("down goes to the first", await page.$eval(".drop-menu button:focus .label", (e) => e.textContent), "Close");
  for (let i = 0; i < 7; i++) await press("ArrowDown");
  check("past what is unavailable, to the one with more", await page.$eval(".drop-menu button:focus .label", (e) => e.textContent), "Split & Move");
  await press("ArrowRight");
  await until("right opens it", async () => [await page.locator(SUB).count(), await page.$eval(".drop-menu button:focus .label", (e) => e.textContent)], [1, "Split Up"]);
  check("the submenu", await entries(page, SUB), ["Split Up", "Split Down", "Split Left", "Split Right", "—", "Move Above", "Move Below", "Move Left", "Move Right"]);
  await app.shot("tabmenu-sub");
  await press("ArrowLeft");
  await until("left goes back", async () => [await page.locator(SUB).count(), await page.$eval(".drop-menu button:focus .label", (e) => e.textContent)], [0, "Split & Move"]);
  await press("Enter");
  await until("enter opens it too", () => page.locator(SUB).count(), 1);
  await press("Escape");
  await until("escape closes only it", async () => [await page.locator(SUB).count(), await page.locator(MENU).count()], [0, 1]);
  await press("Escape");

  // By mouse: it waits for a mouse going past other items, and fits in the window.
  await menuOf("a.inp");
  await page.hover(LABEL("Split & Move"));
  await page.waitForSelector(SUB);
  await page.hover(LABEL("Close"));
  check("it does not close at once", await page.locator(SUB).count(), 1);
  await page.hover(LABEL("Split Left"));
  await page.waitForTimeout(400);
  check("reaching it in time keeps it", await page.locator(SUB).count(), 1);
  await page.hover(LABEL("Pin"));
  await until("going elsewhere closes it soon", () => page.locator(SUB).count(), 0);
  await press("Escape");

  await page.setViewportSize({ width: 480, height: 320 });
  await page.keyboard.press("Control+b");
  await app.layout("Two Columns");
  await until("two", paneCount, 2);
  await press("Control+1");
  await menuOf("a.inp");
  await page.hover(LABEL("Split & Move"));
  await page.waitForSelector(SUB);
  await page.waitForTimeout(50);
  const inView = (selector) =>
    page.$eval(selector, (e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    });
  check("in the smallest window, the menu is in view", await inView(MENU), true);
  check("and its submenu", await inView(SUB), true);
  await app.shot("tabmenu-small");
  await press("Escape");
  await press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Control+b");
  await app.layout("Single");
  await until("one", paneCount, 1);

  // A tab at the far right: the submenu goes to the left of the menu.
  await app.layout("Two Columns");
  await press("Control+2");
  await app.open(t.path("d.inp"));
  await until("a tab on the right", () => tabsOf(1), ["*d.inp"]);
  await page.setViewportSize({ width: 800, height: 700 });
  const dBox = await page.locator(tabIn(1, "d.inp")).boundingBox();
  await page.mouse.click(dBox.x + dBox.width - 5, dBox.y + 10, { button: "right" });
  await page.waitForSelector(MENU);
  await page.hover(LABEL("Split & Move"));
  await page.waitForSelector(SUB);
  await page.waitForTimeout(50);
  const [menuLeft, subRight] = await page.evaluate(() => [document.querySelector(".drop-menu:not(.sub)").getBoundingClientRect().left, document.querySelector(".drop-menu.sub").getBoundingClientRect().right]);
  check("near the right edge it opens on the left", subRight <= menuLeft + 5, true);
  await press("Escape");
  await press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });

  // In Korean, as the words of VS Code's menu.
  const korean = await t.launch({ settings: { language: "ko" }, launchPath: t.path("a.inp") });
  await korean.page.waitForSelector(".line");
  await korean.page.click(".strip .tab", { button: "right" });
  await korean.page.waitForSelector(MENU);
  check("the menu in Korean", (await entries(korean.page)).map((item) => item.split("|")[0].replace(/^-/, "")), [
    "닫기", "기타 항목 닫기", "오른쪽에 있는 항목 닫기", "저장된 항목 닫기", "모두 닫기", "—", "열린 상태 유지", "고정", "—", "오른쪽으로 분할", "분할 및 이동", "—", "새 창으로 이동", "새 창에 복사",
  ]);
  await t.close(korean);

  // ---- Closing ----------------------------------------------------------------------

  await reset();
  const before = await app.heldDocuments();
  await openAll("deck.bdf", "a.inp", "b.inp", "c.inp");
  await onTab("a.inp", "Close");
  await until("close takes that tab; the one showing stays", tabsOf, ["deck.bdf", "b.inp", "*c.inp"]);
  await until("and lets go of its document", app.heldDocuments, before + 3);
  await page.click(tabIn(0, "b.inp"));
  await press("Control+Home");
  await page.keyboard.type("x");
  await until("unsaved", tabsOf, ["deck.bdf", "*b.inp ●", "c.inp"]);
  await page.click(tabIn(0, "c.inp"));
  await onTab("b.inp", "Close");
  await page.waitForSelector(".dialog");
  check("an unsaved tab asks", await page.textContent(".dialog p"), "Save changes to b.inp?");
  await page.click(".dialog button:has-text('Cancel')");
  await until("cancelled", async () => (await tabsOf()).includes("*b.inp ●"), true);
  await onTab("b.inp", "Close");
  await dontSave();
  await until("closed", tabsOf, ["deck.bdf", "*c.inp"]);

  await openAll("a.inp", "b.inp", "d.inp");
  await until("five tabs", tabsOf, ["deck.bdf", "c.inp", "a.inp", "b.inp", "*d.inp"]);
  await onTab("a.inp", "Close to the Right");
  await until("close to the right", tabsOf, ["deck.bdf", "c.inp", "*a.inp"]);
  await menuOf("a.inp");
  check("at the last tab it has none", (await entries()).includes("-Close to the Right"), true);
  await press("Escape");
  await openAll("b.inp", "c.inp");
  await until("four", tabsOf, ["deck.bdf", "*c.inp", "a.inp", "b.inp"]);
  await onTab("b.inp", "Close Others");
  await until("close others leaves that one, showing", tabsOf, ["*b.inp"]);
  await until("the keyboard in it", keyboardIn, "editor 0");
  await menuOf("b.inp");
  const alone = await entries();
  check("alone, nothing else to close", [alone.includes("-Close Others|Ctrl+Alt+T"), alone.includes("-Close to the Right")], [true, true]);
  await press("Escape");

  await openAll("a.inp", "c.inp");
  await press("Control+Home");
  await page.keyboard.type("y");
  await page.click(tabIn(0, "a.inp"));
  await page.keyboard.type("z");
  await until("two unsaved", () => page.locator(".tab.dirty").count(), 2);
  await page.click(tabIn(0, "b.inp"));
  await onTab("b.inp", "Close Others");
  await page.waitForSelector(".dialog");
  check("asked once about both", await page.textContent(".dialog p"), "Save changes to these 2 files?");
  await page.click(".dialog button:has-text('Cancel')");
  await until("cancelled: all stay, the keyboard in the text", async () => [(await tabsOf()).length, await keyboardIn()], [3, "editor 0"]);
  await press("Control+Alt+t");
  await page.waitForSelector(".dialog");
  await dontSave();
  await until("ctrl+alt+t closes the others of the tab showing", async () => (await tabsOf()).length, 1);

  await reset();
  await openAll("a.inp", "b.inp", "c.inp");
  await page.click(tabIn(0, "b.inp"));
  await page.keyboard.type("s");
  await until("one unsaved", () => page.locator(".tab.dirty").count(), 1);
  await onTab("a.inp", "Close Saved");
  await until("close saved, from any tab", tabsOf, ["*b.inp ●"]);
  await onTab("b.inp", "Close All");
  await page.waitForSelector(".dialog");
  await dontSave();
  await until("close all", () => page.locator(".strip .tab").count(), 0);

  // What another pane shows is not asked about.
  await openAll("a.inp", "b.inp");
  await page.click(tabIn(0, "a.inp"));
  await page.keyboard.type("q");
  await press("Control+\\");
  await until("two panes", paneCount, 2);
  await press("Control+1");
  await onTab("a.inp", "Close Others");
  await press("Control+2");
  await app.open(t.path("c.inp"));
  await until("the second pane's tabs", () => tabsOf(1), ["a.inp ●", "*c.inp"]);
  await onTab("c.inp", "Close Others", 1);
  await until("closing a document the other pane shows asks nothing", async () => [await tabsOf(1), await page.locator(".dialog").count()], [["*c.inp"], 0]);
  await until("it stays there", () => tabsOf(0), ["*a.inp ●"]);
  await press("Control+1", "Control+z");
  await until("clean", () => page.locator(".tab.dirty").count(), 0);
  await reset();

  // ---- Keep Open -------------------------------------------------------------------

  await app.open(t.path("deck.bdf"));
  await page.click(`.tree .row:has(.name:text-is('a.inp'))`);
  await until("a preview", tabsOf, ["deck.bdf", "~*a.inp"]);
  await menuOf("a.inp");
  check("keep open is available on it", (await entries()).includes("Keep Open|Ctrl+K Enter"), true);
  await pick("Keep Open");
  await until("kept", tabsOf, ["deck.bdf", "*a.inp"]);
  await press("Control+w");
  await page.click(`.tree .row:has(.name:text-is('a.inp'))`);
  await until("a preview again", tabsOf, ["deck.bdf", "~*a.inp"]);
  await press("Control+k", "Enter");
  await until("ctrl+k enter keeps it", tabsOf, ["deck.bdf", "*a.inp"]);
  check("nothing typed", await page.locator(".tab.dirty").count(), 0);
  await reset();

  // ---- Pinning -----------------------------------------------------------------------

  await openAll("wide.txt", "deck.bdf", "a.inp", "b.inp");
  await page.click(tabIn(0, "wide.txt"));
  await press("End");
  await until("scrolled sideways", () => page.$eval(`${PANE(0)} .slot:not(.hidden) .text`, (e) => e.scrollLeft > 500), true);
  const scrollLeft = await page.$eval(`${PANE(0)} .slot:not(.hidden) .text`, (e) => e.scrollLeft);
  await page.$eval(`${PANE(0)} .slot:not(.hidden) textarea`, (e) => (e.__mark = "wide"));
  await page.evaluate(() => {
    window.__slotsMoved = 0;
    new MutationObserver((records) => {
      for (const { removedNodes } of records) for (const node of removedNodes) if (node.classList?.contains("slot")) window.__slotsMoved++;
    }).observe(document.querySelector(".pane .editors"), { childList: true });
  });
  await onTab("wide.txt", "Pin");
  await until("pinned: to the front", tabsOf, ["^*wide.txt", "deck.bdf", "a.inp", "b.inp"]);
  await app.shot("tabmenu-pinned");
  await until("the keyboard stays in the text", keyboardIn, "editor 0");
  check("its editor was not moved: the same one, scrolled the same", await page.$eval(`${PANE(0)} .slot:not(.hidden)`, (e, scrollLeft) => [e.querySelector("textarea").__mark, e.querySelector(".text").scrollLeft === scrollLeft], scrollLeft), ["wide", true]);
  await menuOf("wide.txt");
  check("the menu offers the opposite", (await entries()).includes("Unpin|Ctrl+K Shift+Enter"), true);
  await press("Escape");
  await onTab("b.inp", "Pin");
  await until("the next goes after it", tabsOf, ["^*wide.txt", "^b.inp", "deck.bdf", "a.inp"]);
  check("no editor element was moved", await page.evaluate(() => window.__slotsMoved), 0);

  const shown = (name, cls) => page.$eval(`${tabIn(0, name)} .close .${cls}`, (e) => getComputedStyle(e).display);
  await page.mouse.move(5, 5);
  check("a pin in the place of the close button", [await shown("b.inp", "pin"), await shown("b.inp", "x")], ["block", "none"]);
  check("on the tab showing too", [await shown("wide.txt", "pin"), await shown("wide.txt", "x")], ["block", "none"]);
  await page.hover(tabIn(0, "wide.txt"));
  check("and with the mouse on it", [await shown("wide.txt", "pin"), await shown("wide.txt", "x")], ["block", "none"]);
  await app.shot("tabmenu-pin-icon");
  await page.mouse.move(5, 5);
  check("visible on a tab not showing", await page.$eval(`${tabIn(0, "b.inp")} .close`, (e) => getComputedStyle(e).visibility), "visible");
  check("saying what it does", await page.getAttribute(`${tabIn(0, "b.inp")} .close`, "title"), "Unpin");

  // New tabs go after those pinned, even from the first of them.
  await page.click(tabIn(0, "wide.txt"));
  await app.open(t.path("c.inp"));
  await until("a new tab goes after those pinned", tabsOf, ["^wide.txt", "^b.inp", "*c.inp", "deck.bdf", "a.inp"]);

  // Closing many leaves them.
  await onTab("deck.bdf", "Close Others");
  await until("close others leaves those pinned", tabsOf, ["^wide.txt", "^b.inp", "*deck.bdf"]);
  await app.open(t.path("a.inp"));
  await page.click(tabIn(0, "wide.txt"));
  await onTab("a.inp", "Close Others");
  await until("and shows that tab, though a pinned one was showing", tabsOf, ["^wide.txt", "^b.inp", "*a.inp"]);
  await onTab("b.inp", "Close to the Right");
  await until("close to the right too", tabsOf, ["^wide.txt", "^*b.inp"]);
  await menuOf("wide.txt");
  const pinnedEntries = await entries();
  check("with only those pinned, nothing else to close", [pinnedEntries.includes("-Close Others|Ctrl+Alt+T"), pinnedEntries.includes("-Close to the Right")], [true, true]);
  await press("Escape");
  await app.open(t.path("c.inp"));
  await onTab("c.inp", "Close Saved");
  await until("close saved too", async () => (await tabsOf()).length, 2);
  await app.open(t.path("c.inp"));
  await press("Control+k", "w");
  await until("close all too", async () => (await tabsOf()).length, 2);

  // The keyboard and the middle button do not close one; its menu does.
  await page.click(tabIn(0, "b.inp"));
  await press("Control+w");
  await until("ctrl+w goes on to the next tab", tabsOf, ["^*wide.txt", "^b.inp"]);
  await page.click(tabIn(0, "b.inp"), { button: "middle" });
  await page.waitForTimeout(50);
  check("the middle button does nothing", (await tabsOf()).length, 2);
  await app.open(t.path("c.inp"));
  await page.click(tabIn(0, "c.inp"), { button: "middle" });
  await until("on another tab it still closes", async () => (await tabsOf()).length, 2);
  await onTab("b.inp", "Close");
  await until("close in its menu does", tabsOf, ["^*wide.txt"]);
  await app.open(t.path("b.inp"));
  await page.click(`${tabIn(0, "wide.txt")} .close`);
  await until("the pin unpins it, after those still pinned", tabsOf, ["wide.txt", "*b.inp"]);
  await press("Control+k", "Shift+Enter");
  await until("ctrl+k shift+enter pins the tab showing", tabsOf, ["^*b.inp", "wide.txt"]);
  check("nothing typed", await page.locator(".tab.dirty").count(), 0);
  await press("Control+k", "Shift+Enter");
  await until("and unpins", tabsOf, ["*b.inp", "wide.txt"]);

  // Unsaved, it shows the dot until hovered.
  await onTab("b.inp", "Pin");
  await until("pinned", tabsOf, ["^*b.inp", "wide.txt"]);
  await press("Control+Home");
  await page.keyboard.type("d");
  await until("unsaved", tabsOf, ["^*b.inp ●", "wide.txt"]);
  await page.mouse.move(5, 5);
  check("the dot", [await shown("b.inp", "dot"), await shown("b.inp", "pin")], ["block", "none"]);
  await page.hover(tabIn(0, "b.inp"));
  check("the pin when hovered", [await shown("b.inp", "dot"), await shown("b.inp", "pin")], ["none", "block"]);
  await press("Control+z");
  await until("clean", () => page.locator(".tab.dirty").count(), 0);

  // A preview pinned is no preview.
  await page.click(`.tree .row:has(.name:text-is('a.inp'))`);
  await until("a preview", async () => (await tabsOf()).includes("~*a.inp"), true);
  await onTab("a.inp", "Pin");
  await until("pinned it stays", async () => (await tabsOf()).includes("^*a.inp"), true);

  // It stays pinned through a reload, a move, a merge, a restart.
  t.write({ "a.inp": "*Node 2\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(".banner button");
  await page.click(".banner button");
  await until("reloaded", async () => (await app.lines())[0], "*Node 2");
  await until("still pinned", async () => (await tabsOf()).includes("^*a.inp"), true);
  t.write({ "a.inp": "*Node\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(".banner button");
  await page.click(".banner button");
  await until("back", async () => (await app.lines())[0], "*Node");

  await until("to start", tabsOf, ["^b.inp", "^*a.inp", "wide.txt"]);
  await page.click(tabIn(0, "wide.txt"));
  await app.layout("Split Right");
  await until("two panes", paneCount, 2);
  await app.open(t.path("c.inp"));
  await until("the second pane", () => tabsOf(1), ["wide.txt", "*c.inp"]);
  await onTabSub("a.inp", "Move Right");
  await until("moved, it goes in pinned, in front", async () => [await tabsOf(0), await tabsOf(1)], [["^b.inp", "*wide.txt"], ["^*a.inp", "wide.txt", "c.inp"]]);
  await page.waitForTimeout(100);
  const beforeRestart = [await tabsOf(0), await tabsOf(1)];
  await page.reload();
  await until("after a restart, the same", async () => [await tabsOf(0), await tabsOf(1)], beforeRestart);
  await press("Control+1");
  await app.layout("Single");
  await until("merged, those pinned first", tabsOf, ["^b.inp", "^a.inp", "*wide.txt", "c.inp"]);
  await reset();

  // ---- Splitting a tab, showing or not ------------------------------------------------

  await openAll("deck.bdf", "a.inp");
  await page.click(tabIn(0, "deck.bdf"));
  await goTo(200);
  await page.click(tabIn(0, "a.inp"));
  await onTab("deck.bdf", "Split Right");
  await until("split right: that tab, on the right", async () => [await fractions(), await tabsOf(0), await tabsOf(1)], [[[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], ["*deck.bdf", "a.inp"], ["*deck.bdf"]]);
  await until("at its own place, with the keyboard", async () => [await app.position(), await keyboardIn()], ["Ln 200, Col 1", "editor 1"]);
  await app.layout("Single");
  await until("one", paneCount, 1);
  for (const [label, boxes, at] of [
    ["Split Up", [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]], 0],
    ["Split Down", [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]], 1],
    ["Split Left", [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], 0],
    ["Split Right", [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], 1],
  ]) {
    await page.click(tabIn(0, "a.inp"));
    await onTabSub("deck.bdf", label);
    await until(`${label}: where it goes`, fractions, boxes);
    await until(`${label}: that tab, its place`, async () => [await focused(), (await tabsOf(at)).at(-1), await app.position()], [at, "*deck.bdf", "Ln 200, Col 1"]);
    await app.layout("Single");
    await until("one", paneCount, 1);
  }

  // ---- Moving a tab ------------------------------------------------------------------------

  await app.open(t.path("b.inp"));
  await page.click(tabIn(0, "deck.bdf"));
  await onTabSub("deck.bdf", "Move Right");
  await until("no pane there: a new one", async () => [await fractions(), await tabsOf(1)], [[[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], ["*deck.bdf"]]);
  await until("the tab has its place and the keyboard", async () => [await app.position(), await keyboardIn()], ["Ln 200, Col 1", "editor 1"]);
  await menuOf("deck.bdf", 1);
  await page.hover(LABEL("Split & Move"));
  await page.waitForSelector(SUB);
  check("its only tab has somewhere only where a pane is", (await entries(page, SUB)).slice(5), ["-Move Above", "-Move Below", "Move Left", "-Move Right"]);
  await press("Escape", "Escape");
  await onTabSub("deck.bdf", "Move Left", 1);
  await until("next to a pane: into it; its own, left empty, goes", async () => [await paneCount(), (await tabsOf(0)).includes("*deck.bdf")], [1, true]);
  await until("still at its place", app.position, "Ln 200, Col 1");

  await onTabSub("a.inp", "Move Below");
  await until("below", async () => [await fractions(), await tabsOf(1)], [[[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]], ["*a.inp"]]);
  await onTabSub("deck.bdf", "Move Below");
  await until("into the pane below", async () => (await tabsOf(1)).includes("*deck.bdf"), true);
  await onTabSub("deck.bdf", "Move Above", 1);
  await until("and back above", async () => (await tabsOf(0)).includes("*deck.bdf"), true);
  await reset();

  // In a grid, the pane on that side.
  await app.open(t.path("a.inp"));
  await app.layout("Grid (2x2)");
  await until("four", paneCount, 4);
  await app.open(t.path("b.inp"));
  await onTabSub("b.inp", "Move Right");
  await until("to the right of the first", () => tabsOf(1), ["*b.inp"]);
  await onTabSub("b.inp", "Move Below", 1);
  await until("the second's lower neighbor, not the third", async () => [await page.locator(".pane").count(), await page.evaluate(() => [...document.querySelectorAll(".pane")].some((p) => p.querySelector(".tab .name")?.textContent === "b.inp"))], [3, true]);
  await reset();

  // ---- New windows, for that tab -----------------------------------------------------------

  await openAll("deck.bdf", "a.inp");
  await onTab("deck.bdf", "Copy into New Window");
  await until("a window", () => app.opened.length, 1);
  await app.opened[0].page.waitForSelector(".line");
  await until("with that tab, not the one that was showing", app.opened[0].tabs, ["*deck.bdf"]);
  await page.click(tabIn(0, "a.inp"));
  await onTab("deck.bdf", "Move into New Window");
  await until("another window", () => app.opened.length, 2);
  await app.opened[1].page.waitForSelector(".line");
  await until("moved there", app.opened[1].tabs, ["*deck.bdf"]);
  await until("gone here", tabsOf, ["*a.inp"]);
  await press("Control+k", "o");
  await until("ctrl+k o copies the tab showing", () => app.opened.length, 3);
  await app.opened[2].page.waitForSelector(".line");
  await until("there", app.opened[2].tabs, ["*a.inp"]);
  check("and it stays here", await tabsOf(), ["*a.inp"]);
}
