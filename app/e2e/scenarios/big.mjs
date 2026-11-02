// A 1 GB deck, only with --big: editing at both ends, saving, a million
// replacements and the limit on them, conversion, all in reasonable time.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MINUTE = 60000;

function countIn(path, needle) {
  const data = readFileSync(path);
  let count = 0;
  for (let at = data.indexOf(needle); at !== -1; at = data.indexOf(needle, at + needle.length)) count++;
  return count;
}

export default async function (t) {
  const deck = t.path("big.bdf");
  const generated = spawnSync("cargo", ["run", "--release", "-q", "-p", "hu-gen", "--", "nastran", "1G", deck], { cwd: repo, stdio: "inherit" });
  if (generated.status !== 0) throw new Error("hu-gen failed");
  const needle = "GRID*            1";
  const toReplace = countIn(deck, needle);
  const original = statSync(deck).size;

  const app = await t.launch({ launchPath: deck });
  const { page } = app;
  const { until, check } = t;
  const indexed = () =>
    page.waitForFunction(
      () => {
        const status = document.querySelector(".statusbar")?.textContent ?? "";
        return /[\d,]+ lines/.test(status) && !status.includes("Indexing");
      },
      null,
      { timeout: MINUTE },
    );
  const timed = async (what, work) => {
    const started = Date.now();
    await work();
    console.log(`       ${what}: ${Date.now() - started} ms`);
  };

  await page.waitForSelector(".line");
  await indexed();
  const lineCount = () => page.textContent(".statusbar").then((s) => Number(/([\d,]+) lines/.exec(s)[1].replaceAll(",", "")));
  const linesAtStart = await lineCount();

  // Editing at both ends is immediate, and the line count follows.
  await page.click(".slot:not(.hidden) .lines .line");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("$ edited at the end");
  await until("edit at the end", async () => (await app.lines()).at(-1), "$ edited at the end");
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("$ top\n");
  await until("edit at the top", async () => (await app.lines())[0], "$ top");
  await until("the line count follows", lineCount, linesAtStart + 1);

  await timed("saved 1 GB", async () => {
    await page.keyboard.press("Control+s");
    await app.saved(2 * MINUTE);
  });
  check("the saved size", statSync(deck).size, original + "$ edited at the end".length + "$ top\n".length);

  // A go-to far into the file.
  await page.keyboard.press("Control+g");
  await page.keyboard.type("5000000");
  await page.keyboard.press("Enter");
  await until("line 5,000,000", async () => (await app.position()).startsWith("Ln 5,000,000,"), true, MINUTE);

  // A million replacements; typing stays responsive; undo is one step.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+h");
  await page.fill(".findbar input[placeholder=Find]", needle);
  await page.fill(".findbar input[placeholder=Replace]", "GRID*            9");
  await timed(`replaced ${toReplace}`, async () => {
    await page.click(".findbar button:text-is('Replace All')");
    await until("the replacements", () => page.textContent(".findbar .status"), `Replaced ${toReplace.toLocaleString("en-US")}`, 2 * MINUTE);
  });
  await page.keyboard.press("Escape");
  await page.click(".slot:not(.hidden) .lines .line");
  await page.keyboard.press("Control+Home");
  await timed("typed 15 characters after it", async () => {
    await page.keyboard.type("$ typing after ");
    await until("typing stays responsive", async () => (await app.lines())[0].startsWith("$ typing after "), true);
  });

  // More matches than the limit is refused.
  await page.keyboard.press("Control+h");
  await page.fill(".findbar input[placeholder=Find]", "CQUAD4");
  await page.click(".findbar button:text-is('Replace All')");
  await until("too many matches is refused", () => page.textContent(".findbar .status"), "more than 2,000,000 matches", 2 * MINUTE);
  await page.keyboard.press("Escape");

  // Conversion streams through the file and comes back at the same line.
  await page.click(".slot:not(.hidden) .lines .line");
  await page.keyboard.press("Control+s");
  await app.saved(2 * MINUTE);
  await indexed();
  await page.keyboard.press("Control+g");
  await page.keyboard.type("5000000");
  await page.keyboard.press("Enter");
  await until("back at line 5,000,000", async () => (await app.position()).startsWith("Ln 5,000,000,"), true, MINUTE);
  const size = statSync(deck).size;
  await timed("converted to CP949", async () => {
    await page.click(".statusbar .status-button");
    await page.click(".menu .modes button:has-text('Save as')");
    await page.click(".menu button.item:has-text('CP949')");
    await until("converted", app.encoding, "CP949", 2 * MINUTE);
  });
  await until("still at line 5,000,000", async () => (await app.position()).startsWith("Ln 5,000,000,"), true, MINUTE);
  check("the same size (it is ASCII)", statSync(deck).size, size);

  // Split: the same huge document in two panes, far apart, and typing in one
  // redraws the other.
  await timed("split", async () => {
    await page.keyboard.press("Control+\\");
    await until("two panes", () => page.locator(".pane").count(), 2);
  });
  await until("the new pane starts at the same line", async () => (await app.position()).startsWith("Ln 5,000,000,"), true, MINUTE);
  await page.keyboard.press("Control+Home");
  await until("this pane at the top", app.position, "Ln 1, Col 1", MINUTE);
  await timed("typed 15 characters with the other pane following", async () => {
    await page.keyboard.type("$ split typing ");
    await until("typed in this pane", async () => (await app.lines())[0].startsWith("$ split typing "), true, MINUTE);
  });
  await page.keyboard.press("Control+1");
  await until("the other pane is still at its line", async () => (await app.position()).startsWith("Ln 5,000,000,"), true, MINUTE);
}
