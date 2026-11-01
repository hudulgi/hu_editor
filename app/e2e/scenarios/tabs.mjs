// Tabs: each keeps its own text, caret and size; closing asks about changes.

const SETUP = {
  "a.inp": "*Heading\n** deck a\n*Node\n1, 0., 0., 0.",
  "b.bdf": "SOL 101\nCEND\nBEGIN BULK\nGRID    1       0.      0.      0.\nENDDATA\n",
  "sub/a.inp": "*Heading\n** sub a\n",
  "long.bdf": `${"GRID    1\n".repeat(300)}`,
};

export default async function (t) {
  t.write(SETUP);
  const app = await t.launch();
  const { page } = app;
  await page.waitForSelector(".empty");
  const { until, check } = t;
  const tab = (name) => `.strip .tab:has-text('${name}')`;
  const open = async (path) => {
    await page.fill(".address input", path);
    await page.press(".address input", "Enter");
  };

  // Two files, two tabs, the newest active; opening an open file switches to it.
  await open(t.path("a.inp"));
  await until("first tab", app.tabs, ["*a.inp"]);
  await open(t.path("b.bdf"));
  await until("second tab", app.tabs, ["a.inp", "*b.bdf"]);
  await open(t.path("a.inp"));
  await until("opening an open file switches to it", app.tabs, ["*a.inp", "b.bdf"]);

  // Each keeps its text, caret and edits; clicking a tab leaves the keyboard in the editor.
  await page.click(tab("b.bdf"));
  await page.click(tab("a.inp"));
  await page.keyboard.press("Control+End");
  await page.keyboard.type("X");
  await until("edit in a", async () => [(await app.lines()).at(-1), await app.position()], ["1, 0., 0., 0.X", "Ln 4, Col 15"]);
  await until("a is marked changed", app.tabs, ["*a.inp ●", "b.bdf"]);
  await page.click(tab("b.bdf"));
  await until("b shows its own text and caret", async () => [(await app.lines())[0], await app.position()], ["SOL 101", "Ln 1, Col 1"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.click(tab("a.inp"));
  await until("back in a, the caret is where it was", app.position, "Ln 4, Col 15");
  await page.click(tab("b.bdf"));
  await until("and b's too", app.position, "Ln 3, Col 1");

  // Keyboard switching.
  await page.keyboard.press("Control+Tab");
  await until("ctrl+tab", app.tabs, ["*a.inp ●", "b.bdf"]);
  await page.keyboard.press("Control+Shift+Tab");
  await until("ctrl+shift+tab", app.tabs, ["a.inp ●", "*b.bdf"]);
  await page.keyboard.press("Control+PageDown");
  await until("ctrl+pagedown wraps", app.tabs, ["*a.inp ●", "b.bdf"]);

  // New documents open next to the active tab; same names show their folder.
  await page.keyboard.press("Control+n");
  await until("ctrl+n", app.tabs, ["a.inp ●", "*Untitled-1", "b.bdf"]);
  await open(t.path("sub/a.inp"));
  const folder = t.dir.split(/[\\/]/).pop();
  await until("a blank tab gives way; same names show their folder", app.tabs, [`a.inp (${folder}) ●`, "*a.inp (sub)", "b.bdf"]);
  await app.shot("tabs");

  // A hidden tab keeps its rows, and follows a window resize.
  await app.open(t.path("long.bdf"));
  await until("the long file is showing", async () => (await app.lines())[0], "GRID    1");
  const rows = (await app.lines()).length;
  check("a long file fills the pane", rows > 20, true);
  await page.click(tab("b.bdf"));
  await page.click(tab("long.bdf"));
  await until("a tab comes back with all its rows", async () => (await app.lines()).length, rows);
  await page.click(tab("b.bdf"));
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.click(tab("long.bdf"));
  await until("and fits a window resized while it was hidden", async () => (await app.lines()).length < rows, true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await until("and a larger one", async () => (await app.lines()).length, rows);
  await page.keyboard.press("Control+w");

  // Closing: a clean tab just closes; one with changes asks.
  await page.click(tab("sub"));
  await page.keyboard.press("Control+w");
  await until("ctrl+w closes a clean tab, its right neighbour takes over", app.tabs, ["a.inp ●", "*b.bdf"]);
  await page.hover(tab("a.inp"));
  await page.click(`${tab("a.inp")} .close`);
  await page.waitForSelector(".dialog");
  check("closing a changed tab asks", await page.textContent(".dialog p"), "Save changes to a.inp?");
  await page.click(".dialog button:has-text('Cancel')");
  await until("cancel keeps it", app.tabs, ["*a.inp ●", "b.bdf"]);

  // Closing the window asks once about every changed file.
  await page.click(tab("b.bdf"));
  await page.keyboard.type("Y");
  await until("two changed tabs", app.tabs, ["a.inp ●", "*b.bdf ●"]);
  await app.closeWindow();
  await page.waitForSelector(".dialog");
  check("one prompt lists both", await page.$$eval(".dialog li", (els) => els.map((e) => e.textContent)), ["a.inp", "b.bdf"]);
  check("with Save All", await page.textContent(".dialog .primary"), "Save All");
  await page.click(".dialog button:has-text('Cancel')");
  await page.waitForTimeout(200);
  check("cancel keeps the window", await app.destroyed(), 0);

  // Middle click closes; Don't Save drops the edits.
  await page.click(tab("b.bdf"), { button: "middle" });
  await page.waitForSelector(".dialog");
  await page.click(".dialog button:has-text(\"Don't Save\")");
  await until("middle click closed b", app.tabs, ["*a.inp ●"]);
  check("b is untouched on disk", t.read("b.bdf"), SETUP["b.bdf"]);
  await page.keyboard.press("Control+z");
  await until("a has no changes left", app.tabs, ["*a.inp"]);

  // Dropping files opens them.
  await app.drop([t.path("b.bdf")]);
  await until("a dropped file opens", app.tabs, ["a.inp", "*b.bdf"]);

  // The open files come back after a restart.
  await page.click(tab("a.inp"));
  await page.waitForTimeout(100);
  await page.reload();
  await until("session restored, same tab active", app.tabs, ["*a.inp", "b.bdf"]);
  await app.closeWindow();
  await page.waitForTimeout(300);
  check("a clean window closes without asking", [await page.locator(".dialog").count(), await app.destroyed()], [0, 1]);
}
