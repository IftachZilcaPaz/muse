/** Files git ignores on purpose but the user cannot afford to lose: .env and friends, root and one level down. */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EnvFiles } from "./crypto.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target"]);

function isEnvName(name: string): boolean {
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

export async function collectEnvFiles(root: string): Promise<EnvFiles> {
  const out: EnvFiles = {};
  const scan = async (dir: string, rel: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && isEnvName(entry.name)) out[path.posix.join(rel, entry.name)] = await fs.readFile(path.join(dir, entry.name));
    }
  };
  await scan(root, "");
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await scan(path.join(root, entry.name), entry.name);
  }
  return out;
}
