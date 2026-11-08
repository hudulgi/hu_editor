// Laying out any number of panes: View > Editor Layout, and what goes with having
// more than two. (split.mjs goes through what each pane does on its own.)

const LINES = 400;
const DECK = Array.from({ length: LINES }, (_, i) => `GRID    ${i + 1}`).join("\n") + "\n";
const WIDE = "0123456789".repeat(60);

const PRESETS = {
  Single: [[0, 0, 1, 1]],
  "Two Columns": [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  "Three Columns": [[0, 0, 0.33, 1], [0.33, 0, 0.33, 1], [0.67, 0, 0.33, 1]],
  "Two Rows": [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]],
  "Three Rows": [[0, 0, 1, 0.33], [0, 0.33, 1, 0.33], [0, 0.67, 1, 0.33]],
  "Grid (2x2)": [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  "Two Rows Right": [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  "Two Columns Bottom": [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
};

export default async function (t) {
  const { until, check } = t;
  t.write({ "deck.bdf": DECK, "a.inp": "*Node\n", "b.inp": "*Element\n", "c.inp": "*Step\n", "wide.txt": `${WIDE}\n` });

  // ---- The tree by itself ---------------------------------------------------

  const empty = await t.launch();
  const treeResults = await empty.page.evaluate(async () => {
    const { arrange, flipped, leaves, presetLayout, presetOf, presetSlots, resized, splitAt, without } = await import("/src/lib/layout.ts");
    let random = 12345;
    const next = (n) => (random = (random * 48271) % 2147483647) % n;
    const close = (a, b) => Math.abs(a - b) < 1e-9;
    const problems = [];
    const valid = (node, up) => {
      if ("pane" in node) return;
      if (node.children.length < 2) problems.push("a split of one");
      if (node.direction === up) problems.push("a split inside one going the same way");
      if (!close(node.children.reduce((sum, child) => sum + child.share, 0), 1)) problems.push("shares do not add up");
      for (const child of node.children) valid(child.node, node.direction);
    };
    const tiled = (root) => {
      const { boxes, sashes } = arrange(root);
      const list = [...boxes.values()];
      const area = list.reduce((sum, box) => sum + box.width * box.height, 0);
      if (!close(area, 1)) problems.push(`area ${area}`);
      for (const [i, a] of list.entries()) {
        for (const b of list.slice(i + 1)) {
          const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (across > 1e-9 && down > 1e-9) problems.push("panes overlap");
        }
      }
      if (sashes.length !== list.length - 1) problems.push(`${sashes.length} sashes for ${list.length} panes`);
    };
    let root = { pane: 0 };
    let key = 1;
    let most = 0;
    for (let step = 0; step < 4000; step++) {
      const keys = leaves(root);
      most = Math.max(most, keys.length);
      const pick = keys[next(keys.length)];
      const action = next(10);
      if (action < 4 && keys.length < 12) root = splitAt(root, pick, key++, ["left", "right", "top", "bottom"][next(4)]);
      else if (action < 7 && keys.length > 1) {
        root = without(root, pick);
        if (leaves(root).includes(pick)) problems.push("the pane stayed");
      } else if (action < 9) {
        const { sashes } = arrange(root);
        if (sashes.length) root = resized(root, sashes[next(sashes.length)], next(120) / 100 - 0.1);
      } else {
        const before = JSON.stringify(root);
        if (leaves(flipped(root)).join() !== keys.join()) problems.push("a flip changed the order");
        if (JSON.stringify(flipped(flipped(root))) !== before) problems.push("two flips are not none");
      }
      valid(root, null);
      tiled(root);
    }
    const names = ["single", "twoColumns", "threeColumns", "twoRows", "threeRows", "grid", "twoRowsRight", "twoColumnsBottom"];
    const known = names.map((name) => presetOf(presetLayout(name, [...Array(presetSlots(name)).keys()])));
    const twoAcross = presetLayout("twoColumns", [0, 1]);
    const moved = resized(twoAcross, arrange(twoAcross).sashes[0], 0.01).children[0].share;
    const three = presetLayout("threeColumns", [0, 1, 2]);
    const none = presetOf(splitAt(three, 2, 3, "right"));
    return { problems: [...new Set(problems)], most, known, names, moved, none };
  });
  check("no step of a long random walk breaks the tree", treeResults.problems, []);
  check("the walk got somewhere", treeResults.most >= 8, true);
  check("each preset is known by its shape", treeResults.known, treeResults.names);
  check("a shape that is no preset", treeResults.none, null);
  check("a sash stops before a pane vanishes", Math.abs(treeResults.moved - 0.15) < 1e-9, true);

  // ---- The menu, with nothing open --------------------------------------------

  const SUB = ".menubar .panel.sub";
  const subEntries = (page) =>
    page.$$eval(`${SUB} > *`, (els) =>
      els.map((e) => (e.classList.contains("separator") ? "—" : `${e.disabled ? "-" : ""}${e.querySelector(".check").textContent}${e.querySelector(".label").textContent.trim()}${e.querySelector(".shortcut") ? `|${e.querySelector(".shortcut").textContent}` : ""}`)),
    );
  const openLayoutMenu = async (page) => {
    await page.click(".menubar .title:text-matches('^View$')");
    await page.click(".menubar .panel .label:text-matches('^Editor Layout$')");
    await page.waitForSelector(SUB);
  };
  await openLayoutMenu(empty.page);
  check("the layout menu, in its order: splits need no file", await subEntries(empty.page), [
    "Split Up",
    "Split Down",
    "Split Left",
    "Split Right",
    "—",
    "-Move Editor into New Window",
    "-Copy Editor into New Window",
    "—",
    "✓Single",
    "Two Columns",
    "Three Columns",
    "Two Rows",
    "Three Rows",
    "Grid (2x2)",
    "Two Rows Right",
    "Two Columns Bottom",
    "—",
    "-Flip Layout|Shift+Alt+0",
  ]);
  await empty.shot("panes-menu");
  await empty.page.keyboard.press("Escape");
  await empty.page.keyboard.press("Escape");
  // Ctrl+\\ needs no file either, and goes back to one.
  await empty.page.keyboard.press("Control+\\");
  await until("ctrl+\\ in an empty window", () => empty.page.locator(".pane .empty").count(), 2);
  await empty.page.keyboard.press("Control+\\");
  await until("and back", () => empty.page.locator(".pane").count(), 1);

  // In Korean, as the words of VS Code's menu.
  const korean = await t.launch({ settings: { language: "ko" } });
  await korean.page.click(".menubar .title >> nth=4");
  await korean.page.click(".menubar .panel .label >> text=편집기 레이아웃");
  await korean.page.waitForSelector(SUB);
  check(
    "in Korean",
    await korean.page.$$eval(`${SUB} .label`, (els) => els.map((e) => e.textContent.trim().replace(/\(.\)$/, ""))),
    ["위쪽 분할", "아래쪽 분할", "왼쪽 분할", "오른쪽 분할", "편집기를 새 창으로 이동", "편집기를 새 창으로 복사", "단일", "두 개 열", "세 개 열", "두 개 행", "세 개 행", "그리드(2x2)", "오른쪽 두 개 행", "아래쪽 두 개 열", "레이아웃 대칭 이동"],
  );
  await t.close(korean);

  // A layout without any file.
  await empty.layout("Grid (2x2)");
  await until("panes without a file", () => empty.page.locator(".pane .empty").count(), 4);
  await empty.page.keyboard.press("Control+w");
  await until("ctrl+w closes the empty pane", () => empty.page.locator(".pane").count(), 3);
  await t.close(empty);

  // ---- The menu by mouse and keyboard --------------------------------------------

  const app = await t.launch({ launchPath: t.path("deck.bdf"), settings: { newFileEol: "lf" } });
  const { page } = app;
  await page.waitForSelector(".line");
  const press = (...keys) => keys.reduce((done, key) => done.then(() => page.keyboard.press(key)), Promise.resolve());
  const subOpen = () => page.locator(SUB).count();
  const focusIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.tagName === "TEXTAREA") return `editor ${el.closest(".pane").dataset.pane}`;
      if (el.matches(".item")) return `${el.closest(".panel.sub") ? "sub" : "menu"}: ${el.querySelector(".label").textContent.trim()}`;
      return el.tagName;
    });
  const center = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const LABEL = (name) => `.menubar .panel .label:text-matches('^${name}$')`;

  await press("Alt+v");
  await press("l");
  await until("alt+v l opens it, with the keyboard on its first item", async () => [await subOpen(), await focusIn()], [1, "sub: Split Up"]);
  await press("ArrowDown", "ArrowDown");
  await until("the arrows stay inside it", focusIn, "sub: Split Left");
  await press("End");
  await until("end goes to its last available", focusIn, "sub: Two Columns Bottom");
  await press("Home");
  await until("home to its first", focusIn, "sub: Split Up");
  await press("ArrowLeft");
  await until("left goes back to the menu", async () => [await subOpen(), await focusIn()], [0, "menu: Editor Layout"]);
  await press("ArrowRight");
  await until("right opens it again", async () => [await subOpen(), (await focusIn()).startsWith("sub: ")], [1, true]);
  await press("Escape");
  await until("escape closes only it", async () => [await subOpen(), await focusIn()], [0, "menu: Editor Layout"]);
  await press("Enter");
  await until("enter opens it too", subOpen, 1);
  await press("Escape", "ArrowDown");
  await until("down moves on, past what is unavailable", focusIn, "menu: Command Palette…");
  await press("ArrowUp", "Escape");
  await until("the keyboard comes back", focusIn, "editor 0");
  await press("Alt+v", "l", "t");
  await until("letters pick inside it", () => page.locator(".pane").count(), 2);
  await until("the keyboard is back in the text", focusIn, "editor 0");
  await app.layout("Single");
  await until("one again", () => page.locator(".pane").count(), 1);

  // The mouse: hovering opens it, and it waits for a mouse going past other items.
  await page.click(".menubar .title:text-matches('^View$')");
  await page.mouse.move(...(await center(LABEL("Editor Layout"))));
  await until("hovering opens it", subOpen, 1);
  check("and leaves the keyboard on the item", await focusIn(), "menu: Editor Layout");
  await page.mouse.move(...(await center(LABEL("Line Numbers"))));
  check("it does not close at once", await subOpen(), 1);
  await page.mouse.move(...(await center(LABEL("Three Rows"))), { steps: 3 });
  await page.waitForTimeout(400);
  check("reaching it in time keeps it", [await subOpen(), await focusIn()], [1, "sub: Three Rows"]);
  await page.mouse.move(...(await center(LABEL("Field Shading"))));
  await until("going elsewhere closes it soon", subOpen, 0);
  await press("Escape");

  // ---- Every preset, from one pane ---------------------------------------------

  const fractions = () =>
    page.evaluate(() => {
      const room = document.querySelector(".panes").getBoundingClientRect();
      return [...document.querySelectorAll(".pane")]
        .sort((a, b) => a.dataset.pane - b.dataset.pane)
        .map((e) => {
          const box = e.getBoundingClientRect();
          return [(box.x - room.x) / room.width, (box.y - room.y) / room.height, box.width / room.width, box.height / room.height].map((v) => Math.round(v * 100) / 100);
        });
    });
  const PANE = (i) => `.pane[data-pane="${i}"]`;
  const paneCount = () => page.locator(".pane").count();
  const tabsOf = (i) =>
    page.$$eval(`${PANE(i)} .strip .tab`, (els) => els.map((e) => `${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}${e.classList.contains("dirty") ? " ●" : ""}`));
  const allTabs = () => page.evaluate(() => [...document.querySelectorAll(".pane")].sort((a, b) => a.dataset.pane - b.dataset.pane).map((p) => [...p.querySelectorAll(".strip .tab")].map((e) => `${e.classList.contains("active") ? "*" : ""}${e.querySelector(".name").textContent}`)));
  const linesOf = (i) => page.$$eval(`${PANE(i)} .slot:not(.hidden) .lines .line`, (els) => els.map((e) => e.textContent));
  const firstLineOf = (i) => page.$eval(`${PANE(i)} .slot:not(.hidden) .gutter .ln`, (e) => Number(e.textContent));
  const focused = () => page.$eval(".pane.focused", (e) => Number(e.dataset.pane));
  const checked = async () => {
    await openLayoutMenu(page);
    const items = (await subEntries(page)).filter((item) => item.startsWith("✓")).map((item) => item.slice(1));
    await press("Escape", "Escape");
    return items;
  };
  const goTo = async (line) => {
    await press("Control+g");
    await page.waitForSelector(".goto input");
    await page.keyboard.type(String(line));
    await press("Enter");
    await until(`at line ${line}`, app.position, `Ln ${line}, Col 1`);
  };
  const dragTo = async (from, to) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 5 });
    await page.mouse.up();
  };

  await goTo(200);
  const top = await firstLineOf(0);
  for (const [name, boxes] of Object.entries(PRESETS)) {
    const label = (text) => `${name}: ${text}`;
    await app.layout(name);
    await until(label("where the panes are"), fractions, boxes);
    check(label("the menu says so"), await checked(), [name]);
    check(label("a sash between each"), await page.locator(".pane-sash").count(), boxes.length - 1);
    check(label("the new panes are empty"), await page.locator(".pane .empty").count(), boxes.length - 1);
    await until(label("the keyboard and the place stay"), async () => [await focusIn(), await app.position(), await firstLineOf(0)], ["editor 0", "Ln 200, Col 1", top]);
    await until(label("as many rows as fit"), async () => {
      const { paneH, lineH } = await page.$eval(`${PANE(0)} .slot:not(.hidden) .text`, (e) => ({ paneH: e.clientHeight, lineH: e.querySelector(".line").getBoundingClientRect().height }));
      return (await linesOf(0)).length === Math.floor(paneH / lineH);
    }, true);
    await app.shot(`panes-${name.replace(/\W+/g, "-")}`);
    await app.layout("Single");
    await until(label("back to one"), fractions, PRESETS.Single);
  }

  // ---- Splitting a side at a time ----------------------------------------------

  const SPLITS = {
    "Split Up": [[[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]], 0],
    "Split Down": [[[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]], 1],
    "Split Left": [[[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], 0],
    "Split Right": [[[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], 1],
  };
  for (const [name, [boxes, at]] of Object.entries(SPLITS)) {
    await app.layout(name);
    await until(`${name}: where the panes are`, fractions, boxes);
    const other = 1 - at;
    await until(`${name}: the new pane is empty, and has the keyboard for what opens next`, async () => [await focused(), await focusIn(), await allTabs()], [
      at,
      "BODY",
      at === 0 ? [[], ["*deck.bdf"]] : [["*deck.bdf"], []],
    ]);
    check(`${name}: the other keeps its place`, await firstLineOf(other), top);
    await app.layout("Single");
    await until(`${name}: one again`, paneCount, 1);
    await goTo(200);
  }

  // A pane of a split splits alone; the same way, it shares with its neighbors.
  await app.layout("Split Right");
  await until("two", paneCount, 2);
  await app.layout("Split Down");
  await until("the right one splits alone", fractions, PRESETS["Two Rows Right"]);
  check("the menu knows that shape", await checked(), ["Two Rows Right"]);
  await app.layout("Split Right");
  await until("in the corner", fractions, [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.25, 0.5], [0.75, 0.5, 0.25, 0.5]]);
  check("no preset is that", await checked(), []);
  check("the new ones empty", await allTabs(), [["*deck.bdf"], [], [], []]);
  for (const n of [2, 3, 4]) {
    await press(`Control+${n}`);
    await app.open(t.path("deck.bdf"));
  }
  check("the same document in all, opened in each", await allTabs(), [["*deck.bdf"], ["*deck.bdf"], ["*deck.bdf"], ["*deck.bdf"]]);

  // An edit in one shows in all, and each stays on its own text.
  await press("Control+1", "Control+Home");
  await until("the first at the top", () => firstLineOf(0), 1);
  await page.keyboard.type("X");
  for (const i of [1, 2, 3]) await until(`pane ${i + 1} keeps its text`, async () => (await linesOf(i))[0].startsWith("GRID"), true);
  await until("all unsaved", allTabs, [["*deck.bdf"], ["*deck.bdf"], ["*deck.bdf"], ["*deck.bdf"]]);
  await until("marked in all", () => page.locator(".strip .tab.dirty").count(), 4);
  await press("Control+3", "Control+Home");
  await until("the third at the top", () => linesOf(2).then((lines) => lines[0]), "XGRID    1");
  await press("Control+z");
  await until("undone from another pane", async () => [(await linesOf(0))[0], (await linesOf(2))[0], await page.locator(".strip .tab.dirty").count()], ["GRID    1", "GRID    1", 0]);

  // All on the same lines: every pane shows every key, none of them asked to look.
  for (const n of [1, 2, 3, 4]) await press(`Control+${n}`, "Control+Home");
  await until("all at the top", async () => Promise.all([0, 1, 2, 3].map(firstLineOf)), [1, 1, 1, 1]);
  await press("Control+1");
  await page.keyboard.type("Y");
  for (const i of [1, 2, 3]) await until(`pane ${i + 1} shows the key`, async () => (await linesOf(i))[0], "YGRID    1");
  await press("Control+z");
  for (const i of [1, 2, 3]) await until(`pane ${i + 1} shows the undo`, async () => (await linesOf(i))[0], "GRID    1");

  // Ctrl+number goes to any pane; a pane that is not there changes nothing.
  for (const n of [4, 2, 1]) {
    await press(`Control+${n}`);
    await until(`ctrl+${n}`, async () => [await focused(), await focusIn()], [n - 1, `editor ${n - 1}`]);
  }
  await press("Control+7");
  await page.waitForTimeout(50);
  check("no seventh pane", await focused(), 0);

  // Switch Pane goes around them all.
  await app.menu("View", "Switch Pane");
  await until("to the next", focused, 1);
  await press("Control+4");
  await app.menu("View", "Switch Pane");
  await until("and from the last to the first", focused, 0);

  // A sash deep inside goes by its own split, whichever way it runs.
  const roomNow = await page.locator(".panes").boundingBox();
  const deepest = (selector) => page.locator(selector).last().boundingBox().then((box) => [box.x + box.width / 2, box.y + box.height / 2]);
  let [dx, dy] = await deepest(".pane-sash:not(.rows)");
  await dragTo([dx, dy], [roomNow.x + roomNow.width * 0.6, dy]);
  await until("a sash across a quarter of the room", fractions, [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.1, 0.5], [0.6, 0.5, 0.4, 0.5]]);
  await press("Shift+Alt+0");
  await until("flipped, with the sizes", fractions, [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.1], [0.5, 0.6, 0.5, 0.4]]);
  [dx, dy] = await deepest(".pane-sash.rows");
  await dragTo([dx, dy], [dx, roomNow.y + roomNow.height * 0.75]);
  await until("and along a quarter of it", fractions, [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.25], [0.5, 0.75, 0.5, 0.25]]);

  // ---- Flipping ----------------------------------------------------------------

  await app.layout("Two Rows Right");
  await until("merged to three", async () => [await paneCount(), await page.locator(".dialog").count()], [3, 0]);
  await until("no document is lost", async () => (await allTabs()).flat().every((tab) => tab.includes("deck.bdf")), true);
  await press("Control+2");
  const flipFrom = await linesOf(1);
  await press("Shift+Alt+0");
  await until("shift+alt+0 flips", fractions, PRESETS["Two Columns Bottom"]);
  check("the menu follows", await checked(), ["Two Columns Bottom"]);
  await until("the keyboard stays, and nothing was typed", async () => [await focused(), await focusIn(), (await linesOf(1))[0]], [1, "editor 1", flipFrom[0]]);
  check("nothing unsaved", await page.locator(".strip .tab.dirty").count(), 0);
  await app.layout("Flip Layout");
  await until("and back from the menu", fractions, PRESETS["Two Rows Right"]);

  // ---- Sizes ---------------------------------------------------------------------

  const room = await page.locator(".panes").boundingBox();
  const sashes = (direction) => page.locator(direction === "rows" ? ".pane-sash.rows" : ".pane-sash:not(.rows)");
  const centerOf = async (locator) => {
    const box = await locator.boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  let [sx, sy] = await centerOf(sashes("rows"));
  check("a sash across only its own split", (await sashes("rows").boundingBox()).width <= room.width / 2 + 2, true);
  await dragTo([sx, sy], [sx, room.y + room.height * 0.25]);
  await until("a sash inside a split resizes that split", fractions, [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.25], [0.5, 0.25, 0.5, 0.75]]);
  await until("the keyboard stays", focusIn, "editor 1");
  [sx, sy] = await centerOf(sashes("columns"));
  await dragTo([sx, sy], [room.x + room.width * 0.75, sy]);
  await until("the sash above it moves all it holds", fractions, [[0, 0, 0.75, 1], [0.75, 0, 0.25, 0.25], [0.75, 0.25, 0.25, 0.75]]);
  await press("Shift+Alt+0");
  await until("a flip keeps the sizes", fractions, [[0, 0, 1, 0.75], [0, 0.75, 0.25, 0.25], [0.25, 0.75, 0.75, 0.25]]);
  await app.layout("Two Columns Bottom");
  await until("a preset shares evenly again", fractions, PRESETS["Two Columns Bottom"]);

  // ---- Changing the layout moves nothing inside the panes ----------------------

  await app.layout("Single");
  await until("one", paneCount, 1);
  await app.open(t.path("wide.txt"));
  await press("End");
  await until("scrolled sideways", () => page.$eval(`${PANE(0)} .slot:not(.hidden) .text`, (e) => e.scrollLeft > 500), true);
  await app.layout("Grid (2x2)");
  await until("four", paneCount, 4);
  await page.$eval(`${PANE(0)} .slot:not(.hidden) textarea`, (e) => (e.__mark = "first"));
  const scrollLeft = await page.$eval(`${PANE(0)} .slot:not(.hidden) .text`, (e) => e.scrollLeft);
  const unmoved = () =>
    page.$eval(`${PANE(0)} .slot:not(.hidden)`, (e, scrollLeft) => [e.querySelector("textarea").__mark, e.querySelector(".text").scrollLeft === scrollLeft, document.activeElement === e.querySelector("textarea")], scrollLeft);
  await app.layout("Three Rows");
  await until("through a preset, the same editor with the keyboard and its scrolling", unmoved, ["first", true, true]);
  await press("Shift+Alt+0");
  await until("through a flip too", unmoved, ["first", true, true]);
  await page.mouse.move(...(await center(`${PANE(1)} .empty`)));
  await page.mouse.down();
  await page.mouse.up();
  await until("a click on an empty pane takes the keyboard from the text", async () => [await focused(), await focusIn()], [1, "BODY"]);
  await page.keyboard.type("q");
  await press("Control+1");
  await until("back, nothing typed", async () => [await focused(), await page.locator(".strip .tab.dirty").count()], [0, 0]);
  // A new pane before it: a pane element moved would lose its scrolling and the keyboard.
  await page.evaluate(() => {
    window.__panesMoved = 0;
    new MutationObserver((records) => {
      for (const { removedNodes } of records) for (const node of removedNodes) if (node.classList?.contains("pane")) window.__panesMoved++;
    }).observe(document.querySelector(".panes"), { childList: true });
  });
  await app.layout("Split Left");
  await until("the old pane is now the second", () => page.evaluate(() => [...document.querySelectorAll("textarea")].find((e) => e.__mark === "first")?.closest(".pane").dataset.pane), "1");
  check("and its element was not moved", await page.evaluate(() => window.__panesMoved), 0);
  await app.layout("Single");
  await until("single again", paneCount, 1);
  await page.click(`.strip .tab:has(.name:text-is('wide.txt'))`);
  await page.click(`.strip .tab:has(.name:text-is('wide.txt')) .close`);
  await until("closed", app.tabs, ["*deck.bdf"]);

  // ---- Tabs handed over keep their place --------------------------------------------

  await app.layout("Three Columns");
  await until("three", paneCount, 3);
  await press("Control+3");
  await app.open(t.path("deck.bdf"));
  await until("the deck in the third too", () => tabsOf(2), ["*deck.bdf"]);
  await goTo(300);
  const top300 = await firstLineOf(2);
  await press("Control+2");
  await app.open(t.path("a.inp"));
  await until("another file in the second", () => tabsOf(1), ["*a.inp"]);
  await press("Control+1");
  await goTo(50);
  await app.layout("Two Columns");
  await until("the third hands its tab to the second", allTabs, [["*deck.bdf"], ["*a.inp", "deck.bdf"]]);
  await page.click(`${PANE(1)} .strip .tab:has(.name:text-is('deck.bdf'))`);
  await until("with its place", async () => [await app.position(), await firstLineOf(1)], ["Ln 300, Col 1", top300]);
  await app.layout("Single");
  await until("one pane: this one's own place stays", async () => [await paneCount(), await app.position()], [1, "Ln 300, Col 1"]);
  await page.hover(".strip .tab:has(.name:text-is('a.inp'))");
  await page.click(".strip .tab:has(.name:text-is('a.inp')) .close");
  await until("closed", app.tabs, ["*deck.bdf"]);

  // ---- Empty panes -----------------------------------------------------------------

  await app.layout("Three Columns");
  await until("three", paneCount, 3);
  check("an empty pane says how to close it", await page.textContent(`${PANE(1)} .empty`).then((text) => text.includes("Ctrl+W")), true);
  await press("Control+2");
  await until("ctrl+2 reaches an empty pane", async () => [await focused(), await focusIn()], [1, "BODY"]);
  await app.shot("panes-empty");
  check("nothing to edit there", (await app.status()).includes("Ln "), false);
  await app.open(t.path("a.inp"));
  await until("a file opens in it", async () => [await tabsOf(1), await focused()], [["*a.inp"], 1]);
  await press("Control+3");
  await app.open(t.path("deck.bdf"));
  await until("a file open elsewhere shows in the empty pane too", async () => [await tabsOf(2), await focused()], [["*deck.bdf"], 2]);
  await press("Control+2");
  await app.open(t.path("deck.bdf"));
  await until("a pane with tabs goes to it, as before", focused, 0);

  // New files go there, and closing the last tab closes the pane again.
  await app.layout("Grid (2x2)");
  await until("four", paneCount, 4);
  await press("Control+4", "Control+n");
  await until("a new file in the empty pane", async () => (await tabsOf(3)).length, 1);
  await press("Control+w");
  await until("its last tab closes it", paneCount, 3);
  await app.layout("Grid (2x2)");
  await until("four again", paneCount, 4);
  await press("Control+4");
  await app.menu("File", "Close Tab");
  await until("the menu closes an empty pane too", paneCount, 3);
  await until("the keyboard goes to the one before", async () => [await focused(), await focusIn()], [2, "editor 2"]);

  // ---- Moving tabs among many ---------------------------------------------------------

  await app.layout("Three Columns");
  await until("three", paneCount, 3);
  await press("Control+1");
  await app.open(t.path("b.inp"));
  await until("to start", allTabs, [["deck.bdf", "*b.inp"], ["*a.inp"], ["*deck.bdf"]]);
  await press("Control+Alt+ArrowRight");
  await until("ctrl+alt+right to the next", allTabs, [["*deck.bdf"], ["a.inp", "*b.inp"], ["*deck.bdf"]]);
  await press("Control+Alt+ArrowRight");
  await until("and on", allTabs, [["*deck.bdf"], ["*a.inp"], ["deck.bdf", "*b.inp"]]);
  await press("Control+Alt+ArrowRight");
  await page.waitForTimeout(50);
  check("no further", await allTabs(), [["*deck.bdf"], ["*a.inp"], ["deck.bdf", "*b.inp"]]);
  await press("Control+Alt+ArrowLeft");
  await until("ctrl+alt+left back", allTabs, [["*deck.bdf"], ["a.inp", "*b.inp"], ["*deck.bdf"]]);
  await press("Control+3");
  await app.menu("View", "Move Tab to Other Pane");
  await until("the menu goes around the end: the document was there already, the pane closes", async () => [await paneCount(), await focused()], [2, 0]);

  // By dragging: the middle of a pane, or near an edge a new pane on that side of it.
  await app.layout("Two Columns");
  await page.click(`${PANE(1)} .strip .tab:has(.name:text-is('b.inp'))`);
  const zone = () => page.$eval(".pane.drop-target", (e) => `${e.dataset.pane} ${e.dataset.side ?? "whole"}`).catch(() => null);
  const dragTab = async (name, pane, fx, fy) => {
    await page.mouse.move(...(await center(`.strip .tab:has(.name:text-is('${name}'))`)));
    await page.mouse.down();
    const box = await page.locator(`${PANE(pane)} .editors`).boundingBox();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 5 });
  };
  await dragTab("b.inp", 0, 0.5, 0.95);
  check("the bottom of the other pane", await zone(), "0 bottom");
  await page.mouse.up();
  await until("splits that pane", fractions, [[0, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0, 0.5, 1]]);
  await until("and the tab has the keyboard there", async () => [await focused(), await tabsOf(1)], [1, ["*b.inp"]]);
  await dragTab("b.inp", 2, 0.5, 0.5);
  check("the middle of a pane", await zone(), "2 whole");
  await page.mouse.up();
  await until("moves it there; its pane, left empty, goes", async () => [await paneCount(), await focused()], [2, 1]);
  await until("the other takes the room", fractions, PRESETS["Two Columns"]);
  await app.layout("Three Rows");
  await until("rows", paneCount, 3);
  await page.mouse.move(...(await center(`.strip .tab:has(.name:text-is('b.inp'))`)));
  await page.mouse.down();
  const emptyBox = await page.locator(`${PANE(2)} .empty`).boundingBox();
  await page.mouse.move(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height * 0.95, { steps: 5 });
  check("an empty pane has no text to split: all of it is the target", await zone(), "2 whole");
  await page.mouse.up();
  await until("a tab dragged to an empty pane", () => tabsOf(2), ["*b.inp"]);

  // ---- Sessions --------------------------------------------------------------------

  await app.layout("Grid (2x2)");
  await until("grid", paneCount, 4);
  const [gridSash] = await centerOf(sashes("columns").first());
  const gridY = (await centerOf(sashes("columns").first()))[1];
  await dragTo([gridSash, gridY], [room.x + room.width * 0.3, gridY]);
  await until("resized", async () => (await fractions())[0][2], 0.3);
  await press("Control+3");
  const before = await allTabs();
  const boxes = await fractions();
  const focusBefore = await focused();
  await page.waitForTimeout(100);
  await page.reload();
  await until("the panes come back where they were", fractions, boxes);
  await until("with their tabs", allTabs, before);
  await until("and the keyboard", focused, focusBefore);

  // Older sessions still open.
  await page.evaluate((paths) => {
    localStorage.setItem("hu.paneShare", "0.25");
    localStorage.setItem("hu.session", JSON.stringify({ paths: [paths[0]], active: paths[0], second: { paths: [paths[1]], active: paths[1] }, direction: "rows", focused: 1 }));
    window.__e2eSeeded = true;
  }, [t.path("a.inp"), t.path("b.inp")]);
  const older = await page.evaluate(() => localStorage.getItem("hu.session"));
  await page.addInitScript((session) => {
    if (!sessionStorage.getItem("e2e.older")) {
      sessionStorage.setItem("e2e.older", "1");
      localStorage.setItem("hu.session", session);
    }
  }, older);
  await page.reload();
  await until("a session from before layouts", fractions, [[0, 0, 1, 0.25], [0, 0.25, 1, 0.75]]);
  await until("with its tabs", allTabs, [["*a.inp"], ["*b.inp"]]);
  await until("and the pane with the keyboard", focused, 1);

  // A pane saved empty stays empty; one whose files have gone goes.
  await page.evaluate((a) => {
    const saved = (paths) => ({ node: { paths, active: paths[0] ?? null }, share: 1 / 3 });
    const session = { layout: { direction: "columns", children: [saved([a]), saved([]), saved(["/no/such/file.inp"])] }, direction: "columns", focused: 0 };
    sessionStorage.setItem("e2e.next", JSON.stringify(session));
  }, t.path("a.inp"));
  await page.addInitScript(() => {
    const next = sessionStorage.getItem("e2e.next");
    if (next) {
      sessionStorage.removeItem("e2e.next");
      localStorage.setItem("hu.session", next);
    }
  });
  await page.reload();
  await until("a pane saved empty stays, a pane with its files gone goes", async () => [await paneCount(), await page.locator(".pane .empty").count()], [2, 1]);

  // ---- A small window ----------------------------------------------------------------

  await page.setViewportSize({ width: 480, height: 320 });
  await openLayoutMenu(page);
  const fits = await page.$eval(SUB, (e) => {
    const box = e.getBoundingClientRect();
    return [box.left >= 0, box.top >= 0, box.right <= innerWidth, box.bottom <= innerHeight];
  });
  check("the submenu stays inside the smallest window", fits, [true, true, true, true]);
  await app.shot("panes-small");
  await page.locator(LABEL("Flip Layout")).scrollIntoViewIfNeeded();
  await page.locator(LABEL("Grid .2x2.")).click();
  await until("still usable", paneCount, 4);
  await until("the first pane holds lines", async () => (await linesOf(0)).length > 0, true);
  await app.shot("panes-small-grid");
}
