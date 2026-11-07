// Find and replace.

const DECK = "GRID    1       0.      0.      0.\nGRID    2       1.      0.      0.\nGRID    3\nGRID    4       3.      0.      0.\n$ 한글 comment\ngrid    5\n";

export default async function (t) {
  t.write({ "find.bdf": DECK });
  const app = await t.launch({ launchPath: t.path("find.bdf") });
  const { page } = app;
  await page.waitForSelector(".line");
  const { until } = t;
  const status = () => page.textContent(".findbar .status");
  const FIND = ".findbar input[placeholder=Find]";
  const REPLACE = ".findbar input[placeholder=Replace]";

  // Find: Enter goes on, Shift+Enter comes back, and it wraps around.
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+f");
  await page.keyboard.type("GRID    3");
  await page.keyboard.press("Enter");
  await until("find selects the match", app.position, "Ln 3, Col 10 (9 selected)");
  await page.keyboard.press("Enter");
  await until("the only match again: the count says it went round", status, "1 of 1");

  // Case is ignored unless asked for.
  await page.fill(FIND, "grid");
  await page.keyboard.press("Enter");
  await until("ignores case: the next one", app.position, "Ln 4, Col 5 (4 selected)");
  await page.keyboard.press("Shift+Enter");
  await until("shift+enter goes back", app.position, "Ln 3, Col 5 (4 selected)");
  await page.keyboard.press("F3");
  await until("f3 goes on", app.position, "Ln 4, Col 5 (4 selected)");
  await page.keyboard.press("Shift+F3");
  await until("shift+f3 goes back", app.position, "Ln 3, Col 5 (4 selected)");
  await page.click(".findbar button:has-text('Aa')");
  await page.focus(FIND);
  await page.keyboard.press("Enter");
  await until("match case finds the lower-case one", app.position, "Ln 6, Col 5 (4 selected)");
  await page.click(".findbar button:has-text('Aa')");

  // Korean, and nothing to find.
  await page.fill(FIND, "한글");
  await page.keyboard.press("Enter");
  await until("finds Korean", app.position, "Ln 5, Col 5 (6 selected)");
  await page.fill(FIND, "nowhere");
  await page.keyboard.press("Enter");
  await until("no results", status, "No results");

  // Esc closes it and typing goes on in the editor.
  await page.keyboard.press("Escape");
  await until("esc closes", () => page.locator(".findbar").count(), 0);
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("x");
  await until("focus is back in the editor", async () => (await app.lines())[0], "xGRID    1       0.      0.      0.");
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.lines())[0], "GRID    1       0.      0.      0.");

  // Replace: the first finds, the next replaces and finds again.
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+h");
  await page.waitForSelector(REPLACE);
  await page.fill(FIND, "0.");
  await page.fill(REPLACE, "0.0");
  await page.click(".findbar button[aria-label='Replace']");
  await until("the first Replace finds", app.position, "Ln 1, Col 19 (2 selected)");
  await page.click(".findbar button[aria-label='Replace']");
  await until("the next one replaces and finds the next", async () => [(await app.lines())[0], await app.position()], [
    "GRID    1       0.0      0.      0.",
    "Ln 1, Col 28 (2 selected)",
  ]);
  await page.click(".findbar button[aria-label='Replace All']");
  await until("Replace All", async () => [await status(), (await app.lines())[0]], [
    "Replaced 7",
    "GRID    1       0.00      0.0      0.0",
  ]);
  await app.shot("replaced");
  await page.keyboard.press("Escape");
  await page.click(".slot:not(.hidden) .lines .line");
  await page.keyboard.press("Control+z");
  await until("Replace All undoes in one step", async () => (await app.lines())[0], "GRID    1       0.0      0.      0.");
}
