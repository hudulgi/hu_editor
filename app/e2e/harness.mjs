// What the scenarios share: the app in a browser with its Tauri side replaced
// by the bridge, and ways to look at it and answer it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

/** Runs in the page, in place of Tauri. Native dialogs answer from a queue. */
function tauriInPage({ bridge, settingsPath, launchPath, label }) {
  const e2e = { dialogAnswers: [], dialogCalls: [], listeners: {}, destroyed: 0, title: "" };
  window.__e2e = e2e;
  // Events reach every window, the one that sent them too.
  const deliver = (event, payload) => {
    const handler = e2e.listeners[event];
    if (handler) window[`_${handler}`]({ event, id: 1, payload });
  };
  const events = new BroadcastChannel("e2e-events");
  events.onmessage = ({ data }) => deliver(data.event, data.payload);
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    transformCallback(callback) {
      const id = Math.floor(Math.random() * 1e9);
      window[`_${id}`] = callback;
      return id;
    },
    unregisterCallback(id) {
      delete window[`_${id}`];
    },
    async invoke(cmd, args) {
      if (cmd === "launch_path") {
        // Only the first start has a command line; a reload is a restart without one.
        if (sessionStorage.getItem("e2e.launched")) return null;
        sessionStorage.setItem("e2e.launched", "1");
        return launchPath;
      }
      if (cmd === "plugin:event|listen") {
        e2e.listeners[args.event] = args.handler;
        return 1;
      }
      if (cmd === "plugin:event|emit") {
        events.postMessage({ event: args.event, payload: args.payload });
        setTimeout(() => deliver(args.event, args.payload));
        return null;
      }
      if (cmd === "plugin:dialog|save" || cmd === "plugin:dialog|open") {
        e2e.dialogCalls.push(args.options.defaultPath ?? null);
        return e2e.dialogAnswers.shift() ?? null;
      }
      if (cmd === "plugin:window|set_title") e2e.title = args.value;
      if (cmd === "plugin:window|destroy") e2e.destroyed++;
      if (cmd === "plugin:app|version") return "9.9.9";
      if (cmd === "plugin:window|close") {
        window[`_${e2e.listeners["tauri://close-requested"]}`]({ event: "tauri://close-requested", id: 1, payload: null });
        return null;
      }
      if (cmd.startsWith("plugin:")) return null;
      if (cmd === "load_settings" || cmd === "save_settings") args = { ...args, path: settingsPath };
      if (cmd === "window_start") args = { label };
      if (cmd === "open_window" && e2e.failWindow) throw "no more windows";
      const response = await fetch(bridge, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ cmd, args }),
      });
      const answer = await response.json();
      if ("err" in answer) throw answer.err;
      if (cmd === "open_window") window.__e2eOpenWindow(answer.ok);
      return answer.ok;
    },
  };
}

const SLOT = ".pane.focused .slot:not(.hidden)";
// Twice: once for the expression and once for the selector's own quoting.
const escapeRegExp = (text) => text.replace(/[()]/g, "\\\\$&");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** The installed browser the scenarios run in, headless. */
export function launchBrowser(args = []) {
  const channel = process.env.E2E_BROWSER ?? (process.platform === "win32" ? "msedge" : "chrome");
  return chromium.launch({ channel, headless: true, args });
}

/** One scenario: its checks, its folder, the apps it started. */
export class Session {
  passed = 0;
  failures = [];
  apps = [];
  closed = [];

  constructor({ browser, dir, config, url, bridge, shots, verbose }) {
    Object.assign(this, { browser, dir, config, url, bridge, shots, verbose });
    mkdirSync(dir, { recursive: true });
    mkdirSync(config, { recursive: true });
  }

  check = (label, actual, expected) => {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (same) {
      this.passed++;
      if (this.verbose) console.log(`  ok   ${label}`);
    } else {
      this.fail(`${label}\n         got      ${JSON.stringify(actual)}\n         expected ${JSON.stringify(expected)}`);
    }
  };

  fail(message) {
    this.failures.push(message);
    console.log(`  FAIL ${message}`);
  }

