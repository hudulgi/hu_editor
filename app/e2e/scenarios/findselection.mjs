// Searching for what is selected, going on without the bar, and how a
// selection and matches stand out.

const DECK =
  "GRID    1       0.      0.      0.\n" +
  "GRID    2       1.      0.      0.\n" +
  "CQUAD4  1       1       1       2\n" +
  "$ 한글 comment 한글\n" +
  "grid    5\n" +
  "CQUAD4  2       1       3       4\n";
const OTHER = "*Node\nCQUAD4 here\n";
const CP949 = Buffer.from("** \xC7\xD1\xB1\xDB \xC7\xD1\xB1\xDB\n*Node\n", "latin1"); // ** 한글 한글

/** WCAG contrast of two `rgb(r, g, b)` colors. */
function contrast(a, b) {
  const luminance = (color) => {
    const [r, g, c] = color
      .match(/\d+/g)
      .slice(0, 3)
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * c;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export default async function (t) {
  t.write({ "find.bdf": DECK, "other.inp": OTHER, "kr.inp": CP949 });
  const app = await t.launch({ launchPath: t.path("find.bdf") });
  const { page } = app;
  await page.waitForSelector(".line");
  const { until, check } = t;
  const FIND = ".findbar input[placeholder=Find]";
  const REPLACE = ".findbar input[placeholder=Replace]";
  const barOpen = async () => (await page.locator(".findbar").count()) === 1;
  const value = () => page.inputValue(FIND);
  const status = () => page.textContent(".findbar .status");
  const marked = (cls) => page.$$eval(`.slot:not(.hidden) .lines .${cls}`, (els) => els.map((e) => e.textContent));
  const focusIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el.tagName === "TEXTAREA" ? "editor" : (el.getAttribute("placeholder") ?? el.tagName);
    });
  const style = (selector) =>
    page.$eval(`.slot:not(.hidden) .lines ${selector}`, (el) => {
      const { backgroundColor, color } = getComputedStyle(el);
      return { background: backgroundColor, color };
    });
  const editorBg = () => page.$eval(".slot:not(.hidden) .editor", (el) => getComputedStyle(el).backgroundColor);
  const clickAt = async (row, col, clickCount = 1) => page.mouse.click(...(await app.at(row, col)), { clickCount });
  const closeBar = async () => {
    await page.focus(FIND);
    await page.keyboard.press("Escape");
    await until("the bar closes", barOpen, false);
  };

  // With nothing searched yet, F3 uses the word at the caret, and with no
  // word either it just opens the bar to type in.
  await clickAt(2, 7);
  await page.keyboard.press("F3");
  await until("f3 with nothing to search for opens the bar", barOpen, true);
  await until("to type in", focusIn, "Find");
  await closeBar();
  await clickAt(2, 2);
  await page.keyboard.press("F3");
  await until("f3 with a word at the caret finds it", app.position, "Ln 6, Col 7 (6 selected)");
  check("and fills the box", await value(), "CQUAD4");
  check("the keyboard stays in the editor", await focusIn(), "editor");
  await closeBar();

  // The selection goes into the box and stays where it is, the current match.
  await clickAt(2, 2, 2);
  await until("a word selected", app.position, "Ln 3, Col 7 (6 selected)");
  await page.keyboard.press("Control+f");
  await until("ctrl+f takes the selected text", value, "CQUAD4");
  check("the box has the keyboard", await focusIn(), "Find");
  check("with its text selected, to type over", await page.$eval(FIND, (el) => [el.selectionStart, el.selectionEnd]), [0, 6]);
  check("the selection stays", await app.position(), "Ln 3, Col 7 (6 selected)");
  await until("it is the current match", () => marked("found"), ["CQUAD4"]);
  await until("the other one on screen stands out too", () => marked("match"), ["CQUAD4"]);
  await app.shot("seeded");

  await page.keyboard.press("Enter");
  await until("enter goes on to the next", app.position, "Ln 6, Col 7 (6 selected)");
  check("the current match moved", (await marked("found")).length, 1);
  await page.keyboard.press("Shift+Enter");
  await until("shift+enter comes back", app.position, "Ln 3, Col 7 (6 selected)");
  await until("no wrap so far", status, "");

  // Selected backward the caret is at its start, but the search still leaves it behind.
  await clickAt(2, 6);
  await page.keyboard.press("Shift+Home");
  await until("selected backward", app.position, "Ln 3, Col 1 (6 selected)");
  await page.keyboard.press("Control+f");
  await until("backward, it is the current match", () => marked("found"), ["CQUAD4"]);
  await page.keyboard.press("Enter");
  await until("enter still goes on to the next", app.position, "Ln 6, Col 7 (6 selected)");

  // Lower case selected: the upper case ones match too, until Aa says otherwise.
  await clickAt(4, 1, 2);
  await page.keyboard.press("Control+f");
  await until("ctrl+f with the bar open takes it as well", value, "grid");
  await until("all cases stand out", async () => [await marked("found"), await marked("match")], [["grid"], ["GRID", "GRID"]]);
  await page.click(".findbar button:has-text('Aa')");
  await until("match case leaves one", () => marked("match"), []);
  await page.click(".findbar button:has-text('Aa')");

  // Pressing ctrl+f again while typing keeps what was typed, whatever is selected.
  await page.focus(FIND);
  await page.fill(FIND, "typed");
  await page.keyboard.press("Control+f");
  await until("ctrl+f in the box keeps the typed text", value, "typed");
  check("selecting it", await page.$eval(FIND, (el) => [el.selectionStart, el.selectionEnd]), [0, 5]);

  // Three bytes each in UTF-8: indices and bytes differ.
  await clickAt(3, 3, 2);
  await page.keyboard.press("Control+f");
  await until("korean", value, "한글");
  await until("korean matches", async () => [await marked("found"), await marked("match")], [["한글"], ["한글"]]);
  await page.keyboard.press("Enter");
  await until("the next korean", app.position, "Ln 4, Col 16 (6 selected)");

  // Several lines cannot go in the box.
  await clickAt(0, 0);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Control+f");
  await until("several lines leave the box as it was", value, "한글");
  await until("off the selection, no current match", () => marked("found"), []);

  // A box on one line is a selection; a taller one is not.
  await app.altDrag(await app.at(0, 0), await app.at(1, 4));
  await page.keyboard.press("Control+f");
  await until("a taller box leaves the box as it was", value, "한글");
  await app.altDrag(await app.at(2, 0), await app.at(2, 6));
  await page.keyboard.press("Control+f");
  await until("a box on one line goes in", value, "CQUAD4");
  await until("and becomes a selection", app.position, "Ln 3, Col 7 (6 selected)");
  check("the box is gone", await page.locator(".slot:not(.hidden) .box").count(), 0);
  await page.keyboard.press("Enter");
  await until("the search goes on from it", app.position, "Ln 6, Col 7 (6 selected)");

  // A moved caret counts: the search starts there, not at the last match.
  await page.fill(FIND, "grid");
  await clickAt(0, 0);
  await page.focus(FIND);
  await page.keyboard.press("Enter");
  await until("from the top", app.position, "Ln 1, Col 5 (4 selected)");
  await clickAt(3, 0);
  await page.focus(FIND);
  await page.keyboard.press("Enter");
  await until("from the moved caret", app.position, "Ln 5, Col 5 (4 selected)");

  // Closed, it keeps what to find; the highlights go.
  await closeBar();
  await until("no highlights without the bar", async () => [await marked("match"), await marked("found")], [[], []]);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+f");
  await until("ctrl+f shows the last search", value, "grid");
  await page.keyboard.type("GRID");
  await until("typed over", value, "GRID");
  await closeBar();

  // F3 with the bar closed goes on, leaving the keyboard in the editor.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F3");
  await until("f3 opens the bar and finds", app.position, "Ln 1, Col 5 (4 selected)");
  check("the bar shows", await barOpen(), true);
  check("the keyboard stays", await focusIn(), "editor");
  await page.keyboard.press("F3");
  await until("f3 again", app.position, "Ln 2, Col 5 (4 selected)");
  await page.keyboard.press("Shift+F3");
  await until("shift+f3 back", app.position, "Ln 1, Col 5 (4 selected)");
  await page.keyboard.type("X");
  await until("typing replaces the match in the editor", async () => (await app.lines())[0], "X    1       0.      0.      0.");
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.lines())[0], "GRID    1       0.      0.      0.");

  // Esc from the editor: first the selection, then the bar.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F3");
  await until("found again", app.position, "Ln 1, Col 5 (4 selected)");
  await page.keyboard.press("Escape");
  await until("esc drops the selection", app.position, "Ln 1, Col 5");
  check("the bar stays", await barOpen(), true);
  await page.keyboard.press("Escape");
  await until("esc again closes the bar", barOpen, false);
  check("the keyboard is in the editor", await focusIn(), "editor");

  // Ctrl+F3 starts from the selection or the word at the caret.
  await clickAt(2, 6);
  await page.keyboard.press("Control+F3");
  await until("ctrl+f3 with the caret just after a word", app.position, "Ln 6, Col 7 (6 selected)");
  check("fills the box", await value(), "CQUAD4");
  check("the keyboard stays", await focusIn(), "editor");
  await page.keyboard.press("Control+Shift+F3");
  await until("ctrl+shift+f3 goes back", app.position, "Ln 3, Col 7 (6 selected)");
  await clickAt(2, 0);
  await page.keyboard.press("Control+F3");
  await until("with the caret at its start it moves on as well", app.position, "Ln 6, Col 7 (6 selected)");
  await clickAt(1, 16, 2);
  await page.keyboard.press("Control+F3");
  await until("a selection replaces what to find", value, "1.");
  await until("the only one: it wraps onto itself", status, "Wrapped around");
  await closeBar();

  // Ctrl+H with a selection: only the replacement is left to type.
  await clickAt(1, 16, 2);
  await page.keyboard.press("Control+h");
  await page.waitForSelector(REPLACE);
  await until("ctrl+h takes the selected text", value, "1.");
  await until("and waits for the replacement", focusIn, "Replace");
  await page.keyboard.type("9.");
  await page.keyboard.press("Enter");
  await until("enter replaces the selection itself", async () => (await app.lines())[1], "GRID    2       9.      0.      0.");
  await until("nothing left", status, "No results");
  await closeBar();
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.lines())[1], "GRID    2       1.      0.      0.");
  await clickAt(0, 0);
  await page.keyboard.press("Control+h");
  await until("without a selection ctrl+h starts in the find box", focusIn, "Find");
  await closeBar();

  // Esc belongs to whatever else is open first.
  await clickAt(0, 0);
  await page.keyboard.press("F3");
  await until("the bar is open", barOpen, true);
  await page.keyboard.press("Control+g");
  await page.waitForSelector(".goto input");
  await page.keyboard.press("Escape");
  await until("esc closes go to line", () => page.locator(".goto").count(), 0);
  check("and leaves the bar", await barOpen(), true);
  await page.click(".statusbar .status-button");
  await page.waitForSelector(".menu");
  await page.keyboard.press("Escape");
  await until("esc closes the encoding menu", () => page.locator(".menu").count(), 0);
  check("and leaves the bar", await barOpen(), true);

  // Each tab shows the same search on its own text.
  await app.open(t.path("other.inp"));
  await page.waitForFunction(() => document.querySelector(".slot:not(.hidden) .lines .line")?.textContent === "*Node");
  await page.focus(FIND);
  await page.fill(FIND, "CQUAD4");
  await until("another tab highlights its own", () => marked("match"), ["CQUAD4"]);
  await page.keyboard.press("Enter");
  await until("and finds in its own text", app.position, "Ln 2, Col 7 (6 selected)");
  await until("as the current match", () => marked("found"), ["CQUAD4"]);

  // Another encoding: characters and bytes differ in a different way.
  await app.open(t.path("kr.inp"));
  await page.waitForFunction(() => document.querySelector(".slot:not(.hidden) .lines .line")?.textContent === "** 한글 한글");
  await until("read as CP949", app.encoding, "CP949");
  await closeBar();
  await clickAt(0, 3, 2);
  await page.keyboard.press("Control+f");
  await until("the selected Korean goes in", value, "한글");
  await until("and is the current match", async () => [await marked("found"), await marked("match")], [["한글"], ["한글"]]);
  await page.keyboard.press("Enter");
  await until("the core finds the next in CP949 bytes", app.position, "Ln 1, Col 9 (4 selected)");
  await closeBar();

  // How strongly they stand out, with syntax colors around them.
  await page.click(".strip .tab:has-text('find.bdf')");
  await page.waitForFunction(() => document.querySelector(".slot:not(.hidden) .lines .line")?.textContent?.startsWith("GRID"));
  const bg = await editorBg();
  await clickAt(2, 2, 2);
  await until("selected", app.position, "Ln 3, Col 7 (6 selected)");
  await app.shot("selection-focused");
  let seen = await style(".sel");
  check("a selection stands out", contrast(seen.background, bg) >= 3, true);
  check("its text is readable", contrast(seen.background, seen.color) >= 4.5, true);

  await page.keyboard.press("Control+f");
  await until("current", () => marked("found"), ["CQUAD4"]);
  await app.shot("matches");
  seen = await style(".found");
  check("the current match stands out with the keyboard elsewhere", contrast(seen.background, bg) >= 4.5, true);
  check("its text is readable", contrast(seen.background, seen.color) >= 4.5, true);
  seen = await style(".match");
  check("another match stands out", contrast(seen.background, bg) >= 3, true);
  check("its text is readable", contrast(seen.background, seen.color) >= 4.5, true);

  await page.fill(FIND, "nowhere");
  await until("a selection off the search", () => marked("found"), []);
  seen = await style(".sel");
  check("a selection without the keyboard still shows", contrast(seen.background, bg) >= 2.5, true);
  check("its text is readable", contrast(seen.background, seen.color) >= 4.5, true);
  await closeBar();

  // The box looks the same as a selection, its text white over any syntax color.
  await app.altDrag(await app.at(0, 0), await app.at(3, 2));
  await until("a box", app.position, "Ln 4 · Box 4 × 2");
  await app.shot("box");
  const boxBg = await page.$eval(".slot:not(.hidden) .box", (el) => getComputedStyle(el).backgroundColor);
  check("a box stands out", contrast(boxBg, bg) >= 3, true);
  seen = await style(".boxed");
  check("its text is readable", contrast(boxBg, seen.color) >= 4.5, true);
  check("the box covers the text", await marked("boxed"), ["GR", "GR", "CQ", "$ "]);
  await page.keyboard.press("Escape");
}
