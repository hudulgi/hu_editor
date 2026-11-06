// The explorer's own menus, from a right click: on a file, on a folder, and on
// the space below the rows; and what they do on the disk.

import { existsSync } from "node:fs";
import { join } from "node:path";

const REVEAL = { win32: "Reveal in File Explorer", darwin: "Reveal in Finder" }[process.platform] ?? "Open Containing Folder";
const REVEAL_KO = { win32: "파일 탐색기에 표시", darwin: "Finder에 표시" }[process.platform] ?? "포함 폴더 열기";
const TRASH = process.platform === "win32" ? "Recycle Bin" : "Trash";

export default async function (t) {
  const { until, check } = t;
  t.write({
    "work/deck.inp": "*Heading\n",
    "work/mesh.inp": "*Node\n",
    "work/sub/part.inp": "*Part\n",
    "work/subway/line.inp": "",
    "other/keep.txt": "",
  });
  const app = await t.launch({ launchPath: t.path("work/deck.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const MENU = ".drop-menu:not(.sub)";
  const NAME = ".tree .name-edit input";
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const rowOf = (...parts) => `.tree .row[title=${JSON.stringify(t.path(...parts))}]`;
  const selected = () => page.textContent(".row.selected .name");
  const names = () => page.$$eval(".tree .row .name", (els) => els.map((e) => e.textContent));
  const onDisk = (...parts) => existsSync(t.path(...parts));
  const error = () => page.$eval(".tree .name-error", (e) => e.textContent).catch(() => null);
  const naming = () => page.locator(NAME).count();
  const keyboardIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.classList.contains("tree")) return "tree";
      if (el.tagName === "TEXTAREA") return "editor";
      if (el.closest(".drop-menu")) return "menu";
      if (el.closest(".name-edit")) return "name";
      return el.tagName;
    });
  const entries = (where = page) =>
    where.$$eval(`${MENU} > *`, (els) =>
      els.map((e) => {
        if (e.classList.contains("separator")) return "—";
        return `${e.disabled ? "-" : ""}${e.querySelector(".label").textContent}${e.querySelector(".shortcut") ? `|${e.querySelector(".shortcut").textContent}` : ""}`;
      }),
    );
  const menuOn = async (...parts) => {
    await page.click(rowOf(...parts), { button: "right" });
    await page.waitForSelector(MENU);
  };
  /** A right click below the rows. */
  const emptyMenu = async () => {
    await page.$eval(".tree", (tree) => {
      const box = tree.getBoundingClientRect();
      tree.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.bottom - 4 }));
    });
    await page.waitForSelector(MENU);
  };
  const pick = (label) => page.click(`${MENU} .label:text-is(${JSON.stringify(label)})`);
  /** Selects a row the way a right click does, without opening it. */
  const choose = async (...parts) => {
    await menuOn(...parts);
    await press("Escape");
  };
  const go = async (...parts) => {
    await page.fill(".address input", t.path(...parts));
    await page.press(".address input", "Enter");
    await until(`at ${parts.join("/")}`, selected, parts[parts.length - 1]);
  };
  const tab = (name) => page.click(`.pane.focused .strip .tab:has(.name:text-is(${JSON.stringify(name)}))`);

  // ---- The menus ----------------------------------------------------------------

  await until("starts at the file", selected, "deck.inp");
  await menuOn("work", "mesh.inp");
  check("a right click selects it", await selected(), "mesh.inp");
  check("a file's menu, in its order", await entries(), [
    "Open to the Side|Ctrl+Enter",
    `${REVEAL}|Shift+Alt+R`,
    "Open in Terminal",
    "—",
    "Cut|Ctrl+X",
    "Copy|Ctrl+C",
    "—",
    "Copy Path|Shift+Alt+C",
    "Copy Relative Path",
    "—",
    "Rename…|F2",
    "Delete|Delete",
  ]);
  await app.shot("explorermenu");
  check("it holds the keyboard", await keyboardIn(), "menu");
  await press("Escape");
  await until("escape: the keyboard back in the tree", keyboardIn, "tree");
  check("and nothing opened", await app.path(), t.path("work", "deck.inp"));

  await emptyMenu();
  check("the space below: for the selected one's folder", await entries(), [
    "New File…",
    "New Folder…",
    `${REVEAL}|Shift+Alt+R`,
    "Open in Terminal",
    "—",
    "-Paste|Ctrl+V",
    "—",
    "Copy Path|Shift+Alt+C",
    "Copy Relative Path",
  ]);
  await pick("Copy Path");
  await until("the folder's path", app.clipboard, t.path("work"));

  await menuOn("work", "sub");
  check("a folder's, with nothing to paste", await entries(), [
    "New File…",
    "New Folder…",
    `${REVEAL}|Shift+Alt+R`,
    "Open in Terminal",
    "—",
    "Cut|Ctrl+X",
    "Copy|Ctrl+C",
    "-Paste|Ctrl+V",
    "—",
    "Copy Path|Shift+Alt+C",
    "Copy Relative Path",
    "—",
    "Rename…|F2",
    "Delete|Delete",
  ]);
  await press("Escape");
  await page.click(".tree .row:has(.root-icon):has-text('Home')", { button: "right" });
  await page.waitForSelector(MENU);
  check("a root stays where it is", (await entries()).filter((e) => /^-?(Cut|Copy|Rename…|Delete)\|/.test(e)), ["-Cut|Ctrl+X", "-Copy|Ctrl+C", "-Rename…|F2", "-Delete|Delete"]);
  await press("Escape");

  // The keyboard's menu key, at the row.
  await choose("work", "mesh.inp");
  await press("Shift+F10");
  await page.waitForSelector(MENU);
  check("shift+f10 opens it", [await keyboardIn(), (await entries())[0]], ["menu", "Open to the Side|Ctrl+Enter"]);
  await press("Escape");
  await until("and the keyboard comes back, not to the menu bar", keyboardIn, "tree");
  await press("ContextMenu");
  await page.waitForSelector(MENU);
  check("so does the menu key", (await entries())[0], "Open to the Side|Ctrl+Enter");
  await press("Escape");

  // ---- Paths, the file manager, a terminal ---------------------------------------------

  await go("work", "sub");
  await menuOn("work", "sub", "part.inp");
  await pick("Copy Relative Path");
  await until("relative to the open file's folder, as an *INCLUDE wants it", app.clipboard, join("sub", "part.inp"));
  await go("other");
  await menuOn("other", "keep.txt");
  await pick("Copy Relative Path");
  await until("up and over", app.clipboard, join("..", "other", "keep.txt"));
  await menuOn("work", "sub", "part.inp");
  await pick("Copy Path");
  await until("copy path", app.clipboard, t.path("work", "sub", "part.inp"));
  await choose("work", "mesh.inp");
  await press("Shift+Alt+C");
  await until("shift+alt+c", app.clipboard, t.path("work", "mesh.inp"));
  await press("Control+n");
  await until("a new document", app.path, "Untitled-1");
  await menuOn("work", "mesh.inp");
  check("one with no file has no folder to start from", (await entries()).includes("-Copy Relative Path"), true);
  await press("Escape");
  await press("Control+w");
  await until("back at the file", app.path, t.path("work", "deck.inp"));

  const before = (await app.launched()).length;
  await menuOn("work", "sub", "part.inp");
  await pick(REVEAL);
  await menuOn("work", "sub", "part.inp");
  await pick("Open in Terminal");
  await menuOn("work", "sub");
  await pick("Open in Terminal");
  await choose("work", "mesh.inp");
  await press("Shift+Alt+R");
  await until("the file manager and terminals asked for", async () => (await app.launched()).slice(before), [
    ["reveal_path", t.path("work", "sub", "part.inp")],
    ["open_terminal", t.path("work", "sub")],
    ["open_terminal", t.path("work", "sub")],
    ["reveal_path", t.path("work", "mesh.inp")],
  ]);

  // ---- New files and folders -------------------------------------------------------------

  await menuOn("work", "sub");
  await pick("New File…");
  await page.waitForSelector(NAME);
  check("a name to type", await keyboardIn(), "name");
  check("at the top of the folder", await page.$eval(".tree .row.naming", (row) => row.nextElementSibling.title), t.path("work", "sub", "part.inp"));
  await page.keyboard.type("part.inp");
  await until("a name taken says so", error, "A file or folder part.inp already exists here. Choose a different name.");
  await app.shot("explorername");
  await press("Enter");
  check("and is not made", await naming(), 1);
  await page.fill(NAME, "a/b.inp");
  await until("nor one with a slash", error, "A name cannot contain / or \\.");
  await press("Escape");
  await until("escape gives it up", async () => [await naming(), await keyboardIn()], [0, "tree"]);
  await menuOn("work", "sub");
  await pick("New File…");
  await page.waitForSelector(NAME);
  await page.keyboard.type("new.inp");
  await press("Enter");
  await until("made, and open to write in", async () => [onDisk("work", "sub", "new.inp"), await app.path(), await selected(), await keyboardIn()], [
    true,
    t.path("work", "sub", "new.inp"),
    "new.inp",
    "editor",
  ]);
  check("in a tab to stay", await page.locator(".pane.focused .strip .tab.active.preview").count(), 0);

  await emptyMenu();
  await pick("New Folder…");
  await page.waitForSelector(NAME);
  await page.keyboard.type("results");
  await press("Enter");
  await until("a folder, in the selected one's folder", async () => [onDisk("work", "sub", "results"), await selected(), await keyboardIn()], [true, "results", "tree"]);
  await menuOn("work", "sub");
  await pick("New Folder…");
  await page.waitForSelector(NAME);
  await page.keyboard.type("left");
  await page.mouse.click(...(await app.at(0, 0)));
  await until("leaving the name makes it", () => onDisk("work", "sub", "left"), true);
  await menuOn("work", "sub");
  await pick("New Folder…");
  await page.waitForSelector(NAME);
  await page.keyboard.type("results");
  await page.mouse.click(...(await app.at(0, 0)));
  await until("a name taken, left: given up", naming, 0);

  // ---- Rename ------------------------------------------------------------------------------------

  await menuOn("work", "mesh.inp");
  await pick("Rename…");
  await page.waitForSelector(NAME);
  check("its name, all but the extension selected", await page.$eval(NAME, (input) => [input.value, input.selectionStart, input.selectionEnd]), ["mesh.inp", 0, 4]);
  await page.keyboard.type("grid");
  await press("Enter");
  await until("renamed", async () => [onDisk("work", "mesh.inp"), onDisk("work", "grid.inp"), await selected(), await keyboardIn()], [false, true, "grid.inp", "tree"]);
  await press("F2");
  await page.fill(NAME, "deck.inp");
  await until("f2; a name taken", error, "A file or folder deck.inp already exists here. Choose a different name.");
  await press("ArrowLeft", "Delete", "ArrowLeft");
  check("the keys typed are the name's, not the tree's", [await page.inputValue(NAME), (await app.messages()).length, await page.$eval(".row.selected", (row) => row.title)], [
    "deck.in",
    0,
    t.path("work", "grid.inp"),
  ]);
  await press("Escape");
  await press("F2");
  await page.fill(NAME, "Grid.inp");
  await press("Enter");
  await until("the case alone", async () => (await names()).filter((name) => /^grid\.inp$/i.test(name)), ["Grid.inp"]);
  check("the same file", t.read(join("work", "Grid.inp")), "*Node\n");

  // An open file: its tab follows, and saves there.
  await menuOn("work", "deck.inp");
  await pick("Rename…");
  await page.waitForSelector(NAME);
  await page.fill(NAME, "main.bdf");
  await press("Enter");
  await until("renamed on the disk", () => onDisk("work", "main.bdf"), true);
  await tab("main.bdf");
  await until("its tab follows", async () => [await app.path(), await app.language()], [t.path("work", "main.bdf"), "Nastran"]);
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.type("$");
  await press("Control+s");
  await until("and saves there", () => t.read(join("work", "main.bdf")), "$*Heading\n");
  check("not where it was", onDisk("work", "deck.inp"), false);

  // A folder with an open file in it; the tree stays open through it.
  await go("work", "subway");
  await page.dblclick(rowOf("work", "sub", "part.inp"));
  await until("open", app.path, t.path("work", "sub", "part.inp"));
  await menuOn("work", "sub");
  await pick("Rename…");
  await page.waitForSelector(NAME);
  await page.fill(NAME, "parts");
  await press("Enter");
  await until("its file's tab follows", app.path, t.path("work", "parts", "part.inp"));
  await until("still open in the tree", () => page.locator(rowOf("work", "parts", "results")).count(), 1);
  check("and one whose name only starts the same, as it was", await page.locator(rowOf("work", "subway", "line.inp")).count(), 1);
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.type("x");
  await press("Control+s");
  await until("and it saves there", () => t.read(join("work", "parts", "part.inp")), "x*Part\n");

  // Another window showing it follows too.
  await press("Control+k", "o");
  await until("a window opens", () => app.opened.length, 1);
  const window = app.opened[0];
  await window.page.waitForSelector(".line");
  await menuOn("work", "parts", "part.inp");
  await pick("Rename…");
  await page.waitForSelector(NAME);
  await page.keyboard.type("piece");
  await press("Enter");
  await until("the other window's tab follows", window.path, t.path("work", "parts", "piece.inp"));
  await window.closeWindow();
  await window.page.close();

  // ---- Cut, copy, paste ------------------------------------------------------------------------------

  await menuOn("work", "Grid.inp");
  await pick("Copy");
  await menuOn("other");
  await pick("Paste");
  await until("copied into the folder", async () => [onDisk("other", "Grid.inp"), onDisk("work", "Grid.inp"), await selected()], [true, true, "Grid.inp"]);
  await menuOn("other");
  await pick("Paste");
  await until("again: a copy of its own name", () => onDisk("other", "Grid copy.inp"), true);

  await menuOn("work", "Grid.inp");
  await pick("Cut");
  await until("cut: dimmed", () => page.$eval(rowOf("work", "Grid.inp"), (row) => getComputedStyle(row).opacity), "0.5");
  await menuOn("work", "parts");
  await pick("Paste");
  await until("moved", async () => [onDisk("work", "Grid.inp"), onDisk("work", "parts", "Grid.inp")], [false, true]);
  await menuOn("other");
  check("once: nothing left to paste", (await entries()).includes("-Paste|Ctrl+V"), true);
  await press("Escape");

  // Keys; on a file, Paste is into its folder.
  await choose("work", "main.bdf");
  await press("Control+c");
  await choose("other", "keep.txt");
  await press("Control+v");
  await until("ctrl+c, ctrl+v", () => onDisk("other", "main.bdf"), true);
  await choose("work", "main.bdf");
  await press("Control+x");
  await choose("other");
  await press("Control+v");
  await until("a name taken: nothing moves", async () => [await app.notice(), onDisk("work", "main.bdf")], ['"main.bdf" is already there.', true]);
  await page.click(".notice");
  await choose("work", "parts", "results");
  await press("Control+v");
  await until("still cut: moved elsewhere", () => onDisk("work", "parts", "results", "main.bdf"), true);
  await tab("main.bdf");
  await until("its tab follows", app.path, t.path("work", "parts", "results", "main.bdf"));

  await menuOn("work", "parts");
  await pick("Cut");
  await menuOn("work", "parts", "results");
  await pick("Paste");
  await until("a folder into itself", async () => [await app.notice(), onDisk("work", "parts")], ['"parts" cannot go into itself or a folder inside it.', true]);
  await page.click(".notice");
  await menuOn("work", "parts");
  await pick("Copy");
  await menuOn("other");
  await pick("Paste");
  await until("a folder, with all in it", () => onDisk("other", "parts", "results", "main.bdf"), true);
  await go("other", "parts");
  await menuOn("other", "parts");
  await pick("Cut");
  await menuOn("work", "parts", "results");
  await pick("Paste");
  await until("a folder moved, open as it was", () => page.locator(rowOf("work", "parts", "results", "parts", "piece.inp")).count(), 1);

  // ---- Delete ---------------------------------------------------------------------------------------------

  await menuOn("other", "keep.txt");
  await pick("Delete");
  await until("asked first", async () => (await app.messages()).length, 1);
  check("the question", (await app.messages())[0], {
    message: `Are you sure you want to delete 'keep.txt'?\n\nYou can restore it from the ${TRASH}.`,
    title: "Delete",
    kind: "warning",
    buttons: { OkCancelCustom: [`Move to ${TRASH}`, "Cancel"] },
  });
  await until("cancelled: still there, the keyboard back", async () => [onDisk("other", "keep.txt"), await keyboardIn()], [true, "tree"]);
  await app.answerMessage("ok");
  await press("Delete");
  await until("delete: gone", () => onDisk("other", "keep.txt"), false);
  await until("the next one selected", selected, "main.bdf");
  await app.answerMessage("ok");
  await press(process.platform === "darwin" ? "Meta+Backspace" : "Delete");
  await until("and the key again", () => onDisk("other", "main.bdf"), false);
  await menuOn("work", "parts", "results", "parts");
  await pick("Delete");
  await until("a folder's question", async () => (await app.messages()).at(-1).message.split("\n")[0], "Are you sure you want to delete 'parts' and its contents?");
  check("cancelled", onDisk("work", "parts", "results", "parts"), true);

  // An open file deleted: its tab says so.
  await tab("main.bdf");
  await app.answerMessage("ok");
  await menuOn("work", "parts", "results", "main.bdf");
  await pick("Delete");
  await until("its tab says it is gone from the disk", () => page.locator(".banner").count(), 1);
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.type("!");
  await press("Control+s");
  await until("saving puts it back", () => onDisk("work", "parts", "results", "main.bdf") && t.read(join("work", "parts", "results", "main.bdf")), "!$*Heading\n");

  // ---- Open to the side -----------------------------------------------------------------------------------

  await choose("work", "parts", "piece.inp");
  await press("Control+Enter");
  await until("a pane beside, with it", async () => [await page.locator(".pane").count(), await app.path()], [2, t.path("work", "parts", "piece.inp")]);
  await press("Control+1");
  await menuOn("other", "Grid copy.inp");
  await pick("Open to the Side");
  await until("into the pane already beside", async () => [await page.locator(".pane").count(), await app.path()], [2, t.path("other", "Grid copy.inp")]);
  check("as a tab to stay", await page.locator(".pane.focused .strip .tab.active.preview").count(), 0);

  // ---- In Korean ---------------------------------------------------------------------------------------------

  const korean = await t.launch({ settings: { language: "ko" }, launchPath: t.path("work", "parts", "piece.inp") });
  await korean.page.waitForSelector(".row.selected");
  await korean.page.click(".row.selected", { button: "right" });
  await korean.page.waitForSelector(MENU);
  check("in Korean", (await entries(korean.page)).map((entry) => entry.split("|")[0]), [
    "측면에서 열기",
    REVEAL_KO,
    "터미널에서 열기",
    "—",
    "잘라내기",
    "복사",
    "—",
    "경로 복사",
    "상대 경로 복사",
    "—",
    "이름 바꾸기…",
    "삭제",
  ]);
  await t.close(korean);
}
