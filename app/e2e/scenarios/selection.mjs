// A selection and matches fill the height of their lines, read from the pixels
// on screen, at the font sizes and display scales in use on Windows.

const DECK =
  "  GRID    1       0.\n" +
  "  GRID    2       1.\n" +
  "\n" +
  "  $ 한글 comment\n" +
  "  a\tTAB\tfield\n" +
  "  GRID    6\n" +
  "  after\n" +
  `  ${"x".repeat(300)}\n`;

const SLOT = ".slot:not(.hidden)";

/** Every color on screen going straight down at `x`, from `top` to `bottom` in CSS pixels. */
async function colorsDown(page, x, top, bottom) {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, x, top, bottom }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const scale = window.devicePixelRatio;
      const from = Math.round(top * scale);
      const { data } = context.getImageData(Math.floor(x * scale), from, 1, Math.round(bottom * scale) - from);
      const colors = new Set();
      for (let i = 0; i < data.length; i += 4) colors.add(`rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`);
      return [...colors];
    },
    { png, x, top, bottom },
  );
}

const background = (page, selector) =>
  page.$eval(`${SLOT} .lines ${selector}`, (el) => getComputedStyle(el).backgroundColor);

/** How far the text of a row reaches, and where the rows are. */
const layout = (page, row) =>
  page.evaluate(
    ({ slot, row }) => {
      const lines = [...document.querySelectorAll(`${slot} .lines .line`)];
      const range = document.createRange();
      range.selectNodeContents(lines[row]);
      return { right: range.getBoundingClientRect().right, tops: lines.map((l) => l.getBoundingClientRect().top) };
    },
    { slot: SLOT, row },
  );

async function exercise(t, size, scale) {
  const name = `selection-${size}-${scale}`;
  t.write({ [`${name}.bdf`]: DECK });
  const app = await t.launch({ launchPath: t.path(`${name}.bdf`), settings: { fontSize: size }, scale });
  const { page } = app;
  await page.waitForSelector(".line");
  const { until, check } = t;
  const label = (text) => `size ${size} at ${scale * 100}%: ${text}`;
  const { x, y, lineH, cell } = await app.metrics();
  const down = x + cell / 2; // Through the blanks at the start of every line.
  const top = (row, from = y) => from + row * lineH;

  // Over several lines, a blank one among them: nothing shows between them.
  const before = await layout(page, 4);
  await page.mouse.click(...(await app.at(0, 0)));
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await until(label("selected"), app.position, "Ln 6, Col 12 (87 selected)");
  await app.shot(name);
  const selected = await background(page, ".sel");
  check(label("no gap between the lines"), await colorsDown(page, down, top(0) + 1, top(6) - 1), [selected]);
  const outside = await colorsDown(page, down, top(6) + 1, top(7) - 1);
  check(label("nothing past the last one"), outside.includes(selected), false);
  check(label("the rows stay where they were"), (await layout(page, 4)).tops, before.tops);

  // It does not move the text, tab stops included.
  await page.mouse.click(...(await app.at(4, 3)));
  await page.keyboard.press("Shift+End");
  await until(label("a line selected from just before its tab"), async () => (await app.position()).endsWith("(10 selected)"), true);
  const selectedLine = await layout(page, 4);
  check(label("its text stays put"), Math.abs(selectedLine.right - before.right) < 0.5, true);

  // Past the width of the pane the text is all there, selected or not.
  const uncut = () =>
    page.evaluate((slot) => {
      const line = document.querySelectorAll(`${slot} .lines .line`)[7];
      const range = document.createRange();
      range.selectNodeContents(line);
      return range.getBoundingClientRect().right <= line.getBoundingClientRect().right + 0.5;
    }, SLOT);
  check(label("a long line is not cut"), await uncut(), true);
  await page.mouse.click(...(await app.at(7, 0)));
  await page.keyboard.press("Shift+End");
  await until(label("a long line selected"), async () => (await app.position()).endsWith("(302 selected)"), true);
  check(label("nor when selected"), await uncut(), true);
  await page.keyboard.press("Control+Home");

  // A box reaches from line to line too.
  await app.altDrag(await app.at(0, 0), await app.at(5, 1));
  await until(label("a box"), app.position, "Ln 6 · Box 6 × 1");
  const boxColor = await page.$eval(`${SLOT} .box`, (el) => getComputedStyle(el).backgroundColor);
  check(label("no gap in a box"), await colorsDown(page, down, top(0) + 1, top(6) - 1), [boxColor]);
  await page.keyboard.press("Escape");

  // Matches fill their lines as well, each on its own.
  await page.mouse.click(...(await app.at(0, 0)));
  await page.keyboard.press("Control+f");
  await page.keyboard.type("  GRID");
  await page.keyboard.press("Enter");
  await until(label("found"), app.position, "Ln 1, Col 7 (6 selected)");
  // The find bar has pushed the text down.
  const below = (await app.metrics()).y;
  check(label("the current match fills its line"), await colorsDown(page, down, top(0, below) + 1, top(1, below) - 1), [await background(page, ".found")]);
  check(label("another match fills its line"), await colorsDown(page, down, top(1, below) + 1, top(2, below) - 1), [await background(page, ".match")]);
  await t.close(app);
}

export default async function (t) {
  for (const scale of [1, 1.25, 1.5]) {
    for (const size of [13, 15, 20, 9]) await exercise(t, size, scale);
  }
}
