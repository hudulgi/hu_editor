// The solver of a .blk file comes from its content; a clear extension wins over it.

const FILES = {
  "abaqus.blk": "*Node\n1, 0., 0., 0.\n*Element, type=C3D8R\n1, 1, 2, 3, 4, 5, 6, 7, 8\n",
  "comment_a.blk": "** only comments\n** here\n",
  "data.blk": "1, 0., 0., 0.\n2, 1., 0., 0.\n",
  "nastran.blk": "$ bulk\nGRID    1       0.      0.      0.\nCQUAD4  1       1       1       2       3       4\n",
  "large.BLK": "GRID*                  1                              0.              0.\n*                     0.\n",
  "unknown.blk": "just notes\n",
  "empty.blk": "",
  "named.inp": "GRID    1\n",
  "named.bdf": "*Node\n",
};

export default async function (t) {
  t.write(FILES);
  // Typing Enter inserts the document's line break, which depends on the OS by default.
  const app = await t.launch({ settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".empty");
  const { until, check } = t;
  const visible = ".slot:not(.hidden) .lines";
  const label = app.language;
  const badge = () => page.$eval(".strip .tab.active", (tab) => tab.querySelector(".badge")?.textContent ?? "");
  const has = (cls) => page.locator(`${visible} .${cls}`).count().then((n) => n > 0);
  /** The language as the status bar, the tab badge and the colors show it. */
  const shown = async () => [await label(), await badge(), await has("keyword"), await has("card")];
  const ABAQUS = ["Abaqus", "A", true, false];
  const ABAQUS_DATA = ["Abaqus", "A", false, false];
  const NASTRAN = ["Nastran", "N", false, true];
  const open = (name) => app.open(t.path(name));


  // The content decides for .blk.
  await open("abaqus.blk");
  await until("Abaqus keywords in .blk", shown, ABAQUS);
  await open("nastran.blk");
  await until("Nastran cards in .blk", shown, NASTRAN);
  await open("comment_a.blk");
  await until("Abaqus comments in .blk", async () => [await label(), await badge(), await has("comment")], ["Abaqus", "A", true]);
  await open("data.blk");
  await until("data-only Abaqus include", shown, ABAQUS_DATA);
  await open("large.BLK");
  await until("large-field Nastran, upper-case extension", shown, NASTRAN);
  await open("unknown.blk");
  await until("no evidence: Nastran, as before", async () => [await label(), await badge()], ["Nastran", "N"]);

  // A clear extension still wins over the content.
  await open("named.inp");
  await until(".inp stays Abaqus", async () => [await label(), await badge()], ["Abaqus", "A"]);
  await open("named.bdf");
  await until(".bdf stays Nastran", async () => [await label(), await badge()], ["Nastran", "N"]);

  // Tabs keep their own language.
  await page.click(".strip .tab:has-text('abaqus.blk')");
  await until("back to the Abaqus tab", shown, ABAQUS);
  await page.click(".strip .tab:has-text('nastran.blk')");
  await until("back to the Nastran tab", shown, NASTRAN);

  // The explorer does not read files, so it does not guess about .blk.
  const rowBadge = (name) => page.$eval(`.tree .row:has(.name:text-is("${name}"))`, (row) => row.querySelector(".badge")?.textContent ?? "");
  check("explorer: no badge on .blk", await rowBadge("abaqus.blk"), "");
  check("explorer: badges by clear extensions", [await rowBadge("named.inp"), await rowBadge("named.bdf")], ["A", "N"]);

  // Typing settles it, and undoing goes back.
  await open("empty.blk");
  await until("empty .blk starts as Nastran", async () => [await label(), await badge()], ["Nastran", "N"]);
  await page.keyboard.type("*Node");
  await until("typing a keyword makes it Abaqus", shown, ABAQUS);
  await page.keyboard.press("Control+z");
  await until("undo goes back", async () => [await label(), await badge()], ["Nastran", "N"]);
  await page.keyboard.type("GRID    1");
  await until("typing a card keeps it Nastran", shown, NASTRAN);
  await page.keyboard.press("Control+z");

  // Save As to .blk: the content decides; to .bdf: the extension does.
  await page.keyboard.press("Control+n");
  await until("a new document is plain", async () => [await label(), await badge()], ["Plain text", ""]);
  await page.keyboard.type("*Heading\n** new\n");
  await page.waitForTimeout(250);
  check("typing does not change a plain document", await label(), "Plain text");
  await app.answerDialog(t.path("saved.blk"));
  await page.keyboard.press("Control+s");
  await until("saved as .blk with Abaqus text", shown, ABAQUS);
  check("the file was written", t.read("saved.blk"), "*Heading\n** new\n");
  await app.answerDialog(t.path("saved.bdf"));
  await page.keyboard.press("Control+Shift+s");
  await until("saved again as .bdf: the extension decides", async () => [await label(), await badge()], ["Nastran", "N"]);

  // A changed file is detected again on reload... and after a restart.
  await page.reload();
  await page.waitForSelector(".strip .tab");
  await page.click(".strip .tab:has-text('abaqus.blk')");
  await until("restored tabs detect again", shown, ABAQUS);
}
