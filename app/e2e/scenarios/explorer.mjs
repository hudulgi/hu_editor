// The system explorer: roots, revealing a path, the address box, the keyboard.

export default async function (t) {
  t.write({
    ".hidden/deck.inp": "*Heading\n",
    "includes/materials/steel.inp": "*Material\n",
    "includes/mesh.bdf": "GRID    1\n",
    "part2.inp": "",
    "part10.inp": "",
  });
  const app = await t.launch({ launchPath: t.path(".hidden/deck.inp") });
  const { page } = app;
  const { until, check } = t;
  const selected = () => page.textContent(".row.selected .name");
  const names = () => page.$$eval(".tree .row .name", (els) => els.map((e) => e.textContent));
  const go = async (text) => {
    await page.fill(".address input", text);
    await page.press(".address input", "Enter");
  };

  // Started with a file: the tree opens down to it, through a hidden folder.
  await page.waitForSelector(".line");
  await until("starts at the file it was given", selected, "deck.inp");
  check("the groups", (await page.$$eval(".group", (g) => g.map((x) => x.textContent))).length, 2);
  check("a hidden folder on the way is shown, dimmed", (await page.$$eval(".row.hidden .name", (r) => r.map((x) => x.textContent))).includes(".hidden"), true);
  check("the address box follows", await page.inputValue(".address input"), t.path(".hidden/deck.inp"));

  // The address box: a folder expands, a quoted file opens, a bad path says so.
  await go(t.path("includes"));
  await until("a folder is selected", selected, "includes");
  await until("and expanded", async () => (await names()).includes("materials"), true);
  await go(`"${t.path("includes/materials/steel.inp")}"`);
  await until("a quoted file path opens", app.path, t.path("includes/materials/steel.inp"));
  await until("and is selected", selected, "steel.inp");
  await go(t.path("no/such/place"));
  await page.waitForSelector(".address-error");
  check("a bad path says so", (await page.textContent(".address-error")).startsWith("Not found"), true);

  // Natural order: part2 before part10.
  await go(t.path("includes"));
  await until("back in the folder", selected, "includes");
  const inFolder = await names();
  check("folders first", inFolder.indexOf("includes") < inFolder.indexOf("part10.inp"), true);
  check("natural order", inFolder.indexOf("part2.inp") < inFolder.indexOf("part10.inp"), true);

  // Keyboard: arrows move, Right opens, Left closes, Enter opens a file.
  await page.click(".row.selected");
  await until("clicking the open folder closes it", async () => (await names()).includes("materials"), false);
  await page.keyboard.press("ArrowRight");
  await until("right opens it", async () => (await names()).includes("materials"), true);
  await page.keyboard.press("ArrowLeft");
  await until("left closes it", async () => (await names()).includes("materials"), false);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await until("down moves", selected, "materials");
  await page.keyboard.press("ArrowDown");
  await until("into an open folder", selected, "steel.inp");
  await page.keyboard.press("ArrowDown");
  await until("and out of it", selected, "mesh.bdf");
  await page.keyboard.press("Enter");
  await until("enter opens the file", app.path, t.path("includes/mesh.bdf"));

  // Toolbar buttons: collapse all, and back to the open file.
  await page.click(".explorer button[title='Collapse all']");
  await until("collapse all", async () => (await names()).includes("mesh.bdf"), false);
  await page.click(".explorer button[title='Show the open file']");
  await until("show the open file", selected, "mesh.bdf");

  // Quick access lists the home folder.
  await page.click(".tree .row:has(.root-icon):has-text('Home')");
  await until("home expands", () => page.$eval(".tree .row:has(.root-icon):has-text('Home') + .row", (row) => parseInt(row.style.paddingLeft) > 8), true);
  await page.click(".tree .row:has(.root-icon):has-text('Home')");

  // A folder dropped on the window is revealed.
  await app.drop([t.path("includes/materials")]);
  await until("a dropped folder is revealed", selected, "materials");

  // Hidden folders that a revealed path runs through survive a refresh.
  await app.open(t.path(".hidden/deck.inp"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(200);
  await until("a refresh keeps a hidden folder on the way", selected, "deck.inp");
  await page.click(".strip .tab:has-text('mesh.bdf')");
  await page.click(".explorer button[title='Collapse all']");
  await page.click(".explorer button[title='Show the open file']");
  await until("back at the other file", selected, "mesh.bdf");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await until("and drops it once nothing runs through it", async () => (await names()).includes(".hidden"), false);

  // A new file appears when the window comes back to the front.
  await app.drop([t.path("includes/materials")]);
  await until("the folder again", selected, "materials");
  t.write({ "includes/materials/added.inp": "" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await until("a new file shows up on focus", async () => (await names()).includes("added.inp"), true);

  // After a restart it is where it was, and a typed path is not overwritten by that.
  await page.waitForTimeout(100);
  await page.reload();
  await page.waitForSelector(".row.selected");
  await until("after a restart", selected, "mesh.bdf");
}
