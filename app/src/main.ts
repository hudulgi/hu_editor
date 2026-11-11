import { getCurrentWindow } from "@tauri-apps/api/window";
import { mount } from "svelte";
import App from "./App.svelte";
import CompareApp from "./CompareApp.svelte";
import { loadSettings } from "./lib/settings.svelte";
import "./app.css";

// Before the first paint, so the app starts in the user's language and font.
await loadSettings();
// A compare window is a window of its own kind.
const root = getCurrentWindow().label.startsWith("compare-") ? CompareApp : App;
mount(root, { target: document.getElementById("app")! });
