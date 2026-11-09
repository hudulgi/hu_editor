import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;
const root = dirname(fileURLToPath(import.meta.url));

/** Notes the npm packages whose code ends up in the page, for scripts/notices.mjs. */
function shippedPackages() {
  return {
    name: "shipped-packages",
    apply: "build",
    generateBundle(_, bundle) {
      const dirs = new Set();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of chunk.moduleIds) {
          const dir = id.match(/^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/)?.[1];
          if (dir) dirs.add(relative(root, dir).replaceAll("\\", "/"));
        }
      }
      mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
      writeFileSync(join(root, "node_modules/.cache/shipped-packages.json"), JSON.stringify([...dirs].sort(), null, 1) + "\n");
    },
  };
}

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [svelte(), shippedPackages()],
  // Keep Rust errors visible in `tauri dev`.
  clearScreen: false,
  server: {
    // Tauri expects a fixed port.
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
