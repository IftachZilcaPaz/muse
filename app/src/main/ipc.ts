import { app, dialog, ipcMain } from "electron";
import os from "node:os";
import path from "node:path";
import { Engine } from "../engine/index.js";
import type { ToolId } from "../engine/types.js";

export async function registerIpc() {
  const engine = await Engine.open(path.join(app.getPath("userData"), "state"));
  const home = os.homedir();

  ipcMain.handle("tm:home", () => home);
  ipcMain.handle("tm:detectTools", async () => {
    const tools = await engine.detectTools(home);
    const all = await engine.discover({ home });
    for (const t of tools) t.projectCount = all.filter((c) => c.sources.includes(t.id)).length;
    return tools;
  });
  ipcMain.handle("tm:discover", (_e, tools?: ToolId[]) => engine.discover({ home, tools }));
  ipcMain.handle("tm:pickFolder", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("tm:track", (_e, paths: string[]) => Promise.all(paths.map((p) => engine.track(p))));
  ipcMain.handle("tm:checkpoint", (_e, slug: string, ack?: boolean) => engine.checkpoint(slug, { ack }));
  ipcMain.handle("tm:listProjects", () => engine.store.listProjects());
}
