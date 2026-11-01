// Typing, moving, selecting, the clipboard, the IME, saving.

const SETUP = {
  "edit.inp": "*Heading\n** test deck\n*Node\n1, 0., 0., 0.\n2, 1., 0., 0.\n*Element, type=C3D8R\n",
};

export default async function (t) {
  t.write(SETUP);
  const app = await t.launch({ launchPath: t.path("edit.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const { until, check } = t;

  // Click past the end of "*Node" (line 3) and type.
  const end3 = await app.at(2, 40);
  await page.mouse.click(...end3);
  await until("click past the end puts the caret at the line end", app.position, "Ln 3, Col 6");
  await page.keyboard.type(", nset=ALL");
  await until("typing", async () => (await app.lines())[2], "*Node, nset=ALL");

  // Enter, Backspace, Delete.
  await page.keyboard.press("Enter");
  await page.keyboard.type("** new line");
  await until("enter", async () => (await app.lines()).slice(2, 5), ["*Node, nset=ALL", "** new line", "1, 0., 0., 0."]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Home");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Delete");
  await until("backspace, home, delete", async () => (await app.lines())[3], " new li");
  await page.keyboard.press("Home"); // first non-blank
  await page.keyboard.press("Home"); // then column 1
  await page.keyboard.press("Backspace"); // joins with the line above
  await until("backspace at a line start joins lines", async () => (await app.lines())[2], "*Node, nset=ALL new li");

  // Arrows keep the column through short lines.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await until("down, end", app.position, "Ln 4, Col 14");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await until("up stops at the end of a short line", app.position, "Ln 2, Col 13");
  await page.keyboard.press("ArrowDown");
  await until("and down gets the column back", app.position, "Ln 3, Col 14");
  await page.keyboard.press("ArrowUp");

  // Shift selection, typing over it, undo and redo.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await until("shift+end selects", app.position, "Ln 2, Col 13 (12 selected)");
  await page.keyboard.press("Control+c");
  await until("copy", app.clipboard, "** test deck");
  await page.keyboard.type("** 한글 주석");
  await until("typing replaces the selection", async () => (await app.lines())[1], "** 한글 주석");
  await page.keyboard.press("Control+z");
  await until("undo restores the text and the selection", async () => [(await app.lines())[1], await app.position()], [
    "** test deck",
    "Ln 2, Col 13 (12 selected)",
  ]);
  await page.keyboard.press("Control+y");
  await until("redo", async () => (await app.lines())[1], "** 한글 주석");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await until("arrows over Korean: characters to move, bytes selected", app.position, "Ln 2, Col 7 (6 selected)");
  await page.keyboard.press("Control+x");
  await until("cut", async () => [await app.clipboard(), (await app.lines())[1]], ["주석", "** 한글 "]);

  // Paste of several lines, with Windows line breaks in the clipboard.
  await app.paste("PASTE\r\n2nd");
  await until("paste", async () => (await app.lines()).slice(1, 3), ["** 한글 PASTE", "2nd"]);

  // Korean composition, as a real IME drives it.
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press("End");
  for (const step of ["ㅎ", "하", "한", "한ㄱ", "한그", "한글"]) {
    await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
  }
  await cdp.send("Input.insertText", { text: "한글" });
  await until("a composition commits once", async () => (await app.lines())[2], "2nd한글");

  // Double-click selects a word.
  const word = await app.at(4, 3);
  await page.mouse.dblclick(...word);
  await until("double-click selects a word", app.position, "Ln 5, Col 6 (2 selected)");
  await until("the title shows unsaved changes", async () => (await app.title()).startsWith("● edit.inp"), true);
  check("so does the status bar", (await app.status()).includes("Modified"), true);

  await page.keyboard.press("Control+s");
  await app.saved();
  check(
    "saved file",
    t.read("edit.inp"),
    "*Heading\n** 한글 PASTE\n2nd한글\n*Node, nset=ALL new li\n1, 0., 0., 0.\n2, 1., 0., 0.\n*Element, type=C3D8R\n",
  );
  await until("the title is clean again", async () => (await app.title()).startsWith("●"), false);

  // Keys typed right before Ctrl+S reach the file, with no time to settle.
  await page.keyboard.press("Control+End");
  await page.keyboard.type("$ typed right before saving");
  await page.keyboard.press("Control+s");
  await until("nothing typed before saving is lost", () => t.read("edit.inp").endsWith("$ typed right before saving"), true);
  await app.saved();

  // Everything is undoable, back to the file as it was at the start.
  for (let i = 0; i < 25; i++) await page.keyboard.press("Control+z");
  await until("undo all the way", app.lines, SETUP["edit.inp"].split("\n"));

  // The file changing on disk is noticed.
  await page.keyboard.press("Control+s");
  await app.saved();
  t.write({ "edit.inp": "*Heading\n** from another program\n" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(".banner");
  await page.click(".banner button");
  await until("reload shows the new content", app.lines, ["*Heading", "** from another program", ""]);
}
