import { contextBridge, ipcRenderer } from "electron";
import type { TimeMachineApi } from "./api.js";

const api: TimeMachineApi = {
  home: () => ipcRenderer.invoke("tm:home"),
  detectTools: () => ipcRenderer.invoke("tm:detectTools"),
  discover: (tools) => ipcRenderer.invoke("tm:discover", tools),
  pickFolder: () => ipcRenderer.invoke("tm:pickFolder"),
  track: (paths) => ipcRenderer.invoke("tm:track", paths),
  checkpoint: (slug, ack) => ipcRenderer.invoke("tm:checkpoint", slug, ack),
  listProjects: () => ipcRenderer.invoke("tm:listProjects"),
};

contextBridge.exposeInMainWorld("tm", api);