  /**
   * Checks once `get` gives `expected`, or fails when it has not after `timeout`.
   * `get` may throw until then, say while a file does not exist yet.
   */
  until = async (label, get, expected, timeout = 5000) => {
    const value = async () => {
      try {
        return await get();
      } catch (e) {
        return `threw: ${e.message ?? e}`;
      }
    };
    const deadline = Date.now() + timeout;
    let actual = await value();
    while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
      await pause(25);
      actual = await value();
    }
    this.check(label, actual, expected);
  };

  /** A path in the scenario's folder, always with this OS's separators. */
  path(...parts) {
    return join(this.dir, ...parts);
  }

  write(files) {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(this.path(name)), { recursive: true });
      writeFileSync(this.path(name), content);
    }
  }

  read(name, encoding = "utf8") {
    return readFileSync(this.path(name), encoding);
  }

  /** Starts the app as on a new machine, with `settings` in its settings file if given. */
  async launch({ locale = "en-US", settings, launchPath = null, viewport = { width: 1280, height: 800 }, scale } = {}) {
    const settingsPath = join(this.config, `settings-${this.apps.length}`, "settings.json");
    if (settings) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings));
    }
    // A display scale takes a browser of its own: emulating one (deviceScaleFactor)
    // blurs the edges of boxes in a way that a real display does not.
    const browser = scale
      ? await launchBrowser([`--force-device-scale-factor=${scale}`, `--window-size=${viewport.width},${viewport.height}`])
      : this.browser;
    const context = await browser.newContext(scale ? { locale, viewport: null } : { locale, viewport });
    const start = async (label, launchPath) => {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.addInitScript(tauriInPage, { bridge: this.bridge, settingsPath, launchPath, label });
      const app = new App(this, page, settingsPath);
      await page.goto(this.url);
      await page.waitForSelector(".menubar");
      return app;
    };
    const opened = [];
    await context.exposeFunction("__e2eOpenWindow", async (label) => opened.push(await start(label, null)));
    const app = await start("main", launchPath);
    app.opened = opened;
    if (scale) app.ownBrowser = browser;
    this.apps.push(app);
    return app;
  }

  /** Ends one app early; `finish` ends the rest. */
  async close(app) {
    for (const window of [app, ...app.opened]) {
      for (const error of window.errors) this.fail(`page error: ${error}`);
    }
    await app.page.context().close();
    await app.ownBrowser?.close();
    this.closed.push(app);
  }

  async finish() {
    for (const app of this.apps) {
      if (!this.closed.includes(app)) await this.close(app);
    }
  }
}

/** The running app, seen from outside. */
export class App {
  errors = [];
  /** Page errors that a scenario provokes on purpose. */
  expectedErrors = [];
  /** The other windows that this one's menu opened, in order, as apps of their own. */
  opened = [];

