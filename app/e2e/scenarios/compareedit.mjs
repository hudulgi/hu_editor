// Lines edited in the compare window where they are shown, and lines shown in
// the editor of the window that opened it, in the same documents.

export default async function (t) {
  const { until, check } = t;
  const long = `** ${"x".repeat(20_000)}`;
  // Enough lines after to scroll.
  const more = Array.from({ length: 100 }, (_, i) => `${i + 10}, 0., 0.`);
  t.write({
    "a.inp": ["*Heading", "1, 0., 0.", "2, 1., 0.", long, "*End", ...more, ""].join("\n"),
    "b.inp": ["*Heading", "1, 0., 0.", "2, 1.5, 0.", long, "*End", ...more, ""].join("\n"),
  });
  const app = await t.launch({ launchPath: t.path("b.inp") });
  const { page } = app;
  await page.waitForSelector(".line");
  const held = await app.heldDocuments();
  await app.answerDialog(t.path("a.inp"));
  await app.menu("File", "Compare Active File With…");
  await until("a compare window", () => app.opened.length, 1);
  const cmp = app.opened[0];
  const cp = cmp.page;
  await cp.waitForSelector(".compare-view .line");
  const status = async () => (await cp.textContent(".statusbar")).split(" · ")[0];
  const line = (side, text) => cp.locator(`.side.${side} .line`, { hasText: new RegExp(`^${text.replace(/[.*]/g, "\\$&")}$`) });
  const dirty = () => cp.$$eval(".head", (els) => els.map((e) => e.textContent.includes("●")));
  const input = () => cp.locator(".side input.edit");
  await until("one difference", status, "1 difference");

  // ---- Edited where it is shown ------------------------------------------------------

  await line("left", "2, 1., 0.").dblclick();
  await until("a double click edits the line there", async () => [await input().count(), await input().inputValue()], [1, "2, 1., 0."]);
  check("on its side", await cp.locator(".side.left input.edit").count(), 1);
  check("all of it selected, to type over", await input().evaluate((e) => [e.selectionStart, e.selectionEnd]), [0, 9]);
  await cp.keyboard.type("2, 1.5, 0.");
  check("typing is the line's: compared once it is in", await status(), "Difference 1 of 1");
  await cp.keyboard.press("Enter");
  await until("Enter: the line is that", async () => [await status(), await input().count()], ["No differences", 0]);
  check("the left has changes now", await dirty(), [true, false]);
  check("the file not yet", t.read("a.inp").split("\n")[2], "2, 1., 0.");
  await cp.keyboard.press("ControlOrMeta+z");
  await until("undone in the compare window", async () => [await status(), await line("left", "2, 1., 0.").count()], ["1 difference", 1]);

  // F2 edits the line clicked last; Escape gives up; going elsewhere keeps what was typed.
  await line("right", "2, 1.5, 0.").click();
  await cp.keyboard.press("F2");
  await until("F2", async () => (await cp.locator(".side.right input.edit").count()) === 1, true);
  await cp.keyboard.type("2, 2., 0.");
  await cmp.shot("compare-edit");
  await cp.keyboard.press("ArrowDown");
  await cp.keyboard.press("PageDown");
  await cp.keyboard.press("ControlOrMeta+y");
  await page.waitForTimeout(150);
  const first = () => cp.textContent(".side.left .gutter .ln >> nth=0");
  check("its keys are its own: nothing scrolls, nothing is redone", [await first(), await line("left", "2, 1., 0.").count(), await input().inputValue()], ["1", 1, "2, 2., 0."]);
  await cp.keyboard.press("Escape");
  await until("Escape: as it was", async () => [await input().count(), await line("right", "2, 1.5, 0.").count(), await dirty()], [0, 1, [false, false]]);
  await cp.keyboard.press("F2");
  await cp.keyboard.type("2, 2., 0.");
  await line("left", "*Heading").click();
  await until("a click elsewhere: kept", () => line("right", "2, 2., 0.").count(), 1);
  await until("in the editor too: the same document", async () => (await app.lines())[2], "2, 2., 0.");
  check("unsaved there", await app.tabs(), ["*b.inp ●"]);

  // A line too long to show whole is edited in the editor.
  await cp.locator(".side.left .line", { hasText: "** xxxx" }).dblclick();
  await until("told", () => cp.textContent(".notice"), "The line is too long to edit here: open it in the editor.");
  check("no editing", await input().count(), 0);
  await cp.click(".notice");

  // ---- The line's own menu ---------------------------------------------------------

  const entries = () =>
    cp.$$eval(".drop-menu:not(.sub) > *", (els) => els.map((e) => (e.classList.contains("separator") ? "—" : `${e.disabled ? "-" : ""}${e.querySelector(".label").textContent}|${e.querySelector(".shortcut")?.textContent ?? ""}`)));
  await line("left", "2, 1., 0.").click({ button: "right" });
  await cp.waitForSelector(".drop-menu");
  check("a line of a hunk", await entries(), ["Edit Line|F2", "Open in Editor|Ctrl+E", "—", "Copy to Right|Alt+Right", "Copy to Left|Alt+Left"]);
  await cp.keyboard.press("Escape");
  await line("left", "*End").click({ button: "right" });
  await cp.waitForSelector(".drop-menu");
  check("a line alike on both sides", await entries(), ["Edit Line|F2", "Open in Editor|Ctrl+E"]);
  await cp.click(".drop-menu .label:text-is('Edit Line')");
  await until("edited from there", () => input().inputValue(), "*End");
  await cp.keyboard.press("Enter");
  await cp.waitForTimeout(300);
  check("Enter with nothing changed: no edit", [await input().count(), await dirty()], [0, [false, true]]);

  // ---- In the editor of the window that opened this one ------------------------------------

  await line("left", "2, 1., 0.").click({ button: "right" });
  await cp.click(".drop-menu .label:text-is('Open in Editor')");
  await until("the left file opens there, at the line", async () => [await app.tabs(), await app.position()], [["b.inp ●", "*a.inp"], "Ln 3, Col 1"]);
  await page.keyboard.type("x");
  await until("typed there: compared here", () => line("left", "x2, 1., 0.").count(), 1);
  await line("right", "*Heading").click();
  await cp.keyboard.press("ControlOrMeta+e");
  await until("Ctrl+E: the one open there already, at the line", async () => [await app.tabs(), await app.position()], [["*b.inp ●", "a.inp ●"], "Ln 1, Col 1"]);

  // a.inp is in both windows now: closing this one asks nothing, and the documents stay held there.
  await cp.keyboard.press("ControlOrMeta+w");
  await until("closed without asking", cmp.destroyed, 1);
  await until("a.inp now held by the editor's window", app.heldDocuments, held + 1);
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("ControlOrMeta+w");
    await page.click(`.dialog button:has-text("Don't Save")`);
  }
  await until("and let go of with its tabs, each held once more and no more", app.heldDocuments, held - 1);
}
