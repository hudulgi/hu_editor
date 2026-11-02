// The settings window, the language mode, and each setting's effect.

const DECK = Array.from({ length: 200 }, (_, i) => `GRID    ${String(i + 1).padStart(8)}        0.0     0.0     0.0`).join("\n") + "\n";

export default async function (t) {
  t.write({
    "deck.bdf": DECK,
    "other.bdf": "GRID    1\n",
    "plain.inp": "*Node\n1, 0., 0., 0.\n",
    "sjis.inp": Buffer.from("** \x93\xFA\x96\x7B\x8C\xEA\n*Node\n", "latin1"), // ** 日本語
    "unknown.blk": "some words\n",
    "three.inp": "aaa\nbbb\nccc\n",
    "utf8.inp": "** 한글\n*Node\n",
    ".secret": "hidden\n",
  });
  const app = await t.launch();
  const { page } = app;
  await page.waitForSelector(".empty");
  const { until, check } = t;
  const SLOT = ".slot:not(.hidden)";
  const open = (name) => app.open(t.path(name));
  const firstMenu = (app) => app.page.textContent(".menubar .title");
  const fontSize = () => page.$eval(`${SLOT} .lines`, (e) => getComputedStyle(e).fontSize);
  const rowHeight = () => page.$eval(`${SLOT} .lines .line`, (e) => e.getBoundingClientRect().height);
  check("starts in the OS language", await firstMenu(app), "File");

  // Opens from the menu and from Ctrl+,; Ctrl+, and Esc close it.
  await app.menu("File", "Settings…");
  await page.waitForSelector(".settings");
  await page.keyboard.press("Escape");
  await until("esc closes", () => page.locator(".settings").count(), 0);
  await page.keyboard.press("Control+,");
  await until("ctrl+, opens", () => page.locator(".settings").count(), 1);
  await page.keyboard.press("Control+,");
  await until("ctrl+, closes", () => page.locator(".settings").count(), 0);

  // Language: everything switches at once, without a restart.
  await app.menu("File", "Settings…");
  await page.selectOption(".settings select", "ko");
  await until("the dialog switches", () => page.textContent(".settings h1"), "설정");
  await until("the menu switches", () => firstMenu(app), "파일(F)");
  await until("the explorer switches", () => page.textContent(".explorer .title"), "탐색기");
  await until("the file has it", () => app.savedSettings()?.language, "ko");
  await app.shot("settings-general-ko");
  await app.settingsCategory("단축키");
  check("the shortcut list", (await page.$$(".settings table tr")).length > 10, true);
  await app.shot("settings-shortcuts-ko");
  await app.closeSettings();

  // Korean in the status bar and in errors from the core.
  await open("utf8.inp");
  await until("status bar in Korean", async () => (await app.status()).includes("줄 1, 열 1"), true);
  await page.keyboard.press("Control+f");
  await page.waitForSelector(".findbar");
  check("find bar too", await page.getAttribute(".findbar input", "placeholder"), "찾기");
  await page.keyboard.press("Escape");
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('변환 저장')");
  await page.click(".menu button.item:has-text('Windows-1252')");
  await until("a problem from the core is in Korean", app.notice, '저장하지 못했습니다: 1번째 줄의 "한" 글자는 Windows-1252(으)로 저장할 수 없습니다');
  await app.shot("error-ko");
  await page.click(".notice");

  // And back; the names of encodings and solvers never change.
  await page.keyboard.press("Control+,");
  await page.selectOption(".settings select", "en");
  await app.closeSettings();
  await until("English again", () => firstMenu(app), "File");
  check("the encoding's name is the same", await app.encoding(), "UTF-8");

  // Font size: half-typed values wait; out of range is clamped when done.
  await open("deck.bdf");
  check("default line height", await rowHeight(), 20);
  await app.openSettings("Editor");
  const size = app.numberSetting("Font size");
  await size.fill("20");
  await until("size 20 grows the lines", rowHeight, 31);
  check("the font follows", await fontSize(), "20px");
  await size.fill("1");
  check("half-typed values wait", await fontSize(), "20px");
  await page.keyboard.press("Tab");
  await until("a value out of range is clamped when done", fontSize, "8px");
  check("and shown", await size.inputValue(), "8");
  await size.fill("13");
  await page.fill(".settings input[list]", "Courier New");
  await until("the font name is used", () => page.$eval(`${SLOT} .lines`, (e) => getComputedStyle(e).fontFamily.split(",")[0].replace(/"/g, "")), "Courier New");
  await page.fill(".settings input[list]", "");

  // Editor switches.
  await app.toggleSetting("Show line numbers");
  await until("no line numbers", () => page.locator(`${SLOT} .gutter`).count(), 0);
  await app.toggleSetting("Highlight the current line");
  await until("no current line", () => page.locator(`${SLOT} .lines .line.current`).count(), 0);
  const shaded = () => page.$eval(`${SLOT} .lines .line .fb`, (e) => getComputedStyle(e).backgroundColor).catch(() => "none");
  const shade = await shaded();
  check("fields are shaded to start with", shade !== "rgba(0, 0, 0, 0)" && shade !== "none", true);
  await app.toggleSetting("Shade Nastran fields");
  await until("no shading", shaded, "rgba(0, 0, 0, 0)");
  await app.toggleSetting("Syntax highlighting");
  await until("no colors", () => page.$$eval(`${SLOT} .lines .line:first-child span`, (s) => new Set(s.map((e) => getComputedStyle(e).color)).size), 1);
  await app.shot("settings-editor");
  await app.closeSettings();
  await page.mouse.click(...(await app.at(1, 5)));
  await until("clicks work without a gutter", async () => (await app.position()).startsWith("Ln 2,"), true);
  await app.openSettings("Editor");
  await app.toggleSetting("Show line numbers");
  await app.toggleSetting("Highlight the current line");
  await app.toggleSetting("Shade Nastran fields");
  await app.toggleSetting("Syntax highlighting");

  // Tab key: spaces to a stop of the chosen size, or a tab character.
  await app.numberSetting("Spaces per tab stop").fill("4");
  await app.closeSettings();
  await open("other.bdf");
  await page.click(`${SLOT} .lines .line`);
  await page.keyboard.press("Home");
  await page.keyboard.type("a");
  await page.keyboard.press("Tab");
  await until("spaces to the next multiple of 4", async () => (await app.lines())[0], "a   GRID    1");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.lines())[0], "GRID    1");
  await app.openSettings("Editor");
  await app.selectSetting("Tab key", "tab");
  check("the size does not apply to a tab character", await app.numberSetting("Spaces per tab stop").isDisabled(), true);
  await app.closeSettings();
  await page.keyboard.press("Tab");
  await until("a tab character", async () => (await app.lines())[0], "\tGRID    1");
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.lines())[0], "GRID    1");
  await open("three.inp");
  await page.click(`${SLOT} .lines .line`);
  await page.keyboard.press("Home");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await page.keyboard.press("Tab");
  await until("a tab character in a box too", async () => (await app.lines()).slice(0, 3), ["\taaa", "\tbbb", "ccc"]);
  await page.keyboard.type("x");
  await until("the box's caret moved to the tab stop", async () => (await app.lines()).slice(0, 2), ["\txaaa", "\txbbb"]);
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.lines()).slice(0, 2), ["aaa", "bbb"]);
  await page.keyboard.press("Escape");
  await app.openSettings("Editor");
  await app.selectSetting("Tab key", "spaces");
  await app.numberSetting("Spaces per tab stop").fill("8");

  // New file encoding and line breaks.
  await app.settingsCategory("Files");
  await app.selectSetting("New file encoding", "cp949");
  await app.selectSetting("New file line breaks", "lf");
  await app.closeSettings();
  await page.keyboard.press("Control+n");
  await until("a new file in CP949, LF", async () => [await app.encoding(), (await app.status()).includes("LF")], ["CP949", true]);
  await page.keyboard.insertText("한글");
  await until("typed", async () => (await app.lines())[0], "한글");
  await app.answerDialog(t.path("saved-cp949.inp"));
  await page.keyboard.press("Control+s");
  await until("saved in CP949", () => t.read("saved-cp949.inp", "latin1"), "\xC7\xD1\xB1\xDB");
  await page.keyboard.press("Control+w");
  await app.openSettings("Files");
  await app.selectSetting("New file encoding", "utf8");
  await app.selectSetting("New file line breaks", "crlf");
  await app.closeSettings();
  await page.keyboard.press("Control+n");
  await until("a new file in UTF-8, CRLF", async () => [await app.encoding(), (await app.status()).includes("CRLF")], ["UTF-8", true]);
  await page.keyboard.press("Control+w");

  // What is not UTF-8 is read in the chosen encoding, from the next time it opens.
  await open("sjis.inp");
  await until("CP949 by default", async () => [await app.encoding(), (await app.lines())[0] === "** 日本語"], ["CP949", false]);
  await page.keyboard.press("Control+w");
  await app.openSettings("Files");
  await app.selectSetting("not UTF-8", "shiftJis");
  await app.closeSettings();
  await open("sjis.inp");
  await until("Shift-JIS with the setting", async () => [await app.encoding(), (await app.lines())[0]], ["Shift-JIS", "** 日本語"]);
  await page.keyboard.press("Control+w");

  // .blk whose content does not tell, also when already open.
  await open("unknown.blk");
  await until(".blk defaults to Nastran", app.language, "Nastran");
  await app.openSettings("Files");
  await app.selectSetting(".blk", "abaqus");
  await app.shot("settings-files");
  await app.closeSettings();
  await until("the open .blk follows", app.language, "Abaqus");

  // Hidden files in the explorer, at once.
  const inTree = (name) => page.locator(`.explorer .row:has-text('${name}')`).count();
  await until("a hidden file is not listed", () => inTree(".secret"), 0);
  await app.openSettings();
  await app.toggleSetting("Show hidden files");
  await app.closeSettings();
  await until("listed once asked", () => inTree(".secret"), 1);
  check("with its size", /\d\s*B/.test(await page.locator(`.explorer .row:has-text('.secret')`).textContent()), true);
  await app.openSettings();
  await app.toggleSetting("Show hidden files");
  await app.closeSettings();
  await until("gone again", () => inTree(".secret"), 0);

  // A modal window keeps keys and focus to itself.
  await page.click(`${SLOT} .lines .line`);
  await app.openSettings();
  const text = await app.lines();
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  check("Tab stays in the window", await page.evaluate(() => !!document.activeElement.closest(".settings")), true);
  await page.keyboard.press("Control+w");
  check("app shortcuts wait", (await page.locator(".strip .tab").count()) > 0 && (await page.locator(".settings").count()) === 1, true);
  await page.keyboard.type("x");
  check("typing does not reach the editor", await app.lines(), text);
  await app.closeSettings();
  check("focus returns to the editor", await page.evaluate(() => document.activeElement.tagName), "TEXTAREA");

  // Opening settings closes the encoding menu, so Esc is not shared.
  await page.click(".statusbar .status-button");
  await page.waitForSelector(".menu");
  await page.keyboard.press("Control+,");
  await until("the menu goes", () => page.locator(".menu").count(), 0);
  await app.closeSettings();

  // Settings survive a restart; the session setting decides what comes back.
  await app.setFontSize(16);
  await until("written to the file", () => app.savedSettings()?.fontSize, 16);
  await page.reload();
  await page.waitForSelector(".strip .tab");
  await until("the size stays after a restart", fontSize, "16px");
  await app.openSettings();
  await app.toggleSetting("Reopen the last files");
  await until("written", () => app.savedSettings()?.restoreSession, false);
  await app.closeSettings();
  await page.reload();
  await page.waitForSelector(".empty");
  check("no files come back with the setting off", await page.locator(".strip .tab").count(), 0);

  // A settings file that cannot be written is reported.
  const { mkdirSync, rmdirSync, writeFileSync } = await import("node:fs");
  const blocker = app.settingsPath.replace(/\.json$/, ".json.tmp");
  mkdirSync(blocker);
  await app.openSettings();
  await app.toggleSetting("Show hidden files");
  await app.closeSettings();
  await until("a failed save is reported", async () => ((await app.notice()) ?? "").startsWith("Settings could not be saved:"), true);
  rmdirSync(blocker);
  await page.click(".notice");

  // Reset to defaults.
  await app.openSettings();
  await page.click(".settings footer button:has-text('Reset')");
  await app.closeSettings();
  await until("reset", () => {
    const saved = app.savedSettings();
    return [saved?.fontSize, saved?.restoreSession, saved?.blkDefault, saved?.fallbackEncoding, saved?.tabSize];
  }, [13, true, "nastran", "cp949", 8]);

  // A damaged settings file: the app still starts, on defaults.
  writeFileSync(app.settingsPath, "{not json");
  app.expectedErrors.push(/settings not loaded/);
  await page.reload();
  await page.waitForSelector(".menubar");
  check("a damaged file: starts on defaults", await page.$eval(":root", (e) => e.style.getPropertyValue("--font-size")), "13px");

  // Odd values are kept in range or dropped.
  writeFileSync(app.settingsPath, JSON.stringify({ fontSize: 500, language: "fr", tabSize: "x", newFileEncoding: "ebcdic", fallbackEncoding: "utf8" }));
  await page.reload();
  await page.waitForSelector(".menubar");
  await app.openSettings("Editor");
  check("odd values", [await app.numberSetting("Font size").inputValue(), await app.numberSetting("Spaces per tab stop").inputValue()], ["32", "8"]);
  check("an unknown language falls back", await page.getAttribute("html", "lang"), "en");
  await app.closeSettings();

  // With no settings file, the OS language decides.
  const korean = await t.launch({ locale: "ko-KR" });
  check("a Korean OS starts in Korean", await firstMenu(korean), "파일(F)");
}
