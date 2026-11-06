// Whole words: what they are, the toggle, and Change All Occurrences, which follows it.

const IDS = "GRID,101,0.101,1010,101.,x.101,2101,-101,101.5,.101";
const DECK = `${IDS}\nPart-1-1.Set-1, Set-10, 강101, nset=SET-1\n*Elset, elset=E1\nE1, E10, 2.1E11, e1\n`;

// Random lines of the pieces that make words and numbers hard, to hold the
// highlights against the core's search.
let seed = 7;
const next = (n) => (seed = (seed * 48271) % 2147483647) % n;
const PIECES = ["1", "0", "1.", ".1", "x", "_", "-", ",", "강", " ", "a1", "E1", "."];
const RANDOM = `${Array.from({ length: 24 }, () => Array.from({ length: 1 + next(12) }, () => PIECES[next(PIECES.length)]).join("")).join("\n")}\n`;

export default async function (t) {
  const { until, check } = t;
  t.write({ "deck.inp": DECK, "random.txt": RANDOM });
  const app = await t.launch({ launchPath: t.path("deck.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const FIND = ".findbar input[placeholder=Find]";
  const REPLACE = ".findbar input[placeholder=Replace]";
  const WORD = ".findbar button:text-is('ab')";
  const CASE = ".findbar button:text-is('Aa')";
  const status = async () => (await page.textContent(".findbar .status")).trim();
  const on = (button) => page.$eval(button, (e) => e.classList.contains("on"));
  const shown = () => page.$$eval(".slot:not(.hidden) .lines :is(.match, .found)", (els) => els.length);
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const selected = (row, at, n) => `Ln ${row}, Col ${at + n + 1} (${n} selected)`;

  // ---- What a whole word is, the same as in the core's own test ------------------------

  const marked = await page.evaluate(async () => {
    const { findMatches } = await import("/src/lib/syntax.ts");
    const hay = ["GRID,101,0.101,1010,101.,x.101,2101,-101,101.5,.101,1.01+2", "Part-1-1.Set-1, Set-10, 강101, *Nset, nset=Set-1"];
    const mark = (needle) =>
      hay.map((line) =>
        findMatches(line, needle, { caseSensitive: false, wholeWord: true })
          .reverse()
          .reduce((out, [a, b]) => out.slice(0, a) + "#" + out.slice(b), line),
      );
    return {
      ids: mark("101"),
      set: mark("set-1"),
      part: mark("part-1-1"),
      keyword: mark("*nset,"),
      comma: mark(",101"),
      overlapping: findMatches("xa.a.a", "a.a", { caseSensitive: true, wholeWord: true }),
      apart: findMatches("aaa", "aa", { caseSensitive: true, wholeWord: false }),
    };
  });
  check("a decimal point is part of the number", marked.ids[0], "GRID,#,0.101,1010,101.,x.#,2101,-#,101.5,.101,1.01+2");
  check("a letter past ASCII is a letter", marked.ids[1], "Part-1-1.Set-1, Set-10, 강101, *Nset, nset=Set-1");
  check("a name after a point is one of its own", marked.set[1], "Part-1-1.#, Set-10, 강101, *Nset, nset=#");
  check("so is one before it", marked.part[1], "#.Set-1, Set-10, 강101, *Nset, nset=Set-1");
  check("ends that are not word characters need nothing around them", [marked.keyword[1], marked.comma[0]], [
    "Part-1-1.Set-1, Set-10, 강101, # nset=Set-1",
    "GRID#,0.101,1010,101.,x.101,2101,-101,101.5,.101,1.01+2",
  ]);
  check("one inside a longer word does not hide one beside it", marked.overlapping, [[3, 6]]);
  check("matches do not overlap", marked.apart, [[0, 2]]);

  // ---- The toggle -----------------------------------------------------------------------

  await page.mouse.click(...(await app.at(0, 0)));
  await press("Control+f");
  await page.keyboard.type("101");
  check("off to start with", await on(WORD), false);
  check("its tooltip", await page.getAttribute(WORD, "title"), "Match whole word (Alt+W)");
  await until("off: every 101 shown", shown, 10);
  await page.click(WORD);
  await until("on: only those standing alone", async () => [await on(WORD), await shown()], [true, 3]);
  await app.shot("wholeword");
  await page.focus(FIND);
  await press("Enter");
  await until("enter finds the first", app.position, selected(1, 5, 3));
  await press("Enter");
  await until("past 0.101, 1010 and 101.", app.position, selected(1, IDS.indexOf("x.101") + 2, 3));
  await press("F3");
  await until("past 2101", app.position, selected(1, IDS.indexOf("-101") + 1, 3));
  await press("F3");
  await until("past 101.5, .101 and 강101, round again", async () => [await app.position(), await status()], [selected(1, 5, 3), "Wrapped around"]);
  await press("Shift+F3");
  await until("and back", app.position, selected(1, IDS.indexOf("-101") + 1, 3));

  await press("Alt+w");
  await until("alt+w in the bar turns it off", async () => [await on(WORD), await shown()], [false, 10]);
  await page.mouse.click(...(await app.at(3, 0)));
  await press("Alt+w");
  await until("and in the text, while the bar is open", async () => [await on(WORD), await shown()], [true, 3]);
  check("typing nothing", (await app.lines())[3], "E1, E10, 2.1E11, e1");
  await press("Escape");
  await until("the bar closed", () => page.locator(".findbar").count(), 0);
  await press("Alt+w");
  await press("Control+f");
  await until("with the bar closed, alt+w leaves it", () => on(WORD), true);
  check("and types nothing", (await app.lines())[3], "E1, E10, 2.1E11, e1");

  await page.fill(FIND, "01");
  await page.focus(FIND);
  await press("Enter");
  await until("no 01 stands alone", status, "No results");
  await page.click(WORD);
  await until("turning it off, the message is gone", status, "");
  await page.click(WORD);

  // Replace: a selection that is part of a longer word is no match to replace.
  await press("Control+h");
  await page.fill(FIND, "101");
  await page.fill(REPLACE, "#");
  await page.mouse.click(...(await app.at(0, IDS.indexOf("1010"))));
  await press("Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight");
  await until("101 of 1010 selected", app.position, selected(1, IDS.indexOf("1010"), 3));
  await page.click(".findbar button:text-is('Replace')");
  await until("it stays, and the next one is found", async () => [(await app.lines())[0], await app.position()], [IDS, selected(1, IDS.indexOf("x.101") + 2, 3)]);
  await page.click(".findbar button:text-is('Replace')");
  await until("that one is replaced", async () => (await app.lines())[0], IDS.replace("x.101", "x.#"));
  await page.click(".findbar button:text-is('Replace All')");
  await until("replace all: whole words only", async () => [await status(), (await app.lines())[0]], [
    "Replaced 2",
    "GRID,#,0.101,1010,101.,x.#,2101,-#,101.5,.101",
  ]);
  await press("Escape");
  await page.mouse.click(...(await app.at(2, 0)));
  await press("Control+z", "Control+z");
  await until("undone", app.lines, DECK.split("\n"));

  // ---- Change All Occurrences ---------------------------------------------------------------

  // Off, the word at the caret changes wherever it is, inside longer words too.
  await press("Control+f");
  await page.click(WORD);
  check("off again", await on(WORD), false);
  await press("Escape");
  await page.mouse.click(...(await app.at(3, 1)));
  await press("Control+F2");
  await until("ctrl+f2 on a word at the caret leaves it off", async () => [await page.inputValue(FIND), await on(WORD), await on(CASE)], ["E1", false, false]);
  await page.keyboard.type("TOP");
  await press("Control+Alt+Enter");
  await until("E10 and 2.1E11 too", async () => [await status(), (await app.lines()).slice(2, 4)], [
    "Replaced 5",
    ["*Elset, elset=TOP", "TOP, TOP0, 2.1TOP1, TOP"],
  ]);
  await press("Escape");
  await press("Control+z");
  await until("undone in one step", app.lines, DECK.split("\n"));

  // On, only where it stands alone.
  await press("Control+f");
  await page.click(WORD);
  await press("Escape");
  await page.mouse.click(...(await app.at(3, 1)));
  await press("Control+F2");
  await until("and on stays on", async () => [await page.inputValue(FIND), await on(WORD)], ["E1", true]);
  await page.keyboard.type("TOP");
  await press("Control+Alt+Enter");
  await until("E10 and 2.1E11 stay", async () => [await status(), (await app.lines()).slice(2, 4)], [
    "Replaced 3",
    ["*Elset, elset=TOP", "TOP, E10, 2.1E11, TOP"],
  ]);
  await press("Escape");
  await press("Control+z");
  await until("undone again", app.lines, DECK.split("\n"));

  // ---- The screen and the core agree -----------------------------------------------------------

  await app.open(t.path("random.txt"));
  const lines = RANDOM.split("\n");
  await until("the random lines", app.lines, lines);
  const needles = ["1", "a1", "1.1", "E1", "x", "-1", "_", "1,"];
  const expected = await page.evaluate(
    async ([lines, needles]) => {
      const { findMatches } = await import("/src/lib/syntax.ts");
      return needles.map((needle) => {
        let count = 0;
        let all = 0;
        const replaced = lines.map((line) => {
          const found = findMatches(line, needle, { caseSensitive: false, wholeWord: true });
          count += found.length;
          all += findMatches(line, needle, { caseSensitive: false, wholeWord: false }).length;
          return found.reverse().reduce((out, [a, b]) => out.slice(0, a) + "#" + out.slice(b), line);
        });
        return { needle, count, all, replaced };
      });
    },
    [lines, needles],
  );
  check("whole words leave some out, and keep some", expected.some(({ count, all }) => count > 0 && count < all), true);
  await page.mouse.click(...(await app.at(0, 0)));
  await press("Control+h");
  check("still on", await on(WORD), true);
  for (const { needle, count, replaced } of expected) {
    await page.fill(FIND, needle);
    await until(`${needle}: as many shown as there are`, shown, count);
    await page.fill(REPLACE, "#");
    await page.click(".findbar button:text-is('Replace All')");
    await until(`${needle}: the core replaces what the screen shows`, async () => [await status(), await app.lines()], [count ? `Replaced ${count}` : "No results", replaced]);
    await press("Escape");
    await page.mouse.click(...(await app.at(0, 0)));
    await press("Control+z");
    await until(`${needle}: undone`, app.lines, lines);
    await press("Control+h");
  }
  await press("Escape");

  // ---- In Korean ------------------------------------------------------------------------------

  const korean = await t.launch({ settings: { language: "ko" }, launchPath: t.path("deck.inp") });
  await korean.page.waitForSelector(".line");
  await korean.page.mouse.click(...(await korean.at(0, 0)));
  await korean.page.keyboard.press("Control+f");
  check("in Korean", await korean.page.getAttribute(".findbar button:text-is('ab')", "title"), "단어 단위로 (Alt+W)");
  await t.close(korean);
}
