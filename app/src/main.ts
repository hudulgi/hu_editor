import { mount } from "svelte";
import App from "./App.svelte";
import { loadSettings } from "./lib/settings.svelte";
import "./app.css";

// Before the first paint, so the app starts in the user's language and font.
await loadSettings();
mount(App, { target: document.getElementById("app")! });
