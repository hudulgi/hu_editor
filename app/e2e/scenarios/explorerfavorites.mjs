// Favorites at the top of the explorer, as UltraEdit's file tree has them:
// files and folders added from their menu, kept, shared by the windows.

import { rmSync } from "node:fs";

export default async function (t) {
  const { until, check } = t;
  t.write({
    "work/deck.inp": "*Heading\n",
    "work/mesh.inp": "*Node\n",
    "lib/steel.inp": "*Material\n",
    "lib/sub/x.inp": "",
    "away/far.inp": "",
  });
  const app = await t.launch({ launchPath: t.path("work/deck.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const MOD = "ControlOrMeta";
  const MENU = ".drop-menu:not(.sub)";
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const PLACES = { work: ["work"], lib: ["lib"], away: ["away"], "deck.inp": ["work", "deck.inp"], "mesh.inp": ["work", "mesh.inp"], "mesh2.inp": ["work", "mesh2.inp"], "steel.inp": ["lib", "steel.inp"] };
  /** The `n`th row for that file of the test: a favorite comes before the same in the tree. */
  const row = (name, n = 0) => `.tree .row[title=${JSON.stringify(t.path(...PLACES[name]))}] >> nth=${n}`;
  /** The favorites, as their names and the folders they are in. */
  const favoritesIn = (where) =>
    where.$$eval(".tree > *", (els) => {
      const out = [];
      let inside = false;
      for (const e of els) {
        if (e.classList.contains("group")) inside = e.textContent === "Favorites";
        else if (inside && e.style.paddingLeft === "6px") out.push(`${e.querySelector(".name").textContent} ${e.querySelector(".where")?.textContent}`);
      }
      return out;
    });
  const favorites = () => favoritesIn(page);
  const groups = () => page.$$eval(".tree .group", (els) => els.map((e) => e.textContent));
  const entries = () =>
    page.$$eval(`${MENU} > *`, (els) => els.map((e) => (e.classList.contains("separator") ? "—" : `${e.disabled ? "-" : ""}${e.querySelector(".label").textContent}`)));
  const menuOn = async (selector) => {
    await page.click(selector, { button: "right" });
    await page.waitForSelector(MENU);
  };
  const pick = (label) => page.click(`${MENU} .label:text-is(${JSON.stringify(label)})`);
  const files = t.path();

  // ---- Adding ---------------------------------------------------------------------------------------

  check("none to start with, and no group for them", (await groups())[0], "Quick Access");
  await menuOn(row("lib"));
  await pick("Add to Favorites");
  await until("a folder at the top, with where it is", async () => [(await groups())[0], await favorites()], ["Favorites", [`lib ${files}`]]);
  await menuOn(row("mesh.inp"));
  await pick("Add to Favorites");
  await until("a file after it", favorites, [`lib ${files}`, `mesh.inp ${t.path("work")}`]);
  await page.click(row("deck.inp", 0));
  await page.click(row("away", 0), { modifiers: [MOD] });
  await menuOn(row("away", 0));
  await pick("Add to Favorites");
  await until("several at once, in the tree's order", favorites, [`lib ${files}`, `mesh.inp ${t.path("work")}`, `away ${files}`, `deck.inp ${t.path("work")}`]);
  await page.$eval(".tree", (tree) => (tree.scrollTop = 0));
  await app.shot("explorer-favorites");
  // One of them a favorite already, one not: the other alone is added.
  await page.click(row("mesh.inp", 1));
  await page.click(row("work", 0), { modifiers: [MOD] });
  await menuOn(row("mesh.inp", 1));
  await pick("Add to Favorites");
  await until("none twice", favorites, [`lib ${files}`, `mesh.inp ${t.path("work")}`, `away ${files}`, `deck.inp ${t.path("work")}`, `work ${files}`]);
  await menuOn(row("work", 0));
  await pick("Remove from Favorites");
  await until("out again", () => favorites().then((list) => list.length), 4);

  // ---- Using them -----------------------------------------------------------------------------------------

  await page.click(`.pane .strip .tab:has(.name:text-is("deck.inp"))`);
  await until("another file shown first", app.path, t.path("work", "deck.inp"));
  await page.click(row("mesh.inp", 0));
  await until("a favorite file opens", app.path, t.path("work", "mesh.inp"));
  await page.click(row("lib", 0));
  await until("a favorite folder opens under it", () => page.$eval(row("steel.inp", 0), (e) => e.style.paddingLeft), "20px");
  await menuOn(row("lib", 0));
  check("its menu: out of the favorites; the folder itself stays where it is", (await entries()).filter((e) => /Favorites|Cut|Rename|Delete/.test(e)), [
    "Remove from Favorites",
    "-Cut",
    "-Rename…",
    "-Delete",
  ]);
  await press("Escape");
  await menuOn(row("steel.inp", 0));
  check("what is in it is as anywhere", (await entries()).filter((e) => /Favorites|Cut|Rename|Delete/.test(e)), ["Add to Favorites", "Cut", "Rename…", "Delete"]);
  await press("Escape");

  // ---- Kept, and shared --------------------------------------------------------------------------------

  await page.reload();
  await page.waitForSelector(".tree .group");
  await until("kept", favorites, [`lib ${files}`, `mesh.inp ${t.path("work")}`, `away ${files}`, `deck.inp ${t.path("work")}`]);
  await press("Control+Shift+n");
  await until("a window opens", () => app.opened.length, 1);
  const other = app.opened[0];
  await other.page.waitForSelector(".tree .group");
  await until("another window has them", () => favoritesIn(other.page), await favorites());
  await menuOn(row("away", 0));
  await pick("Remove from Favorites");
  await until("taken out", favorites, [`lib ${files}`, `mesh.inp ${t.path("work")}`, `deck.inp ${t.path("work")}`]);
  await until("there too", () => favoritesIn(other.page), await favorites());

  // ---- When the disk changes ---------------------------------------------------------------------------

  // Picked without opening it, so that the keyboard stays in the tree.
  await menuOn(row("mesh.inp", 1));
  await press("Escape", "F2");
  await page.waitForSelector(".tree .name-edit input");
  await page.keyboard.type("mesh2");
  await press("Enter");
  await until("renamed in the tree: the favorite follows", favorites, [`lib ${files}`, `mesh2.inp ${t.path("work")}`, `deck.inp ${t.path("work")}`]);
  rmSync(t.path("lib"), { recursive: true });
  await page.click(".explorer button[title='Refresh']");
  // Its title says so too, after the path.
  const gone = `.tree .row[title^=${JSON.stringify(t.path("lib"))}][title$="Not found"]`;
  await until("gone from the disk: dimmed", () => page.$eval(gone, (e) => [e.classList.contains("missing"), e.title.endsWith("Not found")]), [true, true]);

  // ---- Taken out --------------------------------------------------------------------------------------------

  await menuOn(gone);
  await pick("Remove from Favorites");
  await page.click(row("mesh2.inp", 0));
  await page.click(row("deck.inp", 0), { modifiers: [MOD] });
  await menuOn(row("deck.inp", 0));
  check("all of those picked are favorites: out with them", (await entries()).includes("Remove from Favorites"), true);
  await pick("Remove from Favorites");
  await until("none left: no group", async () => [await favorites(), (await groups())[0]], [[], "Quick Access"]);
  check("the files stay", [t.read("work/mesh2.inp"), t.read("work/deck.inp")], ["*Node\n", "*Heading\n"]);
}
