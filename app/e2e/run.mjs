// Runs the app's real frontend in a browser against the real core, through the
// bridge in ./bridge, and checks what a user would see.
//
//   npm run e2e                     every scenario
//   npm run e2e -- box tabs         the named ones
//   npm run e2e -- --big            also the 1 GB scenario (slow, needs the disk)
//   npm run e2e -- --verbose        also list the checks that passed
//   npm run e2e -- --keep           keep the files and screenshots, and say where
//
// E2E_BROWSER names the installed browser to use (default: Edge on Windows,
// which is what the app's WebView2 is, and Chrome elsewhere).

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Session } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = dirname(here);
const repo = dirname(app);
const VITE_PORT = 1430;
const BRIDGE_PORT = 1431;
const url = `http://127.0.0.1:${VITE_PORT}/`;
const bridge = `http://127.0.0.1:${BRIDGE_PORT}/`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const named = argv.filter((a) => !a.startsWith("--"));
const available = readdirSync(join(here, "scenarios")).map((f) => basename(f, ".mjs"));
const unknown = named.filter((name) => !available.includes(name));
if (unknown.length) {
  console.error(`unknown scenario: ${unknown.join(", ")} (there are: ${available.join(", ")})`);
  process.exit(2);
}
const scenarios = named.length ? named : available.filter((name) => name !== "big" || flag("big"));

const built = spawnSync("cargo", ["build", "-q", "-p", "hu-e2e-bridge"], { cwd: repo, stdio: "inherit" });
if (built.status !== 0) process.exit(1);

let stopping = false;
/** A server that stops by itself has lost its port, or something worse: nothing here can go on. */
function serve(what, port, command, args, options) {
  const server = spawn(command, args, options);
  server.once("exit", () => {
    if (stopping) return;
    console.error(`${what} stopped: is port ${port} taken?`);
    process.exit(1);
  });
  return server;
}
const servers = [
  serve("the bridge", BRIDGE_PORT, join(repo, "target", "debug", `hu-e2e-bridge${process.platform === "win32" ? ".exe" : ""}`), [String(BRIDGE_PORT)], {
    stdio: ["ignore", "ignore", "inherit"],
  }),
  serve("vite", VITE_PORT, process.execPath, [join(app, "node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort"], {
    cwd: app,
    stdio: "ignore",
  }),
];
const stopServers = () => {
  stopping = true;
  servers.forEach((server) => server.kill());
};
process.on("exit", stopServers);

async function whenServing(address) {
  for (const deadline = Date.now() + 30000; Date.now() < deadline; ) {
    try {
      await fetch(address);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error(`nothing answered at ${address}`);
}

/** Every command the app registers must exist in the bridge, or scenarios fail in confusing ways. */
async function commandsMissingFromBridge() {
  const main = readFileSync(join(app, "src-tauri/src/main.rs"), "utf8");
  const commands = [...main.matchAll(/commands::(\w+),/g)].map((m) => m[1]);
  const missing = [];
  for (const cmd of commands) {
    const response = await fetch(bridge, { method: "POST", body: JSON.stringify({ cmd, args: {} }) });
    if ((await response.json()).err?.startsWith("unknown command")) missing.push(cmd);
  }
  return missing;
}

let failed = 0;
let passed = 0;
const root = realpathSync(mkdtempSync(join(tmpdir(), "hu-e2e-")));
try {
  await Promise.all([whenServing(url), whenServing(bridge)]);
  const missing = await commandsMissingFromBridge();
  if (missing.length) throw new Error(`add to app/e2e/bridge: ${missing.join(", ")}`);

  const channel = process.env.E2E_BROWSER ?? (process.platform === "win32" ? "msedge" : "chrome");
  const browser = await chromium.launch({ channel, headless: true });
  const shots = join(root, "shots");
  mkdirSync(shots);
  for (const name of scenarios) {
    console.log(name);
    const session = new Session({
      browser,
      dir: join(root, name, "files"),
      config: join(root, name, "config"),
      url,
      bridge,
      shots,
      verbose: flag("verbose"),
    });
    const { default: run } = await import(`./scenarios/${name}.mjs`);
    try {
      await run(session);
    } catch (e) {
      session.fail(`stopped: ${e.message ?? e}`);
    }
    if (session.failures.length) {
      for (const [i, app] of session.apps.entries()) await app.shot(`${name}-failed-${i}`).catch(() => {});
    }
    await session.finish();
    passed += session.passed;
    failed += session.failures.length;
    console.log(`  ${session.passed} passed${session.failures.length ? `, ${session.failures.length} FAILED` : ""}`);
  }
  await browser.close();
} catch (e) {
  console.error(e.message ?? e);
  failed++;
} finally {
  stopServers();
}

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
if (failed || flag("keep")) console.log(`files and screenshots: ${root}`);
else rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
