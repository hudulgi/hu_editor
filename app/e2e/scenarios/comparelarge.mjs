// The compare window on files of many lines: only the rows on screen are drawn,
// going to a hunk scrolls to it however far, and the wheel and the overview on
// the right scroll too.

export default async function (t) {
  const { until, check } = t;
  const LINES = 200_000;
  const a = Array.from({ length: LINES }, (_, i) => `${i + 1}, ${i}., ${2 * i}., 0.`);
  // Long on both sides, to scroll sideways.
  a[2] = `3, ${"0., ".repeat(80)}0.`;
  const b = [...a];
  b[1000] = "1001, 1000., 2000., 0.5";
  b.splice(150_000, 0, "** inserted");
  b[LINES - 10 + 1] = "last change";
  t.write({ "a.inp": `${a.join("\n")}\n`, "b.inp": `${b.join("\n")}\n` });
  const app = await t.launch({ launchPath: t.path("b.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  await app.answerDialog(t.path("a.inp"));
  await app.menu("File", "Compare Active File With…");
  await until("a compare window", () => app.opened.length, 1);
  const cp = app.opened[0].page;
  await cp.waitForSelector(".compare-view .line");
  const status = async () => (await cp.textContent(".statusbar")).split(" · ")[0];
  const firstNumber = async (side) => Number(await cp.textContent(`.side.${side} .gutter .ln >> nth=0`));
  await until("three hunks", status, "3 differences");
  const drawn = await cp.locator(".side.left .line").count();
  check("only the rows on screen are drawn", drawn > 10 && drawn < 100, true);

  await cp.keyboard.press("F7");
  await until("the first, with lines above it", async () => [await status(), await firstNumber("left")], ["Difference 1 of 3", 998]);
  check("marked in its line", await cp.$$eval(".side.right .line.current .mark", (els) => els.map((e) => e.textContent)), ["0.5"]);
  await cp.keyboard.press("F7");
  await until("the next, far down", async () => [await status(), await firstNumber("right")], ["Difference 2 of 3", 149_998]);
  check("a line only on the right, nothing across", await cp.$$eval(".side.left .line.filler", (els) => els.length), 1);
  await cp.keyboard.press("Alt+End");
  await until("the last, near the end: as far down as it goes", async () => [await status(), await cp.textContent(".side.right .line.current")], [
    "Difference 3 of 3",
    "last change",
  ]);
  check("past the line only on the right, one apart", (await firstNumber("right")) - (await firstNumber("left")), 1);

  // The overview: where the hunks are; a click there scrolls.
  const box = await cp.locator(".overview").boundingBox();
  await cp.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until("clicked in the middle: the middle", async () => Math.abs((await firstNumber("left")) - LINES / 2) < 200, true);
  // The current hunk is off screen now: from here up or down.
  await cp.keyboard.press("Shift+F7");
  await until("Shift+F7: the one above", async () => [await status(), await firstNumber("left")], ["Difference 1 of 3", 998]);
  await cp.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await cp.keyboard.press("F7");
  await until("F7: the one below", status, "Difference 2 of 3");
  // Drawn where they are: the line only on the right, three quarters down, in green.
  const colors = await cp.$eval(".overview canvas", (canvas) => {
    const context = canvas.getContext("2d");
    const at = (fraction) => {
      const rows = context.getImageData(canvas.width >> 1, Math.floor(canvas.height * fraction) - 3, 1, 6).data;
      const found = [];
      for (let i = 0; i < rows.length; i += 4) if (rows[i + 3]) found.push(rows[i + 1] > rows[i] ? "green" : "other");
      return found.includes("green") ? "green" : found.length ? "other" : "none";
    };
    return [at(150_001 / 200_002), at(0.4)];
  });
  check("the overview shows the hunks", colors, ["green", "none"]);
  // A press on a mark goes to its hunk, even a few pixels off; elsewhere it only scrolls.
  await cp.keyboard.press("ControlOrMeta+Home");
  await until("from the start", () => firstNumber("left"), 1);
  const mark = box.y + box.height * (150_000.5 / 200_002);
  const cursor = () => cp.$eval(".overview", (e) => getComputedStyle(e).cursor);
  await cp.mouse.move(box.x + box.width / 2, mark + 3);
  await until("over a mark, the pointer shows it can be pressed", cursor, "pointer");
  await cp.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
  await until("away from them, not", cursor, "default");
  await cp.mouse.move(box.x + box.width / 2, mark - 2);
  await until("near one again", cursor, "pointer");
  await cp.mouse.move(box.x - 100, mark);
  await until("off the overview", cursor, "default");
  await cp.mouse.click(box.x + box.width / 2, mark + 3);
  await until("a press on its mark: that hunk, shown as F7 shows it", async () => [await status(), await firstNumber("right")], ["Difference 2 of 3", 149_998]);
  await cp.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  await until("away from any: only scrolled there", async () => Math.abs((await firstNumber("left")) - 0.4 * 200_002) < 200, true);
  check("the current hunk stays", await status(), "Difference 2 of 3");
  await cp.mouse.click(box.x + box.width / 2, box.y + box.height * (1000.5 / 200_002) - 2);
  await until("the first, near the top", async () => [await status(), await cp.textContent(".side.right .line.current")], ["Difference 1 of 3", "1001, 1000., 2000., 0.5"]);
  await cp.mouse.click(box.x + box.width / 2, box.y + box.height - 1);
  await until("at the bottom: the end", async () => (await firstNumber("left")) > LINES - 1000, true);

  await cp.keyboard.press("ControlOrMeta+Home");
  await until("Ctrl+Home: the start", () => firstNumber("left"), 1);
  const text = await cp.locator(".side.left .text").boundingBox();
  await cp.mouse.move(text.x + 50, text.y + 50);
  await cp.mouse.wheel(0, 200);
  await until("the wheel scrolls ten lines", () => firstNumber("left"), 11);
  await cp.keyboard.press("PageDown");
  await until("a page", async () => (await firstNumber("left")) > 30, true);
  await cp.keyboard.press("ControlOrMeta+End");
  await until("the end", async () => (await cp.$$eval(".side.right .gutter .ln", (els) => els.map((e) => e.textContent))).includes(String(LINES + 2)), true);
  await app.opened[0].shot("compare-large");
  await cp.keyboard.press("ControlOrMeta+Home");
  await until("at the long line", () => firstNumber("left"), 1);
  const [left, right] = [cp.locator(".side.left .text"), cp.locator(".side.right .text")];
  await left.evaluate((e) => (e.scrollLeft = 120));
  await until("both sides scroll sideways together", () => right.evaluate((e) => e.scrollLeft), 120);
  await right.evaluate((e) => (e.scrollLeft = 40));
  await until("whichever is scrolled", () => left.evaluate((e) => e.scrollLeft), 40);
}