  constructor(session, page, settingsPath) {
    Object.assign(this, { session, page, settingsPath });
    const report = (text) => {
      if (!this.expectedErrors.some((pattern) => pattern.test(text))) this.errors.push(text);
    };
    page.on("pageerror", (e) => report(String(e)));
    // A missing favicon is the one 404 to expect.
    page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && report(m.text()));
  }

  async shot(name) {
    if (this.session.shots) await this.page.screenshot({ path: join(this.session.shots, `${name}.png`) });
  }

  // ---- What it shows --------------------------------------------------------

  lines = () => this.page.$$eval(`${SLOT} .lines .line`, (els) => els.map((e) => e.textContent));
  position = () => this.page.textContent(".statusbar span:first-child");
  status = () => this.page.textContent(".statusbar");
  encoding = () => this.page.textContent(".statusbar .status-button");
  language = () => this.page.textContent(".statusbar span:last-child");
  path = () => this.page.textContent(".topbar .path");
  title = () => this.page.evaluate(() => window.__e2e.title);
  /** The number of the first line on screen. */
  firstLine = () => this.page.$eval(`${SLOT} .gutter .ln`, (e) => Number(e.textContent));
  notice = async () => ((await this.page.locator(".notice").count()) ? this.page.textContent(".notice") : null);
  /** Tabs as `name (folder) ●`, the active one starting with `*`. */
  tabs = () =>
    this.page.$$eval(".strip .tab", (els) =>
      els.map((e) => {
        const hint = e.querySelector(".hint");
        const name = e.querySelector(".name").textContent;
        return `${e.classList.contains("active") ? "*" : ""}${name}${hint ? ` (${hint.textContent})` : ""}${e.classList.contains("dirty") ? " ●" : ""}`;
      }),
    );
  savedSettings = () => {
    try {
      return JSON.parse(readFileSync(this.settingsPath, "utf8"));
    } catch {
      return null;
    }
  };

  /** Where lines and columns are, as the visible editor is drawn now. */
  async metrics() {
    return this.page.evaluate((slot) => {
      const line = document.querySelector(`${slot} .lines .line`).getBoundingClientRect();
      const context = document.createElement("canvas").getContext("2d");
      context.font = getComputedStyle(document.querySelector(`${slot} .editor`)).font;
      return { x: line.x, y: line.y, lineH: line.height, cell: context.measureText("0".repeat(100)).width / 100 };
    }, SLOT);
  }

  /** The screen point of a row (from the top of the screen) and column. */
  async at(row, col) {
    const { x, y, lineH, cell } = await this.metrics();
    return [x + col * cell + 1, y + row * lineH + lineH / 2];
  }

  /** Waits for a save to finish: the status bar shows it first as Saving, then not at all. */
  saved = (timeout = 10000) =>
    this.page.waitForFunction(() => !/Modified|Saving/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout });

  // ---- What it is told ------------------------------------------------------

  /** Opens a file through the explorer's address box; the top bar then shows it. */
  async open(path) {
    await this.page.fill(".address input", path);
    await this.page.press(".address input", "Enter");
    await this.page.waitForFunction(
      (path) => document.querySelector(".topbar .path")?.textContent === path,
      path,
    );
    await this.page.waitForSelector(`${SLOT} .lines .line`);
  }

  /** The next native file dialog answers `path`, or is cancelled for null. */
  answerDialog = (path) => this.page.evaluate((path) => window.__e2e.dialogAnswers.push(path), path);
  dialogCalls = () => this.page.evaluate(() => window.__e2e.dialogCalls);

  /** How many documents the backend holds, for all scenarios so far. */
  heldDocuments = () =>
    this.page.evaluate(async (bridge) => {
      const response = await fetch(bridge, { method: "POST", body: JSON.stringify({ cmd: "test_open_documents", args: {} }) });
      return (await response.json()).ok;
    }, this.session.bridge);

  clipboard = () =>
    this.page.evaluate(async (bridge) => {
      const response = await fetch(bridge, {
        method: "POST",
        body: JSON.stringify({ cmd: "test_clipboard", args: {} }),
      });
      return (await response.json()).ok;
    }, this.session.bridge);

  paste = (text) =>
    this.page.evaluate(
      ({ slot, text }) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        document
          .querySelector(`${slot} textarea.input`)
          .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
      },
      { slot: SLOT, text },
    );

  /** Alt+drag between two points from `at`. */
  async altDrag(from, to) {
    await this.page.keyboard.down("Alt");
    await this.page.mouse.move(...from);
    await this.page.mouse.down();
    await this.page.mouse.move(...to, { steps: 6 });
    await this.page.mouse.up();
    await this.page.keyboard.up("Alt");
  }

  /** Picks an item in a menu with the mouse, through a submenu if one is named. */
  async menu(title, ...path) {
    await this.page.click(`.menubar .title:text-matches('^${title}$')`);
    for (const item of path) await this.page.click(`.menubar .panel .label:text-matches('^${escapeRegExp(item)}$')`);
  }

  /** Picks an item of View > Editor Layout. */
  layout = (item) => this.menu("View", "Editor Layout", item);

  /** The window's close button. */
  closeWindow = () =>
    this.page.evaluate(() => {
      const handler = window.__e2e.listeners["tauri://close-requested"];
      window[`_${handler}`]({ event: "tauri://close-requested", id: 1, payload: null });
    });
  destroyed = () => this.page.evaluate(() => window.__e2e.destroyed);

  /** Files dropped on the window. */
  drop = (paths) =>
    this.page.evaluate((paths) => {
      const handler = window.__e2e.listeners["tauri://drag-drop"];
      window[`_${handler}`]({ event: "tauri://drag-drop", id: 1, payload: { paths, position: { x: 10, y: 10 } } });
    }, paths);

  // ---- Settings window -------------------------------------------------------

  async openSettings(category) {
    await this.page.keyboard.press("Control+,");
    await this.page.waitForSelector(".settings");
    if (category) await this.settingsCategory(category);
  }

  settingsCategory = (name) => this.page.click(`.settings nav button:has-text('${name}')`);

  async closeSettings() {
    await this.page.keyboard.press("Escape");
    await this.page.waitForSelector(".settings", { state: "detached" });
  }

  toggleSetting = (name) => this.page.click(`.settings label.check:has-text('${name}') input`);
  selectSetting = (name, value) => this.page.selectOption(`.settings .field:has-text('${name}') select`, value);
  numberSetting = (name) => this.page.locator(`.settings .field:has-text('${name}') input[type=number]`);
  async setFontSize(size) {
    await this.openSettings("Editor");
    await this.numberSetting("Font size").fill(String(size));
    await this.closeSettings();
  }
}
