// The File menu's items from VS Code that fit an editor without workspaces:
// new files and windows, a folder, recent files, closed tabs, Save All, Auto
// Save, Revert File, closing the window and leaving.

import { rmSync } from "node:fs";

const deck = (name, n) => `${Array.from({ length: n }, (_, i) => `** ${name} ${i + 1}`).join("\n")}\n`;

export default async function (t) {
  const { until, check } = t;
  t.write({ "a.inp": deck("a", 200), "b.bdf": "SOL 101\nCEND\n", "c.inp": "*Heading\n", "folder/inner/x.inp": "x\n" });
  const app = await t.launch({ launchPath: t.path("a.inp"), settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".line");
  const PANEL = ".menubar .panel";
  const SUB = ".menubar .panel.sub";
  const [A, B, C] = ["a.inp", "b.bdf", "c.inp"].map((name) => t.path(name));
  /** Open Recent's items as `label|shortcut`, marked `-` when unavailable. */
  const recentMenu = async () => {
    await page.click(".menubar .title:text-matches('^File$')");
    await page.hover(`${PANEL} .label:text-matches('^Open Recent$')`);
    await page.waitForSelector(SUB);
    return page.$$eval(`${SUB} .item`, (els) =>
      els.map((e) => `${e.disabled ? "-" : ""}${e.querySelector(".label").textContent.trim()}|${e.querySelector(".shortcut")?.textContent ?? ""}`),
    );
  };
  // By regular expression: a marked letter splits the text for an exact match.
  const subItem = (label) => `${SUB} .item:has(.label:text-matches('^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&")}$'))`;
  const pickRecent = async (label) => {
    await recentMenu();
    await page.click(subItem(label));
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await until("the menu closes", () => page.locator(PANEL).count(), 0);
  };
  const rows = () => page.$$eval(".picker .row", (els) => els.map((e) => [...e.children].map((c) => c.textContent).join(" ")));
  const dirty = async () => (await app.tabs()).filter((tab) => tab.endsWith("●")).map((tab) => tab.replace(/^\*/, ""));
  const shown = async () => (await app.tabs()).find((tab) => tab.startsWith("*"));
  const gotoLine = async (n) => {
    await page.keyboard.press("Control+g");
    await page.waitForSelector(".goto input");
    await page.keyboard.type(String(n));
    await page.keyboard.press("Enter");
    await until(`at line ${n}`, app.position, `Ln ${n}, Col 1`);
  };

  // ---- Open Recent -------------------------------------------------------------------------

  await app.open(B);
  await app.open(C);
  check("the files opened, the last first", await recentMenu(), [
    "-Reopen Closed Editor|Ctrl+Shift+T",
    `${C}|`,
    `${B}|`,
    `${A}|`,
    "More…|Ctrl+R",
    "Clear Recently Opened|",
  ]);
  check("a path has no letter marked", await page.$$eval(`${SUB} .item .label`, (els) => els.map((e) => e.querySelector("u")?.textContent ?? "")), ["R", "", "", "", "M", "C"]);
  await app.shot("recent");
  await page.click(subItem(B));
  await until("one picked", app.path, B);
  await page.keyboard.press("Control+r");
  await page.waitForSelector(".picker");
  check("ctrl+r: all of them, by name and folder", await rows(), [`b.bdf ${t.path()}`, `c.inp ${t.path()}`, `a.inp ${t.path()}`]);
  await page.keyboard.type("c.in");
  await page.keyboard.press("Enter");
  await until("typed and picked", app.path, C);

  // A file gone from the disk goes from the list when picked.
  rmSync(C);
  await pickRecent(A);
  await until("a", app.path, A);
  await pickRecent(C);
  await until("says so", app.notice, `${C} is no longer there; it is off the list.`);
  check("and is off it", (await recentMenu()).filter((item) => item.includes(t.path())), [`${A}|`, `${B}|`]);
  await closeMenu();

  // ---- Reopen Closed Editor -------------------------------------------------------------------

  await page.mouse.click(...(await app.at(0, 0)));
  await gotoLine(150);
  const top = await app.firstLine();
  await page.keyboard.press("Control+w");
  await until("closed", async () => (await app.tabs()).some((tab) => tab.includes("a.inp")), false);
  await page.keyboard.press("Control+Shift+t");
  await until("ctrl+shift+t opens it again, where it was", async () => [await app.path(), await app.firstLine(), await app.position()], [A, top, "Ln 150, Col 1"]);
  await app.open(B);
  await page.keyboard.press("Control+w");
  check("from the menu too", (await recentMenu())[0], "Reopen Closed Editor|Ctrl+Shift+T");
  await page.click(subItem("Reopen Closed Editor"));
  await until("b again", app.path, B);
  // One closed but open again since is passed over.
  await page.keyboard.press("Control+w");
  await app.open(A);
  await page.keyboard.press("Control+w");
  await app.open(A);
  await page.keyboard.press("Control+Shift+t");
  await until("past a, open already, to b", app.path, B);
  check("nothing more to reopen", (await recentMenu())[0], "-Reopen Closed Editor|Ctrl+Shift+T");
  await page.click(subItem("Clear Recently Opened"));
  check("cleared", await recentMenu(), ["-Reopen Closed Editor|Ctrl+Shift+T", "-More…|Ctrl+R", "-Clear Recently Opened|"]);
  await closeMenu();

  // ---- New File… -------------------------------------------------------------------------------

  await app.menu("File", "New File…");
  await page.waitForSelector(".picker");
  check("the kinds", await rows(), ["Text File", "Abaqus Input File .inp", "Nastran Bulk Data File .bdf"]);
  await page.keyboard.type("nastran");
  check("a name typed is a file to make", await rows(), ["Nastran Bulk Data File .bdf", "New File: nastran"]);
  await page.keyboard.press("Enter");
  await until("a new Nastran deck", async () => [await shown(), await app.language()], ["*Untitled-1", "Nastran"]);
  await app.answerDialog(null);
  await page.keyboard.press("Control+Shift+s");
  await until("first saved as a .bdf", async () => (await app.dialogCalls()).at(-1), "Untitled-1.bdf");
  await page.keyboard.press("Control+w");

  await app.menu("File", "New File…");
  await page.keyboard.type("deck2.inp");
  await app.answerDialog(t.path("deck2.inp"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await until("made on disk, next to the open file, and opened", async () => [await app.path(), t.read("deck2.inp"), (await app.dialogCalls()).at(-1)], [
    t.path("deck2.inp"),
    "",
    t.path("deck2.inp"),
  ]);
  await app.menu("File", "New File…");
  await page.keyboard.type("b.bdf");
  await app.answerDialog(B);
  await page.keyboard.press("Enter");
  await until("nothing there is replaced", async () => [await app.notice(), t.read("b.bdf")], ['"b.bdf" is already there.', "SOL 101\nCEND\n"]);

  // ---- Open Folder… ----------------------------------------------------------------------------

  await app.answerDialog(t.path("folder"));
  await app.menu("File", "Open Folder…");
  await until("the explorer shows it, open", () => page.$$eval(".explorer .row.selected .name", (els) => els.map((e) => e.textContent)), ["folder"]);
  await until("with what is in it", () => page.locator(".explorer .row .name:text-is('inner')").count(), 1);

  // ---- Revert File -----------------------------------------------------------------------------

  await app.open(A);
  await page.mouse.click(...(await app.at(0, 0)));
  await gotoLine(120);
  await page.keyboard.type("zz");
  await until("changed", dirty, ["a.inp ●"]);
  await app.menu("File", "Revert File");
  await until("back to the disk's, at the same line", async () => [await dirty(), (await app.lines()).find((line) => line.includes("a 120")), await app.position()], [
    [],
    "** a 120",
    "Ln 120, Col 1",
  ]);

  // ---- Save All ---------------------------------------------------------------------------------

  await page.keyboard.type("A");
  await app.open(B);
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.type("B");
  await page.keyboard.press("Control+n");
  await until("a new one", shown, "*Untitled-2");
  await page.keyboard.type("new");
  await until("three unsaved", dirty, ["a.inp ●", "b.bdf ●", "Untitled-2 ●"]);
  await app.answerDialog(t.path("new.inp"));
  await page.keyboard.press("Control+k");
  await page.keyboard.press("s");
  await until("ctrl+k s saves them all, asking a name for the new one", async () => [await dirty(), t.read("b.bdf"), t.read("new.inp"), t.read("a.inp").split("\n")[119]], [
    [],
    "BSOL 101\nCEND\n",
    "new",
    "A** a 120",
  ]);

  // ---- Auto Save --------------------------------------------------------------------------------

  await app.menu("File", "Auto Save");
  await until("on, and kept", () => app.savedSettings()?.autoSave, true);
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.type("!");
  await page.waitForTimeout(500);
  check("not at once", t.read("new.inp"), "new");
  await until("a second after the last edit", async () => [t.read("new.inp"), await dirty()], ["!new", []], 4000);
  // Never over what changed on disk meanwhile.
  t.write({ "new.inp": "from elsewhere" });
  await page.keyboard.type("?");
  await until("the banner says so instead", () => page.locator(".banner").count(), 1, 4000);
  check("and the file is as it was left", t.read("new.inp"), "from elsewhere");
  await page.click(".banner button:has-text('Reload')");
  await until("reloaded", async () => (await app.lines())[0], "from elsewhere");
  await page.click(".menubar .title:text-matches('^File$')");
  check("shown on", await page.textContent(`${PANEL} .item:has(.label:text-matches('^Auto Save$')) .check`), "✓");
  await page.click(`${PANEL} .label:text-matches('^Auto Save$')`);
  await until("off", () => app.savedSettings()?.autoSave, false);

  // ---- New Window, Close Window, Exit -------------------------------------------------------------

  await page.keyboard.press("Control+Shift+n");
  await until("ctrl+shift+n: a window", () => app.opened.length, 1);
  const other = app.opened[0];
  await other.page.waitForSelector(".empty");
  check("of its own, empty", await other.tabs(), []);
  await other.page.keyboard.press("Control+Shift+w");
  await until("ctrl+shift+w closes it", other.destroyed, 1);
  check("and only it", await app.destroyed(), 0);
  await app.menu("File", "New Window");
  await until("another", () => app.opened.length, 2);
  const second = app.opened[1];
  await second.page.waitForSelector(".empty");
  await app.menu("File", "Exit");
  await until("exit closes every window", async () => [await app.destroyed(), await second.destroyed()], [1, 1]);
  await page.waitForTimeout(300);
  check("this one once: it does not take its own news", await app.destroyed(), 1);

  // ---- Korean ---------------------------------------------------------------------------------------

  const korean = await t.launch({ locale: "ko-KR", launchPath: B });
  const ko = korean.page;
  await ko.waitForSelector(".line");
  await ko.click(".menubar .title:text-matches('^파일')");
  await ko.hover(`${PANEL} .label:text-matches('^최근 항목 열기')`);
  await ko.waitForSelector(SUB);
  check("open recent in Korean", await ko.$$eval(`${SUB} .item .label`, (els) => els.map((e) => e.textContent.trim())), [
    "닫힌 편집기 다시 열기(R)",
    B,
    "기타(M)…",
    "최근에 연 항목 지우기(C)",
  ]);
  await ko.keyboard.press("Escape");
  await ko.keyboard.press("Escape");
  await ko.keyboard.press("Control+r");
  check("its picker", await ko.getAttribute(".picker input", "placeholder"), "최근에 연 파일 검색");
}
