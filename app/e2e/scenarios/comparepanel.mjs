// The sidebar's compare view: a file for each side, however it is given, then
// Compare opens them in a compare window.

export default async function (t) {
  const { until, check } = t;
  t.write({ "v1.inp": "*Heading\n** v1\n", "v2.inp": "*Heading\n** v2\n", "v3.inp": "*Heading\n** v3\n", "sub/x.inp": "" });
  const app = await t.launch({ launchPath: t.path("v2.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const VIEW = ".compare-panel";
  const sides = () => page.$$eval(`${VIEW} input`, (els) => els.map((e) => e.value));
  const problems = () => page.$$eval(`${VIEW} .problem`, (els) => els.map((e) => e.textContent));
  const button = (title, nth = 0) => page.locator(`${VIEW} button[title=${JSON.stringify(title)}]`).nth(nth);
  const compareButton = page.locator(`${VIEW} .primary`);
  const heads = (window) => window.page.$$eval(".head .name", (els) => els.map((e) => e.textContent));

  // ---- The view ---------------------------------------------------------------------

  await page.click(".activity button[aria-label='Compare']");
  await page.waitForSelector(`${VIEW}:visible`);
  check("the activity bar shows it", await page.getAttribute(".activity button[aria-label='Compare']", "aria-pressed"), "true");
  check("empty at first", await sides(), ["", ""]);
  check("nothing to compare yet", await compareButton.isDisabled(), true);
  await app.shot("compare-panel");

  // A path typed, and the active file.
  await page.fill("#compare-left", t.path("v1.inp"));
  check("one is not enough", await compareButton.isDisabled(), true);
  await button("Use the Active File", 1).click();
  check("the active file on the right", await sides(), [t.path("v1.inp"), t.path("v2.inp")]);
  await until("a long path shows its end", () => page.$eval("#compare-right", (e) => e.scrollLeft > 0 && e.scrollLeft + e.clientWidth >= e.scrollWidth - 1), true);
  await compareButton.click();
  await until("a compare window", () => app.opened.length, 1);
  const first = app.opened[0];
  await first.page.waitForSelector(".compare-view .line");
  check("left and right as given", await heads(first), ["v1.inp", "v2.inp"]);
  await until("compared", () => first.page.textContent(".statusbar"), "1 difference · 1 changed");
  await first.page.keyboard.press("ControlOrMeta+w");
  await until("closed", first.destroyed, 1);
  check("the sides stay", await sides(), [t.path("v1.inp"), t.path("v2.inp")]);

  // Swapped, and Enter compares.
  await button("Swap Left and Right").click();
  check("swapped", await sides(), [t.path("v2.inp"), t.path("v1.inp")]);
  await page.click("#compare-right");
  await page.keyboard.press("Enter");
  await until("Enter compares", () => app.opened.length, 2);
  await app.opened[1].page.waitForSelector(".compare-view .line");
  check("as swapped", await heads(app.opened[1]), ["v2.inp", "v1.inp"]);
  await app.opened[1].page.keyboard.press("ControlOrMeta+w");

  // What is not a file to compare.
  await page.fill("#compare-left", t.path("nothing.inp"));
  await page.fill("#compare-right", `"${t.path("sub")}"`);
  await compareButton.click();
  await until("told what is wrong", problems, ["Not found", "Not a file"]);
  await page.waitForTimeout(300);
  check("and no window", app.opened.length, 2);
  await page.fill("#compare-left", t.path("v3.inp"));
  check("typing clears its own", await problems(), ["Not a file"]);

  // Chosen with a dialog.
  await app.answerDialog(t.path("v1.inp"));
  await button("Choose a File…", 1).click();
  await until("chosen", sides, [t.path("v3.inp"), t.path("v1.inp")]);
  check("and fine now", await problems(), []);

  // Dropped from the OS: onto a side, or two at once.
  const box = async (side) => {
    const b = await page.locator(`${VIEW} .slot[data-side=${side}]`).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  await app.dragOver(await box("left"));
  await until("the side it is over shows it", () => page.locator(`${VIEW} .slot.over[data-side=left]`).count(), 1);
  await app.drop([t.path("v2.inp")], await box("left"));
  await until("dropped on the left", sides, [t.path("v2.inp"), t.path("v1.inp")]);
  check("not opened", await app.tabs(), ["*v2.inp"]);
  check("no longer shown as over", await page.locator(`${VIEW} .slot.over`).count(), 0);
  await app.drop([t.path("v3.inp"), t.path("v1.inp")], await box("right"));
  await until("two: one on each side", sides, [t.path("v3.inp"), t.path("v1.inp")]);
  await app.drop([t.path("v1.inp")], { x: 700, y: 300 });
  await until("elsewhere: opened as ever", app.tabs, ["v2.inp", "*v1.inp"]);
  check("the sides as they were", await sides(), [t.path("v3.inp"), t.path("v1.inp")]);

  // The explorer's Select for Compare puts its file on the left.
  await page.click(".activity button[aria-label^='Explorer']");
  await page.click(`.tree .row:has(> .name:text-is("v2.inp"))`, { button: "right" });
  await page.click(".drop-menu:not(.sub) .label:text-is('Select for Compare')");
  await page.click(".activity button[aria-label='Compare']");
  check("on the left", await sides(), [t.path("v2.inp"), t.path("v1.inp")]);

  await button("Clear").click();
  check("cleared", await sides(), ["", ""]);
  await page.fill("#compare-left", t.path("v1.inp"));

  // Kept for next time, and in Korean.
  await page.reload();
  await page.waitForSelector(".slot:not(.hidden) .line");
  check("the view shows again", await page.isVisible(VIEW), true);
  check("what was chosen too", await sides(), [t.path("v1.inp"), ""]);
  const korean = await t.launch({ settings: { language: "ko" } });
  await korean.page.click(".activity button[aria-label='비교']");
  check("in Korean", await korean.page.$$eval(`${VIEW} .label, ${VIEW} .primary`, (els) => els.map((e) => e.textContent)), ["왼쪽", "오른쪽", "비교"]);
  await t.close(korean);
}
