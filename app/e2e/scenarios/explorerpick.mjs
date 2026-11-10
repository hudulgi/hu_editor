// Several rows of the explorer picked, as in VS Code: Ctrl+click and
// Shift+click, Shift+arrows; and what then works on them all.

import { existsSync } from "node:fs";

const TRASH = process.platform === "win32" ? "Recycle Bin" : "Trash";
const EOL = process.platform === "win32" ? "\r\n" : "\n";

export default async function (t) {
  const { until, check } = t;
  t.write({
    "work/a.inp": "*A\n",
    "work/b.inp": "*B\n",
    "work/c.inp": "*C\n",
    "work/d.inp": "*D\n",
    "work/sub/e.inp": "*E\n",
    "dest/keep.txt": "",
  });
  const app = await t.launch({ launchPath: t.path("work/a.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const MOD = "ControlOrMeta";
  const MENU = ".drop-menu:not(.sub)";
  const PANE = (i) => `.pane[data-pane="${i}"]`;
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const row = (name) => `.tree .row:has(> .name:text-is(${JSON.stringify(name)}))`;
  const picked = () => page.$$eval(".tree .row.selected .name", (els) => els.map((e) => e.textContent));
  const focused = () => page.textContent(".tree .row.focused .name");
  const tabsOf = (i) => page.$$eval(`${PANE(i)} .strip .tab`, (els) => els.map((e) => `${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}`));
  const names = (i) => tabsOf(i).then((tabs) => tabs.map((tab) => tab.replace("*", "")).sort());
  const onDisk = (...parts) => existsSync(t.path(...parts));
  const entries = () =>
    page.$$eval(`${MENU} > *`, (els) => els.map((e) => (e.classList.contains("separator") ? "—" : `${e.disabled ? "-" : ""}${e.querySelector(".label").textContent}`)));
  const pick = (label) => page.click(`${MENU} .label:text-is(${JSON.stringify(label)})`);
  const pointIn = async (i, fx, fy) => {
    const box = await page.locator(`${PANE(i)} .editors`).boundingBox();
    return { x: box.x + box.width * fx, y: box.y + box.height * fy };
  };

  // ---- Picking ----------------------------------------------------------------------------------------

  await until("starts at the file", picked, ["a.inp"]);
  await page.click(row("c.inp"), { modifiers: [MOD] });
  await until("ctrl+click adds one", async () => [await picked(), await focused()], [["a.inp", "c.inp"], "c.inp"]);
  check("and opens nothing", await tabsOf(0), ["*a.inp"]);
  await app.shot("explorer-picked");
  await page.dblclick(row("b.inp"), { modifiers: [MOD] });
  await page.waitForTimeout(200);
  check("twice quickly: in and out again, and still nothing opened", [await picked(), await tabsOf(0)], [["a.inp", "c.inp"], ["*a.inp"]]);
  await page.click(row("a.inp"), { modifiers: [MOD] });
  await until("and again takes it out, the keyboard there", async () => [await picked(), await focused()], [["c.inp"], "a.inp"]);
  await page.click(row("a.inp"));
  await page.click(row("d.inp"), { modifiers: ["Shift"] });
  await until("shift+click: the run from the last one", picked, ["a.inp", "b.inp", "c.inp", "d.inp"]);
  check("still nothing opened", await tabsOf(0), ["*a.inp"]);
  await press("Shift+ArrowUp");
  await until("shift+up takes the run back", async () => [await picked(), await focused()], [["a.inp", "b.inp", "c.inp"], "c.inp"]);
  await press("Escape");
  await until("esc: the one with the keyboard alone", picked, ["c.inp"]);
  await press("Shift+ArrowDown");
  await until("shift+down", picked, ["c.inp", "d.inp"]);
  await press("ArrowUp");
  await until("an arrow alone picks one", picked, ["c.inp"]);

  // ---- What works on them all -------------------------------------------------------------------------

  await press("Shift+ArrowDown", "Shift+Alt+c");
  await until("their paths, a line each", app.clipboard, [t.path("work", "c.inp"), t.path("work", "d.inp")].join(EOL));
  await page.click(row("d.inp"), { button: "right" });
  await page.waitForSelector(MENU);
  await pick("Copy Name");
  await until("and their names", app.clipboard, ["c.inp", "d.inp"].join(EOL));
  await page.click(row("d.inp"), { button: "right" });
  await page.waitForSelector(MENU);
  check("a right click on one of them keeps them all", await picked(), ["c.inp", "d.inp"]);
  check("what works on one only is off", (await entries()).filter((e) => /Open to the Side|Rename|Delete|Cut|Copy$/.test(e)), [
    "-Open to the Side",
    "Cut",
    "Copy",
    "-Rename…",
    "Delete",
  ]);
  await press("Escape");
  await page.click(row("b.inp"), { button: "right" });
  await page.waitForSelector(MENU);
  check("on another row: that one alone", await picked(), ["b.inp"]);
  await press("Escape");
  await page.click(row("c.inp"), { modifiers: [MOD] });
  await page.click(row("d.inp"), { modifiers: [MOD] });
  await press("Enter");
  await until("enter opens them all", () => names(0), ["a.inp", "b.inp", "c.inp", "d.inp"]);
  check("as tabs to stay", await page.locator(`${PANE(0)} .strip .tab.preview`).count(), 0);

  // Dragged together.
  await page.click(row("d.inp"), { modifiers: [MOD] });
  await until("two again", picked, ["b.inp", "c.inp"]);
  const box = await page.locator(row("c.inp")).boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  const edge = await pointIn(0, 0.95, 0.5);
  await page.mouse.move(edge.x, edge.y, { steps: 8 });
  await until("both dimmed while dragged", () => page.locator(".tree .row.dragged").count(), 2);
  await page.mouse.up();
  await until("let go: both in a new pane", async () => [await page.locator(".pane").count(), await names(1)], [2, ["b.inp", "c.inp"]]);
  await app.layout("Single");

  // Cut and pasted together; the tabs follow.
  await page.click(row("c.inp"));
  await page.click(row("d.inp"), { modifiers: [MOD] });
  await press(`${MOD}+x`);
  await until("both dimmed as cut", () => page.locator(".tree .row.cut").count(), 2);
  await page.click(row("dest"));
  await press(`${MOD}+v`);
  await until("moved together", () => [onDisk("dest", "c.inp"), onDisk("dest", "d.inp"), onDisk("work", "c.inp"), onDisk("work", "d.inp")], [true, true, false, false]);
  await until("and picked where they are", picked, ["c.inp", "d.inp"]);
  await page.click(`${PANE(0)} .strip .tab:has(.name:text-is('d.inp'))`);
  await until("the tab follows", app.path, t.path("dest", "d.inp"));

  // Deleted after one question.
  await page.click(row("a.inp"));
  await page.click(row("b.inp"), { modifiers: [MOD] });
  await press("Delete");
  await until("one question for both", async () => (await app.messages()).at(-1)?.message, `Are you sure you want to delete the following 2 items?\n\na.inp\nb.inp\n\nYou can restore them from the ${TRASH}.`);
  check("cancelled: both there", [onDisk("work", "a.inp"), onDisk("work", "b.inp")], [true, true]);
  await app.answerMessage("ok");
  await press("Delete");
  await until("both gone", () => [onDisk("work", "a.inp"), onDisk("work", "b.inp")], [false, false]);
  // A folder and a file in it: the folder is all there is to delete.
  await page.click(row("sub"));
  await until("open", () => page.locator(row("e.inp")).count(), 1);
  await page.click(row("e.inp"), { modifiers: [MOD] });
  await press("Delete");
  await until("asked for the folder alone", async () => (await app.messages()).at(-1)?.message.split("\n")[0], "Are you sure you want to delete 'sub' and its contents?");
  check("cancelled", onDisk("work", "sub", "e.inp"), true);
}
