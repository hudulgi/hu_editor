// Reading a file in another encoding, and saving it converted.

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const SJIS = Buffer.from("** \x93\xFA\x96\x7B\x8C\xEA\n*Node\n1, 0., 0., 0.\n", "latin1"); // ** 日本語
const CP949 = Buffer.from("** \xC7\xD1\xB1\xDB\n*Node\n1, 0., 0., 0.\n", "latin1"); // ** 한글

export default async function (t) {
  t.write({ "sjis.inp": SJIS, "cp949.inp": CP949, "wrong.inp": CP949, "utf8.inp": "** 한글\n*Node\n" });
  const app = await t.launch();
  const { page } = app;
  await page.waitForSelector(".empty");
  const { until, check } = t;
  const lines = app.lines;
  const pos = app.position;
  const label = app.encoding;
  const status = app.status;
  const notice = app.notice;
  const open = (name) => app.open(t.path(name));
  /** Picks an encoding in the menu: mode is "Read as" or "Save as". */
  const pick = async (mode, name) => {
    await page.click(".statusbar .status-button");
    await page.click(`.menu .modes button:has-text('${mode}')`);
    await page.click(`.menu button.item:has-text('${name}')`);
  };

  // Read as: Shift-JIS is detected wrongly until the user says what it is.
  await open("sjis.inp");
  await until("detected as CP949", label, "CP949");
  check("so it reads wrong", (await lines())[0] === "** 日本語", false);
  await pick("Read as", "Shift-JIS");
  await until("read as Shift-JIS", async () => [await label(), (await lines())[0]], ["Shift-JIS", "** 日本語"]);
  check("the file did not change", hex(t.read("sjis.inp", null)), hex(SJIS));
  check("and is not modified", (await status()).includes("Modified"), false);

  // Moving, finding and typing follow the encoding.
  await page.click(".slot:not(.hidden) .lines .line");
  await page.keyboard.press("End");
  await until("caret counts characters", pos, "Ln 1, Col 7");
  await page.keyboard.press("Shift+ArrowLeft");
  await until("selection counts bytes of one character", pos, "Ln 1, Col 6 (2 selected)");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+f");
  await page.keyboard.type("日本");
  await page.keyboard.press("Enter");
  await until("find encodes the search in Shift-JIS", pos, "Ln 1, Col 6 (4 selected)");
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  await page.keyboard.insertText("本");
  await until("typing", async () => (await lines())[0], "** 日本語本");

  // With unsaved changes only the current encoding can be picked.
  await page.click(".statusbar .status-button");
  await page.waitForSelector(".menu");
  check("reading is blocked while modified", await page.$$eval(".menu button.item", (b) => b.map((x) => x.disabled)), [true, true, true, false, true, true, true]);
  check("and says why", (await page.textContent(".menu p")).startsWith("Save or undo"), true);
  await page.keyboard.press("Escape");
  await until("escape closes the menu", () => page.locator(".menu").count(), 0);
  await page.keyboard.press("Control+s");
  await until("saved", async () => /Modified|Saving/.test(await status()), false);
  check("typed text went in as Shift-JIS", hex(t.read("sjis.inp", null)), hex(Buffer.from("** \x93\xFA\x96\x7B\x8C\xEA\x96\x7B\n*Node\n1, 0., 0., 0.\n", "latin1")));

  // The choice stays with the file across a restart; Auto-detect forgets it.
  await page.reload();
  await page.waitForSelector(".strip .tab");
  await until("remembered after a restart", async () => [await label(), (await lines())[0]], ["Shift-JIS", "** 日本語本"]);
  await pick("Read as", "Auto-detect");
  await until("auto-detect again", label, "CP949");
  await page.reload();
  await page.waitForSelector(".strip .tab");
  await until("and forgotten", label, "CP949");

  // Save as: the file is converted, and it opens anew at the same line.
  await open("cp949.inp");
  await until("CP949 detected", async () => [await label(), (await lines())[0]], ["CP949", "** 한글"]);
  await page.click(".slot:not(.hidden) .lines .line >> nth=2");
  await until("on line 3", async () => (await pos()).startsWith("Ln 3"), true);
  await pick("Save as", "UTF-8");
  await until("converted", async () => [await label(), (await lines())[0], (await status()).includes("Modified")], ["UTF-8", "** 한글", false]);
  check("the file is UTF-8 now", t.read("cp949.inp"), "** 한글\n*Node\n1, 0., 0., 0.\n");
  await until("still at the same line", pos, "Ln 3, Col 1");
  await page.keyboard.type("x");
  await until("editing goes on", async () => (await lines())[2], "x1, 0., 0., 0.");
  await page.keyboard.press("Control+z");

  // Save as the current encoding is a plain save: undo stays.
  await page.keyboard.type("y");
  await until("typed", async () => (await lines())[2], "y1, 0., 0., 0.");
  await pick("Save as", "UTF-8");
  await until("saved plainly", async () => /Modified|Saving/.test(await status()), false);
  check("with the edit", t.read("cp949.inp"), "** 한글\n*Node\ny1, 0., 0., 0.\n");
  await page.keyboard.press("Control+z");
  await until("undo still works", async () => (await lines())[2], "1, 0., 0., 0.");

  // It refuses rather than damages.
  await open("utf8.inp");
  await pick("Save as", "Windows-1252");
  await until("a character the encoding lacks", notice, 'Save failed: "한" on line 1 cannot be written in Windows-1252');
  check("leaves the file alone", t.read("utf8.inp"), "** 한글\n*Node\n");
  await until("and the encoding", label, "UTF-8");
  await page.click(".notice");
  await open("wrong.inp");
  await pick("Read as", "UTF-8");
  await until("bytes read wrongly show as replacement characters", async () => (await lines())[0].includes("�"), true);
  await pick("Save as", "CP949");
  await until("and are not converted", async () => ((await notice()) ?? "").includes("line 1 has bytes that are not valid UTF-8"), true);
  check("leaving the file alone", hex(t.read("wrong.inp", null)), hex(CP949));
  await page.click(".notice");
}
