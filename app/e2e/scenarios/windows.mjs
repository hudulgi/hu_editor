// A document in a window of its own: moved there or shown in both. The windows
// are pages of one browser context here, with events passed between them.

const LINES = 400;
const DECK = Array.from({ length: LINES }, (_, i) => `GRID    ${i + 1}`).join("\n") + "\n";
const CP949 = Buffer.from("** \xC7\xD1\xB1\xDB\n*Node\n", "latin1"); // ** 한글

export default async function (t) {
  const { until, check } = t;
  t.write({ "deck.bdf": DECK, "keep.inp": "*Node\n", "other.inp": "*Element\n", "moved.inp": "*Step\n", "kr.inp": CP949 });
  const app = await t.launch({ launchPath: t.path("deck.bdf"), settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".line");

  const lines = (window) => window.lines();
  const pressIn = (window, ...keys) => keys.reduce((done, key) => done.then(() => window.page.keyboard.press(key)), Promise.resolve());
  const press = (...keys) => pressIn(app, ...keys);
  const first = (window) => window.page.$eval(".pane.focused .slot:not(.hidden) .gutter .ln", (e) => Number(e.textContent));
  const dirty = (window) => window.page.locator(".strip .tab.dirty").count();
  /** How many documents the backend holds, not counting those of scenarios before this one. */
  const before = (await app.heldDocuments()) - 1;
  const documents = async () => (await app.heldDocuments()) - before;
  const goTo = async (window, line) => {
    await pressIn(window, "Control+g");
    await window.page.waitForSelector(".goto input");
    await window.page.keyboard.type(String(line));
    await pressIn(window, "Enter");
    await until(`at line ${line}`, window.position, `Ln ${line}, Col 1`);
  };
  let made = 0;
  const newWindow = async () => {
    made++;
    await until("a window opens", () => app.opened.length, made);
    const window = app.opened[made - 1];
    await window.page.waitForSelector(".line");
    return window;
  };
  const closeWindow = async (window) => {
    await window.closeWindow();
    await until("the window goes without a question", window.destroyed, 1);
    await window.page.close();
  };

  // ---- Copied: one document in two windows -----------------------------------

  await goTo(app, 200);
  const top = await first(app);
  await press("Home");
  await page.keyboard.type("A");
  await until("unsaved", () => dirty(app), 1);
  await app.layout("Copy Editor into New Window");
  const second = await newWindow();
  await until("the same tab there", second.tabs, ["*deck.bdf ●"]);
  check("still here", await app.tabs(), ["*deck.bdf ●"]);
  await until("at the same place", async () => [await first(second), await second.position()], [top, "Ln 200, Col 2"]);
  await until("with the unsaved text", async () => (await lines(second)).find((line) => line.endsWith(" 200")), "AGRID    200");
  await until("named in its title", second.title, "● deck.bdf — HU Editor");
  await app.shot("window-first");
  await second.shot("window-second");

  // Typed in either, seen in both; each keeps its own place.
  await pressIn(second, "Control+End");
  await second.page.keyboard.type("in second");
  await until("typed there", async () => (await lines(second)).at(-1), "in second");
  await until("this window keeps its lines", () => first(app), top);
  await press("Control+End");
  await until("and has the text", async () => (await lines(app)).at(-1), "in second");
  await page.keyboard.type(" and first");
  await until("typed here, seen there", async () => (await lines(second)).at(-1), "in second and first");
  await pressIn(second, "Control+z");
  await until("undo there takes it away here", async () => (await lines(app)).at(-1), "");
  await pressIn(second, "Control+z");
  await until("down to the first edit", () => dirty(app), 0);
  await until("clean there too", () => dirty(second), 0);
  await goTo(second, 5);
  const secondTop = await first(second);
  await press("Control+Home", "Enter");
  await until("a line added above it", () => first(second), secondTop + 1);
  check("it stays on its text", (await lines(second))[0], `GRID    ${secondTop}`);
  await press("Control+z");
  await until("taken away again", () => first(second), secondTop);

  // Fast typing with the other window following.
  const fast = "the quick brown fox ".repeat(6);
  await press("Control+Home");
  await pressIn(second, "Control+Home");
  await page.keyboard.type(fast);
  await until("every key arrives in order", async () => (await lines(second))[0], `${fast}GRID    1`);

  // Saved in one, saved in both.
  await pressIn(second, "Control+s");
  await until("written", () => t.read("deck.bdf").startsWith(fast), true);
  await until("clean in both", async () => [await dirty(app), await dirty(second)], [0, 0]);
  await page.keyboard.press("Home");
  await press("Shift+End");
  await page.keyboard.type("GRID    1");
  await until("the old line, there too", async () => (await lines(second))[0], "GRID    1");
  await press("Control+s");
  await until("as it was", () => t.read("deck.bdf"), DECK);
  await until("clean there too", () => dirty(second), 0);

  // Saved under another name: both say so.
  await second.answerDialog(t.path("renamed.inp"));
  await pressIn(second, "Control+Shift+s");
  await until("the new name there", second.tabs, ["*renamed.inp"]);
  await until("and here", app.tabs, ["*renamed.inp"]);
  await until("the path too", app.path, t.path("renamed.inp"));

  // Changed on disk and reloaded: a new document in both, still one.
  t.write({ "renamed.inp": "** changed\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(".banner button");
  await page.click(".banner button");
  await until("reloaded here", async () => (await lines(app))[0], "** changed");
  await until("and there", async () => (await lines(second))[0], "** changed");
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("x");
  await until("still one document", async () => (await lines(second))[0], "x** changed");
  await press("Control+z");
  await until("clean", () => dirty(second), 0);
  await until("only one document held", documents, 1);

  // Another encoding: read and converted.
  const third = await (async () => {
    await app.open(t.path("kr.inp"));
    await until("read as CP949", app.encoding, "CP949");
    await app.layout("Copy Editor into New Window");
    return newWindow();
  })();
  await until("korean there", async () => (await lines(third))[0], "** 한글");
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('Read as')");
  await page.click(".menu button.item:has-text('Windows-1252')");
  await until("read again here", app.encoding, "Windows-1252");
  await until("and there", third.encoding, "Windows-1252");
  await until("in the same way", async () => (await lines(third))[0], (await lines(app))[0]);
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('Read as')");
  await page.click(".menu button.item:has-text('CP949')");
  await until("back there", async () => (await lines(third))[0], "** 한글");
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('Save as')");
  await page.click(".menu button.item:has-text('UTF-8')");
  await until("converted here", app.encoding, "UTF-8");
  await until("and there", third.encoding, "UTF-8");
  await until("the file changed", () => t.read("kr.inp"), "** 한글\n*Node\n");
  await third.page.keyboard.press("Control+Home");
  await third.page.keyboard.type("y");
  await until("the two are still one document", async () => (await app.lines())[0], "y** 한글");
  await pressIn(third, "Control+z");
  await until("nothing unsaved", () => dirty(app), 0);

  // A window can copy on: all three hear of an edit.
  await second.layout("Copy Editor into New Window");
  const fourth = await newWindow();
  await until("a third window on it", fourth.tabs, ["*renamed.inp"]);
  await pressIn(fourth, "Control+Home");
  await fourth.page.keyboard.type("z");
  await until("the second window hears", async () => (await lines(second))[0], "z** changed");
  await page.click(".strip .tab:has(.name:text-is('renamed.inp'))");
  await until("and the first", async () => (await lines(app))[0], "z** changed");

  // ---- Closing, with others still showing it --------------------------------------

  await pressIn(fourth, "Control+w");
  await until("its tab closes without a question", fourth.tabs, []);
  check("no question", await fourth.page.locator(".dialog").count(), 0);
  await closeWindow(fourth);
  await until("still unsaved in the rest", async () => [await dirty(app), await dirty(second)], [1, 1]);
  await closeWindow(second);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("w");
  await until("the rest works on", async () => (await lines(app)).at(-1), "w");
  await press("Control+w");
  await page.waitForSelector(".dialog");
  check("the last one asks", await page.textContent(".dialog p"), "Save changes to renamed.inp?");
  await page.click(`.dialog button:has-text("Don't Save")`);
  await until("gone", async () => (await app.tabs()).includes("*renamed.inp") || (await app.tabs()).includes("renamed.inp"), false);
  await until("the document is let go of", documents, 1);
  await closeWindow(third);
  await until("a shared document stays with this window", async () => (await app.lines())[0], "** 한글");
  await press("Control+Home");
  await page.keyboard.type("v");
  await until("and still takes edits", async () => (await app.lines())[0], "v** 한글");
  await press("Control+z");
  await until("clean", () => dirty(app), 0);

  // ---- Moved: the tab goes, the document stays --------------------------------------

  await app.open(t.path("keep.inp"));
  await app.open(t.path("moved.inp"));
  await press("Control+Home");
  await page.keyboard.type("unsaved ");
  await until("unsaved", () => dirty(app), 1);
  const tabsBefore = (await app.tabs()).length;
  await app.layout("Move Editor into New Window");
  const moved = await newWindow();
  await until("it is there, unsaved", moved.tabs, ["*moved.inp ●"]);
  await until("with its text", async () => (await lines(moved))[0], "unsaved *Step");
  await until("gone from here without a question", async () => [(await app.tabs()).length, await page.locator(".dialog").count()], [tabsBefore - 1, 0]);
  await pressIn(moved, "Control+z");
  await until("its undo went along", async () => (await lines(moved))[0], "*Step");
  await until("clean", () => dirty(moved), 0);
  await moved.page.keyboard.type("again");
  await until("edits on", async () => (await lines(moved))[0], "again*Step");
  await moved.closeWindow();
  await moved.page.waitForSelector(".dialog");
  check("alone with it, the window asks", await moved.page.textContent(".dialog p"), "Save changes to moved.inp?");
  await moved.page.click(`.dialog button:has-text("Don't Save")`);
  await until("then goes", moved.destroyed, 1);
  await moved.page.close();
  await until("and lets go of it", documents, (await app.tabs()).length);

  // Moved out of a split: the other pane keeps it, in this window.
  await app.open(t.path("other.inp"));
  await press("Control+\\");
  await until("split", () => page.locator(".pane").count(), 2);
  await app.layout("Move Editor into New Window");
  const fromSplit = await newWindow();
  await until("there", fromSplit.tabs, ["*other.inp"]);
  await until("the pane it left goes", () => page.locator(".pane").count(), 1);
  await until("the other still shows it", app.path, t.path("other.inp"));
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("q");
  await until("both windows follow", async () => (await lines(fromSplit))[0], "q*Element");
  await press("Control+z");
  await until("nothing unsaved", () => dirty(fromSplit), 0);
  await closeWindow(fromSplit);

  // The only tab moved: this window stays, empty.
  for (const name of (await app.tabs()).map((tab) => tab.replace(/^\*/, ""))) {
    if (name === "other.inp") continue;
    await page.hover(`.strip .tab:has(.name:text-is('${name}'))`);
    await page.click(`.strip .tab:has(.name:text-is('${name}')) .close`);
  }
  await until("one tab", app.tabs, ["*other.inp"]);
  await app.layout("Move Editor into New Window");
  const alone = await newWindow();
  await until("it moved", alone.tabs, ["*other.inp"]);
  await until("this window is empty", () => page.locator(".pane .empty").count(), 1);
  check("the title says so", await app.title(), "HU Editor");
  await closeWindow(alone);
  await until("nothing held any more", documents, 0);

  // ---- Choices are shared; the session is the first window's ---------------------

  await app.open(t.path("keep.inp"));
  await app.layout("Copy Editor into New Window");
  const peer = await newWindow();
  await peer.page.waitForSelector(".gutter");
  await pressIn(peer, "Alt+v", "n");
  await until("a setting changed there", () => peer.page.locator(".gutter").count(), 0);
  await until("reaches this window", () => page.locator(".pane.focused .gutter").count(), 0);
  await until("and the file", () => app.savedSettings()?.lineNumbers, false);
  await press("Alt+v", "n");
  await until("and back the other way", () => peer.page.locator(".gutter").count(), 1);
  await until("the file again", () => app.savedSettings()?.lineNumbers, true);
  const session = () => page.evaluate(() => localStorage.getItem("hu.session"));
  const kept = await session();
  await peer.layout("Three Columns");
  await until("three panes there", () => peer.page.locator(".pane").count(), 3);
  await page.waitForTimeout(100);
  check("the session stays this window's", await session(), kept);
  await closeWindow(peer);

  // ---- When no window can be made ----------------------------------------------------

  await press("Control+Home");
  await page.keyboard.type("n");
  await until("unsaved", () => dirty(app), 1);
  await page.evaluate(() => (window.__e2e.failWindow = true));
  await app.layout("Move Editor into New Window");
  await until("it says so", () => page.textContent(".notice"), "no more windows");
  check("the tab stays", await app.tabs(), ["*keep.inp ●"]);
  await page.click(".notice");
  await press("Control+w");
  await page.waitForSelector(".dialog");
  check("still alone with it: it asks", await page.textContent(".dialog p"), "Save changes to keep.inp?");
  await page.click(`.dialog button:has-text("Don't Save")`);
  await until("nothing held", documents, 0);
}
