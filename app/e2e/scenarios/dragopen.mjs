// Files dragged in, from the OS or from the explorer, open where they are let
// go: into the pane under them or, near an edge of its text, a new pane on that
// side, shown as a tab dragged would be.

export default async function (t) {
  const { until, check } = t;
  t.write({ "a.inp": "*Node\n", "b.inp": "*Element\n", "c.inp": "*Step\n", "d.inp": "*End Step\n", "sub/e.inp": "*Part\n" });
  const app = await t.launch({ launchPath: t.path("a.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const PANE = (i) => `.pane[data-pane="${i}"]`;
  const paneCount = () => page.locator(".pane").count();
  const tabsOf = (i) => page.$$eval(`${PANE(i)} .strip .tab`, (els) => els.map((e) => `${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}`));
  const focusedPane = () => page.$eval(".pane.focused", (e) => Number(e.dataset.pane));
  /** Where the drop would go: a pane and the side shown, or null. */
  const zone = () => page.$eval(".pane.drop-target", (e) => [Number(e.dataset.pane), e.dataset.side ?? "whole"]).catch(() => null);
  /** A point of a pane's text: fractions across and down it. */
  const pointIn = async (i, fx, fy) => {
    const box = await page.$eval(`${PANE(i)} .editors`, (e) => JSON.parse(JSON.stringify(e.getBoundingClientRect())));
    return { x: box.x + box.width * fx, y: box.y + box.height * fy };
  };
  const row = (name) => `.explorer .row:has(.name:text-is('${name}'))`;
  /** Drags a file of the explorer to a point, and lets go there if asked. */
  const dragRow = async (name, to, letGo = true) => {
    const box = await page.locator(row(name)).boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    if (letGo) await page.mouse.up();
  };

  // ---- From the OS --------------------------------------------------------------------------

  await app.dragOver(await pointIn(0, 0.5, 0.5));
  await until("over the middle: into the pane", zone, [0, "whole"]);
  await app.dragOver(await pointIn(0, 0.95, 0.5));
  await until("near the right edge: a new pane there", zone, [0, "right"]);
  await app.shot("drag-right");
  await app.dragOver(null);
  await until("gone when it leaves", zone, null);
  await app.dragOver(await pointIn(0, 0.95, 0.5));
  await app.drop([t.path("b.inp")], await pointIn(0, 0.95, 0.5));
  await until("dropped there: in a new pane on the right, with the keyboard", async () => [await paneCount(), await tabsOf(0), await tabsOf(1), await focusedPane()], [
    2,
    ["*a.inp"],
    ["*b.inp"],
    1,
  ]);
  check("the mark goes", await zone(), null);
  await app.drop([t.path("c.inp")], await pointIn(0, 0.5, 0.5));
  await until("into the middle of the other pane", async () => [await tabsOf(0), await focusedPane()], [["a.inp", "*c.inp"], 0]);
  await app.drop([t.path("d.inp")], await pointIn(1, 0.5, 0.05));
  await until("a new pane above the right one", async () => [await paneCount(), await tabsOf(1), await tabsOf(2)], [3, ["*d.inp"], ["*b.inp"]]);
  await app.drop([t.path("sub")], await pointIn(0, 0.05, 0.5));
  await until("a folder shows in the explorer, and makes no pane", async () => [await paneCount(), await page.locator(row("e.inp")).count()], [3, 1]);
  await app.drop([t.path("a.inp")], await pointIn(2, 0.5, 0.5));
  await until("one open already: in that pane too", async () => [await tabsOf(2), await tabsOf(0)], [["b.inp", "*a.inp"], ["a.inp", "*c.inp"]]);
  await app.layout("Single");
  await until("one pane", paneCount, 1);
  await app.drop([t.path("b.inp")]);
  await until("off the panes: in the pane with the keyboard, as before", async () => (await tabsOf(0)).find((tab) => tab.startsWith("*")), "*b.inp");

  // ---- From the explorer ----------------------------------------------------------------------

  await dragRow("c.inp", await pointIn(0, 0.95, 0.5), false);
  await until("dragging a file shows where it goes", async () => [await zone(), await page.locator(`${row("c.inp")}.dragged`).count()], [[0, "right"], 1]);
  const below = await pointIn(0, 0.5, 0.95);
  await page.mouse.move(below.x, below.y, { steps: 4 });
  await until("and follows it", zone, [0, "bottom"]);
  await app.shot("drag-explorer");
  await page.mouse.up();
  await until("let go: in a new pane below", async () => [await paneCount(), await tabsOf(1), await focusedPane()], [2, ["*c.inp"], 1]);
  check("not dimmed any more", await page.locator(".explorer .row.dragged").count(), 0);
  const over = await pointIn(0, 0.5, 0.5);
  await page.mouse.move(over.x, over.y, { steps: 4 });
  check("the mouse moved on after: no mark", await zone(), null);
  await dragRow("d.inp", await pointIn(0, 0.5, 0.5));
  const shownIn = async (i) => (await tabsOf(i)).find((tab) => tab.startsWith("*"));
  await until("into the middle of the top one", () => shownIn(0), "*d.inp");
  const before = [await tabsOf(0), await tabsOf(1)];
  const tree = await page.locator(".explorer").boundingBox();
  await dragRow("b.inp", { x: tree.x + tree.width / 2, y: tree.y + tree.height - 20 });
  await until("let go in the explorer: nothing opens", async () => [await zone(), await tabsOf(0), await tabsOf(1)], [null, ...before]);

  // A locked pane takes what is dropped on it on purpose.
  await page.click(`${PANE(1)} .actions button[title^='More']`);
  await page.click(".drop-menu .label:text-is('Lock Group')");
  await until("locked", () => page.locator(`${PANE(1)} .actions .lock`).count(), 1);
  await dragRow("a.inp", await pointIn(1, 0.5, 0.5));
  await until("into the locked pane", () => shownIn(1), "*a.inp");
  check("b.inp let go in the explorer has not opened since", await shownIn(0), "*d.inp");

  // A blank new document gives way only to what is opened in its own pane.
  await page.click(`${PANE(0)} .editors`);
  await page.keyboard.press("Control+n");
  await until("a new one on top", () => shownIn(0), "*Untitled-1");
  await dragRow("e.inp", await pointIn(1, 0.5, 0.5));
  await until("dropped below: the new one stays", async () => [await shownIn(0), await shownIn(1)], ["*Untitled-1", "*e.inp"]);
  await t.close(app);

  // On a scaled display, wry gives Windows' position in device pixels and
  // macOS's in CSS pixels, though Tauri calls both physical.
  const agents = {
    macOS: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    Windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  };
  for (const [os, userAgent] of Object.entries(agents)) {
    const scaled = await t.launch({ launchPath: t.path("a.inp"), scale: 2, userAgent });
    const at = async (fx, fy) => {
      const box = await scaled.page.$eval(`${PANE(0)} .editors`, (e) => JSON.parse(JSON.stringify(e.getBoundingClientRect())));
      return { x: box.x + box.width * fx, y: box.y + box.height * fy };
    };
    const zoneThere = () => scaled.page.$eval(".pane.drop-target", (e) => [Number(e.dataset.pane), e.dataset.side ?? "whole"]).catch(() => null);
    await scaled.page.waitForSelector(".line");
    check(`${os} at 200%`, await scaled.page.evaluate(() => window.devicePixelRatio), 2);
    await scaled.dragOver(await at(0.95, 0.5));
    await until(`${os} at 200%: the right edge`, zoneThere, [0, "right"]);
    await scaled.dragOver(await at(0.05, 0.5));
    await until(`${os} at 200%: the left edge`, zoneThere, [0, "left"]);
    await scaled.drop([t.path("b.inp")], await at(0.95, 0.5));
    await until(`${os} at 200%: a new pane on the right`, () => scaled.page.$$eval(".pane .strip .tab.active .name", (els) => els.map((e) => e.textContent)), ["a.inp", "b.inp"]);
    await t.close(scaled);
  }
}
