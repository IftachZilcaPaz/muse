import { app, BrowserWindow } from "electron";
import path from "node:path";
import { registerIpc } from "./ipc.js";

// `--mcp` will run the same binary as an MCP server (week 4). Decide before any window code runs,
// and before the single-instance lock, so a Claude Desktop launch is never redirected to the GUI.
if (process.argv.includes("--mcp")) {
  console.error("MCP mode is not implemented yet (week 4)");
  process.exit(0);
}

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    title: "Time Machine",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  await registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // The real app lives in the menu bar and keeps running; until the tray exists (week 5), quit on close.
  if (process.platform !== "darwin") app.quit();
});
