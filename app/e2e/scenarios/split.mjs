// The editor split in two panes: each with its own tabs and its own place in a
// document, and one document showing in both at once.

const LINES = 400;
const DECK = Array.from({ length: LINES }, (_, i) => `GRID    ${i + 1}`).join("\n") + "\n";
const OTHER = "*Node\n1, 0., 0., 0.\n";
const THIRD = "*Element\nCQUAD4 here\n";
const CP949 = Buffer.from("** \xC7\xD1\xB1\xDB\n*Node\n", "latin1"); // ** 한글

export default async function (t) {
  t.write({ "deck.bdf": DECK, "other.inp": OTHER, "third.inp": THIRD, "kr.inp": CP949 });
  const app = await t.launch({ launchPath: t.path("deck.bdf"), settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".line");
  const { until, check } = t;

  const PANE = (i) => `.pane[data-pane="${i}"]`;
  const FIND = ".findbar input[placeholder=Find]";
  const paneCount = () => page.locator(".pane").count();
  const linesOf = (i) => page.$$eval(`${PANE(i)} .slot:not(.hidden) .lines .line`, (els) => els.map((e) => e.textContent));
  const topOf = async (i) => (await linesOf(i))[0];
  const firstLineOf = (i) => page.$eval(`${PANE(i)} .slot:not(.hidden) .gutter .ln`, (e) => Number(e.textContent));
  const tabsOf = (i) =>
    page.$$eval(`${PANE(i)} .strip .tab`, (els) =>
      els.map((e) => `${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}${e.classList.contains("dirty") ? " ●" : ""}`),
    );
  const focusedPane = () => page.$eval(".pane.focused", (e) => Number(e.dataset.pane));
  const keyboardIn = () => page.evaluate(() => (document.activeElement.tagName === "TEXTAREA" ? Number(document.activeElement.closest(".pane").dataset.pane) : document.activeElement.tagName));
  const rect = (i) => page.$eval(`${PANE(i)}`, (e) => {
    const { x, y, width, height } = e.getBoundingClientRect();
    return { x, y, width, height };
  });
  const at = async (i, row, col) => {
    const { x, y, lineH, cell } = await page.$eval(`${PANE(i)} .slot:not(.hidden) .lines .line`, (e) => {
      const r = e.getBoundingClientRect();
      const context = document.createElement("canvas").getContext("2d");
      context.font = getComputedStyle(e).font;
      return { x: r.x, y: r.y, lineH: r.height, cell: context.measureText("0".repeat(100)).width / 100 };
    });
    return [x + col * cell + 1, y + row * lineH + lineH / 2];
  };
  const clickIn = async (i, row, col) => page.mouse.click(...(await at(i, row, col)));
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const tabIn = (i, name) => `${PANE(i)} .strip .tab:has(.name:text-is('${name}'))`;
  const goTo = async (line) => {
    await press("Control+g");
    await page.waitForSelector(".goto input");
    await page.keyboard.type(String(line));
    await press("Enter");
    await until(`at line ${line}`, app.position, `Ln ${line}, Col 1`);
  };
  const menuItems = async (title) => {
    await page.click(`.menubar .title:text-matches('^${title}$')`);
    const items = await page.$$eval(".menubar .panel .item", (els) => els.map((e) => `${e.disabled ? "-" : ""}${e.querySelector(".check").textContent}${e.querySelector(".label").textContent.trim()}`));
    await press("Escape");
    return items;
  };

  /** The presets of View > Editor Layout that are checked. */
  const layoutShown = async () => {
    await page.click(".menubar .title:text-matches('^View$')");
    await page.click(".menubar .panel .label:text-matches('^Editor Layout$')");
    const items = await page.$$eval(".menubar .panel.sub .item", (els) => els.filter((e) => e.querySelector(".check").textContent).map((e) => e.querySelector(".label").textContent.trim()));
    await press("Escape", "Escape");
    return items;
  };

  // ---- Splitting ------------------------------------------------------------

  check("one pane to start with", await paneCount(), 1);
  await until("the view menu says so", async () => (await menuItems("View")).slice(7), ["Editor Layout", "-Move Tab to Other Pane", "-Switch Pane"]);
  await until("and its layout menu", layoutShown, ["Single"]);

  await goTo(200);
  const leftTop = await firstLineOf(0);
  check("scrolled down", leftTop > 100, true);
  await press("Control+\\");
  await until("ctrl+\\ makes two panes", paneCount, 2);
  await until("the same tab in both", async () => [await tabsOf(0), await tabsOf(1)], [["*deck.bdf"], ["*deck.bdf"]]);
  await until("the new pane has the keyboard", async () => [await focusedPane(), await keyboardIn()], [1, 1]);
  await until("and starts at the same place", async () => [await firstLineOf(1), await app.position()], [leftTop, "Ln 200, Col 1"]);

  let [left, right] = [await rect(0), await rect(1)];
  check("side by side", [left.x + left.width <= right.x + 2, left.y === right.y, left.height === right.height], [true, true, true]);
  check("each taking half", Math.abs(left.width - right.width) < 3, true);
  await app.shot("split-columns");

  // ---- Each pane has its own place -------------------------------------------

  await press("Control+Home");
  await until("this pane moves", async () => [await firstLineOf(1), await app.position()], [1, "Ln 1, Col 1"]);
  check("the other stays", await firstLineOf(0), leftTop);
  await clickIn(0, 2, 4);
  await until("a click moves the keyboard over", async () => [await focusedPane(), await keyboardIn()], [0, 0]);
  await until("the status bar follows", app.position, `Ln ${leftTop + 2}, Col 5`);
  await press("Control+2");
  await until("ctrl+2", async () => [await focusedPane(), await keyboardIn(), await app.position()], [1, 1, "Ln 1, Col 1"]);
  await press("Control+1");
  await until("ctrl+1", async () => [await focusedPane(), await keyboardIn(), await app.position()], [0, 0, `Ln ${leftTop + 2}, Col 5`]);
  await app.menu("View", "Switch Pane");
  await until("the menu switches too", async () => [await focusedPane(), await keyboardIn()], [1, 1]);

  // ---- One document in both: an edit shows in both --------------------------

  await page.keyboard.type("X");
  const leftLine = (await linesOf(0))[0];
  await until("typed here", async () => (await linesOf(1))[0], "XGRID    1");
  check("it is unsaved in both strips", [await tabsOf(0), await tabsOf(1)], [["*deck.bdf ●"], ["*deck.bdf ●"]]);
  await press("Enter");
  await until("a new line here", async () => (await linesOf(1)).slice(0, 2), ["X", "GRID    1"]);
  await until("the other pane stays on its text", () => topOf(0), leftLine);
  await until("its line numbers move", () => firstLineOf(0), leftTop + 1);
  await press("Control+1");
  await until("its caret stays on its text", app.position, `Ln ${leftTop + 3}, Col 5`);
  await press("Control+z");
  await until("undo from the other pane", async () => (await linesOf(1)).slice(0, 2), ["XGRID    1", "GRID    2"]);
  await press("Control+z");
  await until("all the way", async () => (await linesOf(1))[0], "GRID    1");
  await until("clean again", async () => [await tabsOf(0), await tabsOf(1)], [["*deck.bdf"], ["*deck.bdf"]]);
  await until("undo shows the pane it was done in where the edit was", () => firstLineOf(0), 1);

  // Looking at the same lines: each sees the other's typing at once.
  await press("Control+Home");
  await until("both at the top", async () => [await firstLineOf(0), await firstLineOf(1)], [1, 1]);
  await page.keyboard.type("hello world");
  await until("the other shows every key", async () => (await linesOf(1))[0], "hello worldGRID    1");
  await press("Control+2");
  await clickIn(1, 0, 16);
  await until("a caret after the text", app.position, "Ln 1, Col 17");
  await press("Control+1", "Home", "Shift+End", "Delete");
  await until("deleted the line's text", async () => (await linesOf(1))[0], "");
  await press("Control+2");
  await until("a caret in deleted text goes to where it was", app.position, "Ln 1, Col 1");
  await page.keyboard.type("Y");
  await until("typing there", async () => (await linesOf(0))[0], "Y");
  await press("Control+z", "Control+z", "Control+z");
  await until("undone from this pane", async () => [(await linesOf(0))[0], (await linesOf(1))[0]], ["GRID    1", "GRID    1"]);
  await until("nothing left to save", () => tabsOf(1), ["*deck.bdf"]);

  // Fast typing in one pane, the other redrawing all the time.
  const fast = "the quick brown fox jumps over the lazy dog ".repeat(4);
  await page.keyboard.type(fast);
  await until("every key arrives, in order", async () => (await linesOf(1))[0], `${fast}GRID    1`);
  await until("in both panes", async () => (await linesOf(0))[0], `${fast}GRID    1`);

  // Saved from one pane, saved in both.
  await press("Control+s");
  await until("saved", () => t.read("deck.bdf").startsWith(fast), true);
  await until("clean in both", async () => [await tabsOf(0), await tabsOf(1)], [["*deck.bdf"], ["*deck.bdf"]]);
  await press("Home", "Shift+End");
  await page.keyboard.type("GRID    1");
  await press("Control+s");
  await until("as it was", () => t.read("deck.bdf"), DECK);
  await until("clean", () => tabsOf(1), ["*deck.bdf"]);

  // A box in one pane gives way to an edit in the other, without trouble.
  await app.altDrag(await at(1, 0, 0), await at(1, 2, 4));
  await until("a box", app.position, "Ln 3 · Box 3 × 4");
  await press("Control+1");
  await page.keyboard.type("Q");
  await until("typed in the other", async () => (await linesOf(1))[0].startsWith("Q"), true);
  await press("Control+2");
  await until("the box is gone", () => page.locator(`${PANE(1)} .box`).count(), 0);
  await press("Control+z");
  await until("undone", () => tabsOf(1), ["*deck.bdf"]);
  await press("Control+1");

  // ---- Each pane has its own tabs -------------------------------------------

  await press("Control+2");
  await app.open(t.path("other.inp"));
  await until("a file opens in the pane with the keyboard", async () => [await tabsOf(0), await tabsOf(1)], [["*deck.bdf"], ["deck.bdf", "*other.inp"]]);
  await until("it shows there", () => topOf(1), "*Node");
  check("not in the other", await topOf(0), "GRID    1");
  await press("Control+1");
  await app.open(t.path("other.inp"));
  await until("a file open in the other pane: the keyboard goes there", async () => [await focusedPane(), await tabsOf(0)], [1, ["*deck.bdf"]]);
  await app.open(t.path("third.inp"));
  await until("a third file", () => tabsOf(1), ["deck.bdf", "other.inp", "*third.inp"]);
  await press("Control+Tab");
  await until("ctrl+tab stays in its pane", async () => [await tabsOf(0), await tabsOf(1)], [["*deck.bdf"], ["*deck.bdf", "other.inp", "third.inp"]]);
  await press("Control+Tab");
  await page.click(tabIn(1, "third.inp"));
  await until("a click on a tab", () => tabsOf(1), ["deck.bdf", "other.inp", "*third.inp"]);

  // A document showing elsewhere closes here without a question, and stays open.
  await press("Control+1", "Control+End");
  await page.keyboard.type("Z");
  await until("unsaved", async () => (await tabsOf(0))[0], "*deck.bdf ●");
  await page.click(tabIn(1, "deck.bdf"));
  await press("Control+End");
  await until("the hidden tab followed the edit", async () => (await linesOf(1)).at(-1), "Z");
  await press("Control+w");
  await until("closed in this pane only", async () => [await page.locator(".dialog").count(), await tabsOf(0), await tabsOf(1)], [0, ["*deck.bdf ●"], ["*other.inp", "third.inp"]]);
  await press("Control+1", "Control+w");
  await page.waitForSelector(".dialog");
  check("the last tab on it asks", await page.textContent(".dialog p"), "Save changes to deck.bdf?");
  await press("Escape");
  await until("cancelled", () => tabsOf(0), ["*deck.bdf ●"]);
  await press("Control+z");
  await until("clean", () => tabsOf(0), ["*deck.bdf"]);
  await press("Control+w");
  await until("its last tab closes the pane", paneCount, 1);
  await until("the other takes all the room", async () => [await app.tabs(), (await rect(0)).width > 900], [["*other.inp", "third.inp"], true]);
  await until("and has the keyboard", keyboardIn, 0);

  // ---- Moving tabs ------------------------------------------------------------

  await app.open(t.path("deck.bdf"));
  await goTo(300);
  const top300 = await firstLineOf(0);
  await press("Control+Alt+ArrowRight");
  await until("ctrl+alt+right moves it to a new pane", async () => [await paneCount(), await tabsOf(0), await tabsOf(1)], [2, ["other.inp", "*third.inp"], ["*deck.bdf"]]);
  await until("with the keyboard", async () => [await focusedPane(), await keyboardIn()], [1, 1]);
  await until("and its place", async () => [await firstLineOf(1), await app.position()], [top300, "Ln 300, Col 1"]);
  await press("Control+Alt+ArrowRight");
  check("no further right", await tabsOf(1), ["*deck.bdf"]);
  await press("Control+Alt+ArrowLeft");
  await until("ctrl+alt+left moves it back; the empty pane closes", async () => [await paneCount(), await app.tabs()], [1, ["other.inp", "third.inp", "*deck.bdf"]]);
  await until("still in its place", app.position, "Ln 300, Col 1");
  await app.menu("View", "Move Tab to Other Pane");
  await until("the menu does it too", async () => [await tabsOf(0), await tabsOf(1)], [["other.inp", "*third.inp"], ["*deck.bdf"]]);

  // By dragging.
  const center = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  await page.mouse.move(...(await center(tabIn(0, "third.inp"))));
  await page.mouse.down();
  await page.mouse.move(...(await center(`${PANE(1)} .editors`)), { steps: 5 });
  check("the pane it would go to shows", await page.locator(`${PANE(1)}.drop-target`).count(), 1);
  await app.shot("split-drag");
  await page.mouse.up();
  await until("drag a tab to the other pane", async () => [await tabsOf(0), await tabsOf(1)], [["*other.inp"], ["deck.bdf", "*third.inp"]]);
  check("the mark goes", await page.locator(".drop-target").count(), 0);

  await page.mouse.move(...(await center(tabIn(1, "third.inp"))));
  await page.mouse.down();
  await page.mouse.move(...(await center(`${PANE(1)} .editors`)), { steps: 5 });
  check("over its own pane, no mark", await page.locator(".drop-target").count(), 0);
  await page.mouse.up();
  await page.mouse.move(...(await center(tabIn(1, "third.inp"))));
  await page.mouse.down();
  await page.mouse.move(...(await center(".explorer")), { steps: 5 });
  await page.mouse.up();
  await until("dropped elsewhere, nothing moves", async () => [await tabsOf(0), await tabsOf(1)], [["*other.inp"], ["deck.bdf", "*third.inp"]]);
  const [cx, cy] = await center(tabIn(1, "deck.bdf"));
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 2, cy + 1);
  await page.mouse.up();
  await until("a tiny move is a click", () => tabsOf(1), ["*deck.bdf", "third.inp"]);
  await page.hover(tabIn(1, "third.inp"));
  await page.click(`${tabIn(1, "third.inp")} .close`);
  await until("its close button still works", () => tabsOf(1), ["*deck.bdf"]);
  await app.open(t.path("third.inp"));

  // From one pane: the edges of the text make the second pane, on that side.
  await press("Control+\\");
  await until("one pane, three tabs", async () => [await paneCount(), (await app.tabs()).length], [1, 3]);
  await page.click(".strip .tab:has(.name:text-is('deck.bdf'))");
  await goTo(250);
  const top250 = await firstLineOf(0);
  const zone = (side) => page.$eval(".pane.drop-target", (e) => e.dataset.side ?? "whole").catch(() => null);
  const dragToSide = async (name, fx, fy) => {
    await page.mouse.move(...(await center(`.strip .tab:has(.name:text-is('${name}'))`)));
    await page.mouse.down();
    const box = await page.locator(`.pane .editors`).first().boundingBox();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 5 });
  };

  await dragToSide("deck.bdf", 0.5, 0.5);
  check("the middle of the text makes nothing", await zone(), null);
  await page.mouse.up();
  await until("nothing changed", paneCount, 1);
  await page.mouse.move(...(await center(".strip .tab:has(.name:text-is('deck.bdf'))")));
  await page.mouse.down();
  await page.mouse.move(...(await center(".strip .tab:has(.name:text-is('other.inp'))")), { steps: 5 });
  check("nor does its own strip", await zone(), null);
  await page.mouse.up();

  await dragToSide("deck.bdf", 0.95, 0.5);
  check("the right edge shows the right half", await zone(), "right");
  await app.shot("split-drag-right");
  const half = await page.$eval(".pane.drop-target", (e) => {
    const after = getComputedStyle(e, "::after");
    return [after.left === `${e.clientWidth / 2}px`, after.right === "0px"];
  });
  check("as the half it will be", half, [true, true]);
  await page.mouse.up();
  await until("dropped: two columns, the tab on the right", async () => {
    [left, right] = [await rect(0), await rect(1)];
    return [await tabsOf(1), left.x + left.width <= right.x + 2, left.y === right.y];
  }, [["*deck.bdf"], true, true]);
  check("the rest on the left", (await tabsOf(0)).map((tab) => tab.replace("*", "")).sort(), ["other.inp", "third.inp"]);
  await until("the tab has the keyboard and its place", async () => [await focusedPane(), await keyboardIn(), await firstLineOf(1), await app.position()], [1, 1, top250, "Ln 250, Col 1"]);
  check("the mark goes", await page.locator(".drop-target").count(), 0);

  await press("Control+\\");
  await until("one pane", paneCount, 1);
  await dragToSide("deck.bdf", 0.5, 0.95);
  check("the bottom edge", await zone(), "bottom");
  await page.mouse.up();
  await until("two rows, the tab below", async () => {
    [left, right] = [await rect(0), await rect(1)];
    return [await tabsOf(1), left.y + left.height <= right.y + 2, left.x === right.x];
  }, [["*deck.bdf"], true, true]);

  await press("Control+\\");
  await until("one pane", paneCount, 1);
  await dragToSide("deck.bdf", 0.05, 0.5);
  check("the left edge", await zone(), "left");
  await page.mouse.up();
  await until("two columns, the tab on the left", async () => {
    [left, right] = [await rect(0), await rect(1)];
    return [await tabsOf(0), left.x + left.width <= right.x + 2];
  }, [["*deck.bdf"], true]);
  await until("the tab has the keyboard and its place", async () => [await focusedPane(), await keyboardIn(), await firstLineOf(0), await app.position()], [0, 0, top250, "Ln 250, Col 1"]);
  await page.keyboard.type("L");
  await until("typing goes to it", async () => (await linesOf(0)).some((line) => line.startsWith("L")), true);
  await press("Control+z");
  await until("undone", () => tabsOf(0), ["*deck.bdf"]);

  await press("Control+\\");
  await until("one pane", paneCount, 1);
  await dragToSide("deck.bdf", 0.5, 0.05);
  check("the top edge", await zone(), "top");
  await page.mouse.up();
  await until("two rows, the tab above", async () => {
    [left, right] = [await rect(0), await rect(1)];
    return [await tabsOf(0), left.y + left.height <= right.y + 2];
  }, [["*deck.bdf"], true]);

  // With two panes the whole of the other one is the target, as before.
  await page.mouse.move(...(await center(tabIn(0, "deck.bdf"))));
  await page.mouse.down();
  await page.mouse.move(...(await center(`${PANE(1)} .editors`)), { steps: 5 });
  check("two panes: the other one, whole", await zone(), "whole");
  await page.mouse.up();
  await until("back to one pane: its only tab moved", paneCount, 1);

  // A pane's only tab has nowhere to come from.
  for (const name of ["other.inp", "third.inp"]) {
    await page.hover(`.strip .tab:has(.name:text-is('${name}'))`);
    await page.click(`.strip .tab:has(.name:text-is('${name}')) .close`);
  }
  await until("one tab left", app.tabs, ["*deck.bdf"]);
  await dragToSide("deck.bdf", 0.95, 0.5);
  check("the only tab makes no split", await zone(), null);
  await page.mouse.up();
  await until("still one pane", paneCount, 1);

  // Let go outside the window's panes, nothing happens either.
  await app.open(t.path("other.inp"));
  await app.open(t.path("third.inp"));
  await page.mouse.move(...(await center(".strip .tab:has(.name:text-is('third.inp'))")));
  await page.mouse.down();
  await page.mouse.move(...(await center(".explorer")), { steps: 5 });
  check("over the explorer, no mark", await zone(), null);
  await page.mouse.up();
  await until("nothing moves", paneCount, 1);

  // Back to how the next part expects it: two columns.
  await dragToSide("deck.bdf", 0.95, 0.5);
  await page.mouse.up();
  await until("two panes again", paneCount, 2);
  await app.layout("Two Columns");
  await page.click(tabIn(0, "third.inp"));
  await press("Control+Alt+ArrowRight");
  await until("laid out for the next part", async () => [await tabsOf(0), await tabsOf(1)], [["*other.inp"], ["deck.bdf", "*third.inp"]]);

  // ---- Two rows, and the size of the panes -----------------------------------

  await page.click(tabIn(1, "deck.bdf"));
  await goTo(150);
  const top150 = await firstLineOf(1);
  await app.layout("Two Rows");
  await until("one above the other", async () => {
    [left, right] = [await rect(0), await rect(1)];
    return [left.y + left.height <= right.y + 2, left.x === right.x, left.width === right.width];
  }, [true, true, true]);
  check("the tabs stay", [await tabsOf(0), await tabsOf(1)], [["*other.inp"], ["*deck.bdf", "third.inp"]]);
  await until("the place stays", async () => [await firstLineOf(1), await app.position()], [top150, "Ln 150, Col 1"]);
  await until("each row holds what fits", async () => {
    const { paneH, lineH } = await page.$eval(`${PANE(1)} .slot:not(.hidden) .text`, (e) => ({ paneH: e.clientHeight, lineH: e.querySelector(".line").getBoundingClientRect().height }));
    return (await linesOf(1)).length === Math.floor(paneH / lineH);
  }, true);
  await app.shot("split-rows");
  check("the menu shows it", await layoutShown(), ["Two Rows"]);

  const sash = async () => center(".pane-sash");
  let [sx, sy] = await sash();
  const panesBox = await page.locator(".panes").boundingBox();
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, panesBox.y + panesBox.height * 0.25, { steps: 4 });
  await page.mouse.up();
  await until("dragging the sash resizes", async () => Math.abs((await rect(0)).height / panesBox.height - 0.25) < 0.03, true);
  await until("the lines follow", async () => {
    const { paneH, lineH } = await page.$eval(`${PANE(1)} .slot:not(.hidden) .text`, (e) => ({ paneH: e.clientHeight, lineH: e.querySelector(".line").getBoundingClientRect().height }));
    return (await linesOf(1)).length === Math.floor(paneH / lineH);
  }, true);
  [sx, sy] = await sash();
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, panesBox.y + 2, { steps: 4 });
  await page.mouse.up();
  await until("a pane does not vanish", async () => Math.abs((await rect(0)).height / panesBox.height - 0.15) < 0.02, true);
  await press("Shift+Alt+0");
  await until("flipped to columns, same share", async () => {
    const box = await page.locator(".panes").boundingBox();
    return Math.abs((await rect(0)).width / box.width - 0.15) < 0.02;
  }, true);
  [sx, sy] = await sash();
  const wide = await page.locator(".panes").boundingBox();
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(wide.x + wide.width * 0.5, sy, { steps: 4 });
  await page.mouse.up();
  await until("back to half", async () => Math.abs((await rect(0)).width / wide.width - 0.5) < 0.03, true);
  await until("the keyboard stayed", keyboardIn, 1);
  const sidebarSash = await center(".sash");
  await page.mouse.move(...sidebarSash);
  await page.mouse.down();
  await page.mouse.move(sidebarSash[0] + 30, sidebarSash[1], { steps: 3 });
  await page.mouse.up();
  await until("through resizing the explorer too", keyboardIn, 1);

  // ---- Find ---------------------------------------------------------------------

  await press("Control+1");
  await app.open(t.path("deck.bdf"));
  check("deck is shown in the other pane already", await focusedPane(), 1);
  await press("Control+Home");
  await press("Control+1");
  await page.click(tabIn(0, "other.inp"));
  await press("Control+\\");
  await until("one pane again", paneCount, 1);
  await until("the panes' tabs together, nothing closed", app.tabs, ["*other.inp", "deck.bdf", "third.inp"]);
  await app.open(t.path("deck.bdf"));
  await press("Control+\\");
  await until("split the deck again", async () => [await tabsOf(0), await tabsOf(1)], [["other.inp", "*deck.bdf", "third.inp"], ["*deck.bdf"]]);
  await press("Control+Home", "Control+1", "Control+Home");

  await press("Control+f");
  await page.waitForSelector(`${PANE(0)} ${FIND}`);
  check("the find bar is in the pane with the keyboard", await page.locator(`${PANE(1)} .findbar`).count(), 0);
  await page.keyboard.type("GRID    2");
  await until("both panes show the matches", async () => [await page.locator(`${PANE(0)} .slot:not(.hidden) .match`).count() > 0, await page.locator(`${PANE(1)} .slot:not(.hidden) .match`).count() > 0], [true, true]);
  await press("Enter");
  await until("found here", app.position, "Ln 2, Col 10 (9 selected)");
  const foundIn = (i) => page.$$eval(`${PANE(i)} .slot:not(.hidden) .found`, (els) => els.map((e) => e.textContent).join(""));
  await until("the current one only here", async () => [await foundIn(0), await foundIn(1)], ["GRID    2", ""]);
  check("the find bar stays in its pane and hides nothing", await page.evaluate((pane) => {
    const bar = document.querySelector(".findbar").getBoundingClientRect();
    const box = document.querySelector(pane).getBoundingClientRect();
    const found = document.querySelector(`${pane} .slot:not(.hidden) .found`).getBoundingClientRect();
    return [bar.left >= box.left, bar.right <= box.right, bar.bottom <= found.top];
  }, PANE(0)), [true, true, true]);
  await app.shot("split-find");
  await clickIn(1, 0, 0);
  await until("the find bar follows the keyboard", async () => [await page.locator(`${PANE(0)} .findbar`).count(), await page.locator(`${PANE(1)} .findbar`).count()], [0, 1]);
  await until("keeping what to find", () => page.inputValue(FIND), "GRID    2");
  await press("F3");
  await until("found in this pane, from its caret", async () => [await focusedPane(), await app.position()], [1, "Ln 2, Col 10 (9 selected)"]);
  await press("F3");
  await until("the next here", app.position, "Ln 20, Col 10 (9 selected)");
  await press("Control+1");
  await until("the other kept its own", app.position, "Ln 2, Col 10 (9 selected)");

  await press("Control+2", "Control+h");
  await page.waitForSelector(`${PANE(1)} .findbar input[placeholder=Replace]`);
  await page.fill(FIND, "GRID");
  await page.fill(".findbar input[placeholder=Replace]", "NODE");
  await press("Control+1");
  await goTo(120);
  const top120 = await firstLineOf(0);
  await press("Control+2");
  await page.click(`${PANE(1)} .findbar button:text-is('Replace All')`);
  await until("replace all from one pane", () => page.textContent(".findbar .status"), "Replaced 400");
  await until("the other shows it", async () => (await linesOf(0))[0], `NODE    ${top120}`);
  await until("staying on its line", () => firstLineOf(0), top120);
  await press("Escape");
  await page.mouse.click(...(await at(1, 0, 0)));
  await press("Control+z");
  await until("undone in one step, in both", async () => [(await linesOf(0))[0], await firstLineOf(0), (await tabsOf(1))[0]], [`GRID    ${top120}`, top120, "*deck.bdf"]);

  // Go to line belongs to the pane with the keyboard.
  await press("Control+1", "Control+Home");
  await press("Control+2");
  await goTo(90);
  check("the other stays", await firstLineOf(0), 1);

  // ---- The document's own changes reach both ----------------------------------

  await press("Control+\\");
  await until("one pane", paneCount, 1);
  await app.open(t.path("kr.inp"));
  await until("read as CP949", app.encoding, "CP949");
  await press("Control+\\");
  await until("split", paneCount, 2);
  await until("korean in both", async () => [await topOf(0), await topOf(1)], ["** 한글", "** 한글"]);
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('Read as')");
  await page.click(".menu button.item:has-text('Windows-1252')");
  await until("read again in both", async () => [(await topOf(0)) === "** 한글", (await topOf(0)) === (await topOf(1))], [false, true]);
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('Read as')");
  await page.click(".menu button.item:has-text('CP949')");
  await until("back in both", async () => [await topOf(0), await topOf(1)], ["** 한글", "** 한글"]);

  // Saved in another encoding, it opens anew, in both.
  await goTo(2);
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('Save as')");
  await page.click(".menu button.item:has-text('UTF-8')");
  await until("converted", app.encoding, "UTF-8");
  await until("the new text in both", async () => [await topOf(0), await topOf(1)], ["** 한글", "** 한글"]);
  check("the same tabs in the same places", (await tabsOf(0)).map((tab) => tab.replace("*", "")).sort(), ["deck.bdf", "kr.inp", "other.inp", "third.inp"].sort());
  await until("the file changed", () => t.read("kr.inp"), "** 한글\n*Node\n");
  await page.keyboard.type("x");
  await until("the two panes are still one document", async () => [(await linesOf(0))[1], (await linesOf(1))[1]], ["x*Node", "x*Node"]);
  await press("Control+z");
  await until("clean", async () => (await tabsOf(1))[0], "*kr.inp");

  // Saved under another name: both tabs say so.
  await app.answerDialog(t.path("renamed.inp"));
  await press("Control+Shift+s");
  await until("both tabs show the new name", async () => [(await tabsOf(0)).includes("*renamed.inp"), await tabsOf(1)], [true, ["*renamed.inp"]]);

  // Changed on disk and reloaded: both show the new text.
  t.write({ "renamed.inp": "** changed\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(".banner button");
  await page.click(".banner button");
  await until("reloaded in both", async () => [await topOf(0), await topOf(1)], ["** changed", "** changed"]);
  await until("the one document", async () => [(await tabsOf(0)).includes("*renamed.inp"), await tabsOf(1)], [true, ["*renamed.inp"]]);

  // ---- Back to one pane ----------------------------------------------------------

  await press("Control+1");
  await page.click(tabIn(0, "other.inp"));
  await press("Control+2");
  await app.open(t.path("third.inp"));
  await app.layout("Single");
  await until("single pane merges without a question", async () => [await paneCount(), await page.locator(".dialog").count()], [1, 0]);
  check("no tab twice", (await app.tabs()).map((tab) => tab.replace("*", "")).sort(), ["deck.bdf", "other.inp", "renamed.inp", "third.inp"]);
  await until("the keyboard is in the editor", keyboardIn, 0);

  // ---- Sessions ------------------------------------------------------------------

  await app.open(t.path("deck.bdf"));
  await press("Control+\\");
  await until("split", paneCount, 2);
  await app.layout("Two Rows");
  await app.open(t.path("other.inp"));
  await press("Control+2");
  await until("focused", focusedPane, 1);
  const tabsBefore = [await tabsOf(0), await tabsOf(1)];
  await page.waitForTimeout(100);
  await page.reload();
  await until("the panes come back", paneCount, 2);
  await until("with their tabs", async () => [await tabsOf(0), await tabsOf(1)], tabsBefore);
  await until("the direction", layoutShown, ["Two Rows"]);
  await until("and the pane with the keyboard", async () => [await focusedPane(), await keyboardIn()], [1, 1]);
  await until("a document in both is still one", async () => {
    await press("Control+Home");
    return true;
  }, true);
  await page.keyboard.type("W");
  const typedLine = (await tabsOf(1)).find((tab) => tab.startsWith("*")).replace("*", "").replace(" ●", "");
  await until("marked in every tab on it", async () => (await tabsOf(0)).concat(await tabsOf(1)).filter((tab) => tab.includes(typedLine)).every((tab) => tab.endsWith("●")), true);

  // Closing asks once about a document shown twice.
  await app.closeWindow();
  await page.waitForSelector(".dialog");
  check("one question for it", await page.textContent(".dialog p"), `Save changes to ${typedLine}?`);
  await page.click(".dialog button:has-text('Cancel')");
  await press("Control+z");
  await until("clean", async () => (await tabsOf(1)).every((tab) => !tab.endsWith("●")), true);

  // A file gone since: its pane goes too if nothing is left.
  await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("hu.session"));
    const gone = { paths: ["/no/such/file.inp"], active: "/no/such/file.inp" };
    session.layout = { direction: "columns", children: [{ node: session.layout.children[0].node, share: 0.5 }, { node: gone, share: 0.5 }] };
    session.focused = 1;
    localStorage.setItem("hu.session", JSON.stringify(session));
  });
  await page.evaluate(() => (window.onbeforeunload = null));
  const keep = await page.evaluate(() => localStorage.getItem("hu.session"));
  await page.addInitScript((session) => {
    if (!sessionStorage.getItem("e2e.seeded")) {
      sessionStorage.setItem("e2e.seeded", "1");
      localStorage.setItem("hu.session", session);
    }
  }, keep);
  await page.reload();
  await until("a pane with nothing left closes", paneCount, 1);
  await until("the rest comes back", async () => (await app.tabs()).length > 0, true);

  // ---- In Korean -----------------------------------------------------------------

  const korean = await t.launch({ settings: { language: "ko" } });
  await korean.page.waitForSelector(".empty");
  await korean.page.click(".menubar .title >> nth=3");
  check(
    "korean menu",
    (await korean.page.$$eval(".menubar .panel .label", (els) => els.map((e) => e.textContent.trim()))).slice(7),
    ["편집기 레이아웃(L)", "다른 칸으로 탭 이동(M)", "다른 칸으로 전환(W)"],
  );
}
