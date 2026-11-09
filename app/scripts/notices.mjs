// Writes src-tauri/THIRD_PARTY_NOTICES.txt, which the installers carry: the
// third-party software in the app with its licenses. That is the Rust crates
// built into the program for Windows (not build scripts or macros, which run
// only while compiling) and the npm packages in the page, as vite.config.js
// noted them while building. `npm run build` runs it after the build.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP, "src-tauri", "THIRD_PARTY_NOTICES.txt");
const SHIPPED = join(APP, "node_modules", ".cache", "shipped-packages.json");
const TARGET = "x86_64-pc-windows-msvc";
const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)/i;
const RULE = "=".repeat(80);

function crates() {
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET, "--manifest-path", join(APP, "..", "Cargo.toml")], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    }),
  );
  const packages = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
  const built = new Set();
  const walk = (id) => {
    if (built.has(id)) return;
    built.add(id);
    for (const dep of nodes.get(id).deps) {
      if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue;
      if (packages.get(dep.pkg).targets.some((target) => target.kind.includes("proc-macro"))) continue;
      walk(dep.pkg);
    }
  };
  walk(meta.packages.find((pkg) => pkg.name === "hu-editor" && pkg.source === null).id);
  return [...built]
    .map((id) => packages.get(id))
    .filter((pkg) => pkg.source !== null)
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "see its license file",
      home: pkg.repository ?? pkg.homepage ?? `https://crates.io/crates/${pkg.name}`,
      dir: dirname(pkg.manifest_path),
    }));
}

function npmPackages() {
  if (!existsSync(SHIPPED)) throw new Error(`${SHIPPED} is missing: vite build writes it`);
  return JSON.parse(readFileSync(SHIPPED, "utf8")).map((dir) => {
    const pkg = JSON.parse(readFileSync(join(APP, dir, "package.json"), "utf8"));
    // "user/repo" and "github:user/repo" are short for GitHub.
    const repository = (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url)
      ?.replace(/^git\+/, "")
      .replace(/\.git$/, "")
      .replace(/^(github:)?([\w.-]+\/[\w.-]+)$/, "https://github.com/$2");
    return {
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "see its license file"),
      home: pkg.homepage ?? repository ?? `https://www.npmjs.com/package/${pkg.name}`,
      dir: join(APP, dir),
    };
  });
}

/** The license files a package came with, as text. */
function licenseTexts(pkg) {
  return readdirSync(pkg.dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(pkg.dir, name), "utf8").replace(/\r\n?/g, "\n").trim())
    .filter((text) => text !== "");
}

// The same order on any machine, whatever its language.
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.version.localeCompare(b.version, "en", { numeric: true });
const named = (pkg) => `${pkg.name} ${pkg.version}`;
const listed = (list) => list.map((pkg) => `  ${named(pkg).padEnd(44)} ${pkg.license.padEnd(32)} ${pkg.home}`).join("\n");

const rust = crates().sort(byName);
const npm = npmPackages().sort(byName);
// Each text once, with all that came with it: most crates share the same Apache text.
const texts = new Map();
const without = [];
for (const pkg of [...rust, ...npm]) {
  const found = licenseTexts(pkg);
  if (!found.length) without.push(pkg);
  for (const text of found) texts.set(text, [...(texts.get(text) ?? []), pkg]);
}

const out = [
  "HU Editor: third-party notices",
  "",
  "HU Editor is built with the software below, each listed with its version, the license",
  "it declares and where it comes from. The license texts follow, each once, under the",
  "software that came with it.",
  "",
  `Rust crates (${rust.length})`,
  "",
  listed(rust),
  "",
  `npm packages (${npm.length})`,
  "",
  listed(npm),
];
if (without.length) {
  out.push("", "These came with no license text of their own; their licenses are at the places above:", "", ...without.map((pkg) => `  ${named(pkg)}`));
}
for (const [text, pkgs] of texts) out.push("", RULE, "", pkgs.map(named).join(", "), "", text);
writeFileSync(OUT, out.join("\n") + "\n");
console.log(`${OUT}: ${rust.length} crates, ${npm.length} npm packages, ${texts.size} license texts${without.length ? `, ${without.length} without one` : ""}`);
