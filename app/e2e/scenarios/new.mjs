// New, Save, Save As. Native file dialogs answer from a queue.

export default async function (t) {
  // Typing Enter inserts the document's line break, which depends on the OS by default.
  const app = await t.launch({ settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".empty");
  const { until, check } = t;
  check("starts without a document", (await page.textContent(".empty")).includes("Ctrl+N"), true);

  // Ctrl+N: an empty Untitled-1, ready for typing.
  await page.keyboard.press("Control+n");
  await page.waitForSelector(".line");
  await until("new document", async () => [await app.path(), await app.lines()], ["Untitled-1", [""]]);
  check("plain text, UTF-8", /UTF-8 .*Plain text/.test(await app.status()), true);
  await page.keyboard.type("*Heading\n** new deck\n*Node\n1, 0., 0., 0.");
  await until("typing into it", app.lines, ["*Heading", "** new deck", "*Node", "1, 0., 0., 0."]);
  check("it is unsaved", (await app.status()).includes("Modified"), true);

  // Ctrl+S on a new document asks where to save it.
  await app.answerDialog(t.path("new.inp"));
  await page.keyboard.press("Control+s");
  await until("saved under the chosen name", app.path, t.path("new.inp"));
  check("the dialog suggested a name", await app.dialogCalls(), ["Untitled-1.inp"]);
  check("file written", t.read("new.inp"), "*Heading\n** new deck\n*Node\n1, 0., 0., 0.");
  await until("now an Abaqus deck, highlighted", async () => [(await app.status()).includes("Abaqus"), (await page.locator(".lines .keyword").count()) > 0], [true, true]);
  check("no longer modified", (await app.status()).includes("Modified"), false);
  await until("the explorer shows it", () => page.textContent(".row.selected .name"), "new.inp");

  // Ctrl+S again saves in place, without asking.
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n2, 1., 0., 0.");
  await page.keyboard.press("Control+s");
  await until("saved in place", () => t.read("new.inp"), "*Heading\n** new deck\n*Node\n1, 0., 0., 0.\n2, 1., 0., 0.");
  check("without asking again", (await app.dialogCalls()).length, 1);

  // Ctrl+Shift+S writes a copy and goes on there.
  await app.answerDialog(t.path("copy.inp"));
  await page.keyboard.press("Control+Shift+s");
  await until("save as", app.path, t.path("copy.inp"));
  await page.keyboard.type("\n3, 2., 0., 0.");
  await page.keyboard.press("Control+s");
  await until("later saves go to the new file", () => t.read("copy.inp").endsWith("3, 2., 0., 0."), true);
  check("the first file is left alone", t.read("new.inp").endsWith("2, 1., 0., 0."), true);

  // Each new document has its own tab, and closing one with changes asks.
  await page.keyboard.press("Control+n");
  await until("Untitled-2", app.path, "Untitled-2");
  await page.keyboard.type("scratch");
  await page.keyboard.press("Control+w");
  await page.waitForSelector(".dialog");
  await app.answerDialog(null); // the save dialog is cancelled
  await page.click(".dialog .primary");
  await until("cancelling the save dialog keeps the document", async () => [await app.path(), (await app.lines())[0]], ["Untitled-2", "scratch"]);
  await page.keyboard.press("Control+w");
  await page.waitForSelector(".dialog");
  await page.click(".dialog button:has-text(\"Don't Save\")");
  await until("don't save closes it", app.path, t.path("copy.inp"));

  // A blank new document gives way to the next file; one with text does not.
  await page.keyboard.press("Control+n");
  await until("Untitled-3", app.path, "Untitled-3");
  await app.open(t.path("new.inp"));
  await until("the blank tab is replaced", app.tabs, ["copy.inp", "*new.inp"]);
}
