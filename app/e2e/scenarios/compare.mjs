// The compare window: two files side by side, going through their differences,
// copying them across, undoing that, saving, and the documents it shares with
// the window that opened it.

const OLD = ["*Heading", "** model v1", "*Node", "1, 0., 0., 0.", "2, 1., 0., 0.", "3, 1., 1., 0.", "*Element, type=S4R", "1, 1, 2, 3, 4", "*End Step", ""].join("\n");
const NEW = ["*Heading", "** model v2", "*Node", "1, 0., 0., 0.", "2, 1.5, 0., 0.", "*Element, type=S4R", "1, 1, 2, 3, 4", "2, 2, 3, 4, 5", "*End Step", ""].join("\n");

export default async function (t) {
  const { until, check } = t;
  t.write({ "old.inp": OLD, "new.inp": NEW });
  const app = await t.launch({ launchPath: t.path("new.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const held = await app.heldDocuments();
  const row = (name) => `.tree .row:has(> .name:text-is(${JSON.stringify(name)}))`;
  const MENU = ".drop-menu:not(.sub)";
  const pick = (label) => page.click(`${MENU} .label:text-is(${JSON.stringify(label)})`);

  // ---- Opened from the explorer ----------------------------------------------------

  // The one picked first goes on the left. Picked, not opened: old.inp is open in the compare window alone.
  await page.click(row("old.inp"), { modifiers: ["ControlOrMeta"] });
  await page.click(row("new.inp"), { modifiers: ["ControlOrMeta"] });
  await page.click(row("new.inp"), { modifiers: ["ControlOrMeta"] });
  await page.click(row("old.inp"), { button: "right" });
  await page.waitForSelector(MENU);
  await pick("Compare Selected");
  await until("a compare window", () => app.opened.length, 1);
  const cmp = app.opened[0];
  const cp = cmp.page;
  await cp.waitForSelector(".compare-view .line");
  const side = (name) =>
    cp.$$eval(`.side.${name} .line`, (els) =>
      els.map((e) => `${e.classList.contains("removed") ? "-" : e.classList.contains("added") ? "+" : e.classList.contains("filler") ? "~" : " "}${e.textContent}`),
    );
  const status = () => cp.textContent(".statusbar");
  await until("both sides, row by row", async () => [await side("left"), await side("right")], [
    [" *Heading", "-** model v1", " *Node", " 1, 0., 0., 0.", "-2, 1., 0., 0.", "-3, 1., 1., 0.", " *Element, type=S4R", " 1, 1, 2, 3, 4", "~", " *End Step", " "],
    [" *Heading", "+** model v2", " *Node", " 1, 0., 0., 0.", "+2, 1.5, 0., 0.", "~", " *Element, type=S4R", " 1, 1, 2, 3, 4", "+2, 2, 3, 4, 5", " *End Step", " "],
  ]);
  check("the one picked first on the left", await cp.$$eval(".head .name", (els) => els.map((e) => e.textContent)), ["old.inp", "new.inp"]);
  check("what changed in a line, marked", await cp.$$eval(".side.right .line .mark", (els) => els.map((e) => e.textContent)), ["v2", "1.5"]);
  check("the title", await cmp.title(), "old.inp ↔ new.inp - HU Editor");
  await until("how many", status, "3 differences");
  await cmp.shot("compare");

  // ---- Going through them --------------------------------------------------------

  const current = () => cp.$$eval(".side.left .line.current", (els) => els.map((e) => e.textContent));
  await cp.keyboard.press("F7");
  await until("F7: the first", async () => [await status(), await current()], ["Difference 1 of 3", ["** model v1"]]);
  await cp.keyboard.press("F7");
  await until("and the next", async () => [await status(), await current()], ["Difference 2 of 3", ["2, 1., 0., 0.", "3, 1., 1., 0."]]);
  await cp.keyboard.press("Alt+ArrowDown");
  await until("Alt+Down too", status, "Difference 3 of 3");
  await cp.keyboard.press("F7");
  check("past the last: stays", await status(), "Difference 3 of 3");
  await cp.keyboard.press("Shift+F7");
  await until("Shift+F7: back", status, "Difference 2 of 3");
  await cp.keyboard.press("Alt+Home");
  await until("Alt+Home: the first", status, "Difference 1 of 3");
  await cp.locator(".side.right .line", { hasText: /^2, 2, 3, 4, 5$/ }).click();
  await until("a click picks its hunk", status, "Difference 3 of 3");
  // The buttons over the bar between the sides, as F7 and Shift+F7.
  const nav = (name) => cp.locator(`.heads .nav button[aria-label=${JSON.stringify(name)}]`);
  check("their names say their keys", [await nav("Previous Difference").getAttribute("title"), await nav("Next Difference").getAttribute("title")], [
    "Previous Difference (Shift+F7)",
    "Next Difference (F7)",
  ]);
  await nav("Previous Difference").click();
  await until("the button: back", status, "Difference 2 of 3");
  await nav("Next Difference").click();
  await until("and on", status, "Difference 3 of 3");
  check("the arrows still scroll the view", await cp.evaluate(() => !!document.activeElement?.closest(".compare-view")), true);
  await cp.keyboard.press("Shift+F7");
  await until("the keyboard still in the view", status, "Difference 2 of 3");

  // ---- Copying across --------------------------------------------------------------

  const mainLines = () => app.lines();
  await cp.keyboard.press("Alt+Home");
  await cp.keyboard.press("Alt+ArrowRight");
  await until("Alt+Right: to the right", async () => [await status(), (await side("right"))[1]], ["2 differences", " ** model v1"]);
  check("which has changes now", await cp.$$eval(".head", (els) => els.map((e) => e.textContent.includes("●"))), [false, true]);
  await until("in the editor too, open there", async () => (await mainLines())[1], "** model v1");
  check("its tab unsaved there", await app.tabs(), ["*new.inp ●"]);
  await cp.keyboard.press("ControlOrMeta+z");
  await until("undone", async () => [await status(), (await side("right"))[1], (await mainLines())[1]], ["3 differences", "+** model v2", "** model v2"]);
  await cp.keyboard.press("ControlOrMeta+y");
  await until("done again", async () => [await status(), (await mainLines())[1]], ["2 differences", "** model v1"]);
  // A button between the sides copies its hunk the other way.
  const copyLeft = cp.locator(".middle .copy button[title='Copy to Left']");
  await until("a pair of buttons for each hunk", () => cp.locator(".middle .copy").count(), 2);
  await copyLeft.last().click();
  await until("to the left", async () => [await status(), (await side("left")).slice(7, 9)], ["1 difference", [" 1, 1, 2, 3, 4", " 2, 2, 3, 4, 5"]]);
  check("and it has changes", await cp.$$eval(".head", (els) => els.map((e) => e.textContent.includes("●"))), [true, true]);

  // ---- Edited in the other window ------------------------------------------------------

  await page.click(".slot:not(.hidden) .lines .line >> nth=0");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("** tail");
  await until("what is typed there is compared", async () => [await status(), (await side("right")).at(-1)], ["2 differences", "+** tail"]);

  // ---- Saving and closing ------------------------------------------------------------

  await cp.keyboard.press("ControlOrMeta+s");
  await until("both saved", () => [t.read("old.inp").split("\n")[8], t.read("new.inp").split("\n")[1]], ["2, 2, 3, 4, 5", "** model v1"]);
  await until("their changes gone", async () => (await cp.$$eval(".head", (els) => els.map((e) => e.textContent.includes("●")))), [false, false]);
  await until("there too", app.tabs, ["*new.inp"]);
  // old.inp, open here alone, changed again: closing asks.
  await cp.keyboard.press("Alt+Home");
  await cp.keyboard.press("Alt+ArrowLeft");
  await until("changed", async () => (await cp.$$eval(".head", (els) => els[0].textContent.includes("●"))), true);
  await cp.keyboard.press("ControlOrMeta+w");
  await cp.waitForSelector(".dialog");
  check("closing asks", await cp.textContent(".dialog p"), "Save changes to old.inp?");
  await cp.keyboard.press("Escape");
  await until("Escape: stays", () => cp.locator(".dialog").count(), 0);
  check("not gone", await cmp.destroyed(), 0);
  await cp.keyboard.press("ControlOrMeta+w");
  await cp.click(".dialog button:has-text(\"Don't Save\")");
  await until("gone, unsaved", cmp.destroyed, 1);
  check("the file as it was", t.read("old.inp").split("\n")[1], "** model v1");
  check("the editor still has its own", (await mainLines())[1], "** model v1");

  // ---- Chosen one at a time, and with the active file -------------------------------------

  // Still both picked: one alone now.
  await page.click(row("new.inp"), { modifiers: ["ControlOrMeta"] });
  await page.click(row("old.inp"), { button: "right" });
  await page.waitForSelector(MENU);
  check("nothing chosen yet", (await page.$$eval(`${MENU} .label`, (els) => els.map((e) => e.textContent))).filter((l) => l.startsWith("Compare")), []);
  await pick("Select for Compare");
  await page.click(row("new.inp"), { button: "right" });
  await page.waitForSelector(MENU);
  await pick("Compare with 'old.inp'");
  await until("another window", () => app.opened.length, 2);
  const second = app.opened[1];
  await second.page.waitForSelector(".compare-view .line");
  check("the one chosen on the left", await second.page.$$eval(".head .name", (els) => els.map((e) => e.textContent)), ["old.inp", "new.inp"]);
  await until("as saved: the nodes, and the tail typed", () => second.page.textContent(".statusbar"), "2 differences");
  await second.page.keyboard.press("ControlOrMeta+w");
  await until("closed without asking", second.destroyed, 1);

  await app.answerDialog(t.path("old.inp"));
  await app.menu("File", "Compare Active File With…");
  await until("and one more", () => app.opened.length, 3);
  const third = app.opened[2];
  await third.page.waitForSelector(".compare-view .line");
  check("the file picked on the left, the active one on the right", await third.page.$$eval(".head .name", (els) => els.map((e) => e.textContent)), ["old.inp", "new.inp"]);
  await third.page.keyboard.press("ControlOrMeta+w");
  await until("closed", third.destroyed, 1);
  await until("the documents of the compare windows let go of", app.heldDocuments, held);

  // ---- The same, and read again from the disk ------------------------------------------

  t.write({ "copy.inp": t.read("new.inp") });
  await app.answerDialog(t.path("copy.inp"));
  await app.menu("File", "Compare Active File With…");
  await until("a fourth", () => app.opened.length, 4);
  const same = app.opened[3];
  await same.page.waitForSelector(".compare-view .line");
  await until("the same", () => same.page.textContent(".statusbar"), "No differences");
  check("nothing to copy", await same.page.locator(".middle .copy").count(), 0);
  check("nor to go to", await same.page.$$eval(".heads .nav button", (els) => els.map((e) => e.disabled)), [true, true]);
  await same.page.keyboard.press("F7");
  await same.page.waitForTimeout(100);
  check("nothing to go to", await same.page.textContent(".statusbar"), "No differences");
  await page.click(".slot:not(.hidden) .lines .line >> nth=0");
  await page.keyboard.press("End");
  await page.keyboard.type(" again");
  await until("typed in the editor", () => same.page.textContent(".statusbar"), "1 difference");
  await app.menu("File", "Revert File");
  await until("read again there: compared again here", () => same.page.textContent(".statusbar"), "No differences");
  await same.page.keyboard.press("ControlOrMeta+w");
  await until("and closed", same.destroyed, 1);
  await until("let go of", app.heldDocuments, held);

  // ---- In Korean -------------------------------------------------------------------------

  const korean = await t.launch({ settings: { language: "ko" }, launchPath: t.path("new.inp") });
  await korean.page.waitForSelector(".line");
  await korean.answerDialog(t.path("copy.inp"));
  await korean.page.click(".menubar .title >> nth=0");
  await korean.page.click(".menubar .panel .label:has-text('현재 파일과 비교')");
  await until("a compare window", () => korean.opened.length, 1);
  const kp = korean.opened[0].page;
  await kp.waitForSelector(".compare-view .line");
  check("its menus", await kp.$$eval(".menubar .title", (els) => els.map((e) => e.textContent)), ["파일(F)", "편집(E)", "비교(C)"]);
  check("its buttons", await kp.$$eval(".heads .nav button", (els) => els.map((e) => e.title)), ["이전 차이 (Shift+F7)", "다음 차이 (F7)"]);
  await until("and its words", () => kp.textContent(".statusbar"), "차이 없음");
  await kp.click(".menubar .title >> nth=2");
  check("what it does", await kp.$$eval(".menubar .panel .label", (els) => els.map((e) => e.textContent)), [
    "다음 차이(N)",
    "이전 차이(P)",
    "첫 차이(F)",
    "마지막 차이(L)",
    "오른쪽으로 복사(R)",
    "왼쪽으로 복사(E)",
  ]);
  await t.close(korean);
}
