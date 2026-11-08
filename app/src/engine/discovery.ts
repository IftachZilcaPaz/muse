/**
 * Project discovery: paths only, never conversation content.
 *   Claude Code  ~/.claude.json            { projects: { "/abs/path": {...} } }
 *   Cursor       ~/Library/Application Support/Cursor/User/workspaceStorage/<id>/workspace.json  { folder: "file:///..." }
 *   Codex        ~/.codex/sessions/**.jsonl  (cwd field; v1.1, kept behind a flag)
 * Recency = max(tool session mtime, workspace mtime, folder mtime). Nested candidates fold into their parent.
 */
import { promises as fs, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Candidate, DetectedTool, DiscoverOptions, ToolId } from "./types.js";

const MARKERS = ["package.json", "pyproject.toml", "requirements.txt", "index.html", "Cargo.toml", "go.mod", "Package.swift"];
const DEFAULT_ACTIVE_DAYS = 90;

interface Raw {
  path: string;
  sources: Set<ToolId>;
  lastActive: number;
  nested: string[];
}

function claudeEncoded(p: string): string {
  // Claude Code's lossy encoding of a path into a directory name: every "/" becomes "-".
  return p.replace(/\//g, "-");
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  try {
    const st = await fs.stat(dir);
    newest = st.mtimeMs;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const s = await fs.stat(path.join(dir, entry.name));
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      }
    }
  } catch {
    /* missing dir: 0 */
  }
  return newest;
}

export function cursorStorageDir(home: string): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Cursor", "User", "workspaceStorage");
  if (process.platform === "linux") return path.join(home, ".config", "Cursor", "User", "workspaceStorage");
  return path.join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage");
}

async function readClaudeCode(home: string, add: (p: string, src: ToolId, ts: number) => void): Promise<boolean> {
  const file = path.join(home, ".claude.json");
  if (!existsSync(file)) return false;
  let projects: Record<string, unknown> = {};
  try {
    projects = JSON.parse(await fs.readFile(file, "utf8")).projects ?? {};
  } catch {
    return true;
  }
  for (const raw of Object.keys(projects)) {
    const ts = await newestMtime(path.join(home, ".claude", "projects", claudeEncoded(raw)));
    add(raw, "claude-code", ts);
  }
  return true;
}

async function readCursor(home: string, add: (p: string, src: ToolId, ts: number) => void): Promise<boolean> {
  const root = cursorStorageDir(home);
  if (!existsSync(root)) return false;
  for (const id of await fs.readdir(root)) {
    const wj = path.join(root, id, "workspace.json");
    if (!existsSync(wj)) continue;
    try {
      const folder: string = JSON.parse(await fs.readFile(wj, "utf8")).folder ?? "";
      if (!folder.startsWith("file://")) continue;
      add(decodeURIComponent(folder.slice("file://".length)), "cursor", (await fs.stat(wj)).mtimeMs);
    } catch {
      /* skip unreadable workspace */
    }
  }
  return true;
}

export function detectICloud(home: string, p: string): boolean {
  const cloud = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  if (p.startsWith(cloud + path.sep)) return true;
  // With "Desktop & Documents" sync on, ~/Desktop and ~/Documents are mirrored into iCloud.
  for (const top of ["Desktop", "Documents"]) {
    if (p.startsWith(path.join(home, top) + path.sep) && existsSync(path.join(cloud, top))) return true;
  }
  return false;
}

export async function detectTools(home: string): Promise<DetectedTool[]> {
  const claude = existsSync(path.join(home, ".claude.json"));
  const cursor = existsSync(cursorStorageDir(home));
  const claudeDesktop =
    process.platform === "darwin"
      ? existsSync(path.join(home, "Library", "Application Support", "Claude"))
      : existsSync(path.join(process.env.APPDATA ?? "", "Claude"));
  const codex = existsSync(path.join(home, ".codex"));
  const mk = (id: ToolId, installed: boolean, browserOnly = false): DetectedTool => ({ id, installed, browserOnly, projectCount: 0 });
  return [
    mk("claude-code", claude),
    mk("cursor", cursor),
    mk("claude-desktop", claudeDesktop),
    mk("codex", codex),
    mk("lovable", false, true),
    mk("bolt", false, true),
    mk("v0", false, true),
    mk("replit", false, true),
  ];
}

export async function discover(opts: DiscoverOptions): Promise<Candidate[]> {
  const home = path.resolve(opts.home);
  const now = opts.now ?? new Date();
  const activeDays = opts.activeDays ?? DEFAULT_ACTIVE_DAYS;
  const raws = new Map<string, Raw>();

  const add = (p: string, src: ToolId, ts: number) => {
    const key = path.resolve(p);
    const r = raws.get(key) ?? { path: key, sources: new Set<ToolId>(), lastActive: 0, nested: [] };
    r.sources.add(src);
    r.lastActive = Math.max(r.lastActive, ts);
    raws.set(key, r);
  };

  await readClaudeCode(home, add);
  await readCursor(home, add);

  // noise filters: home itself, dot-directories, anything under ~/Library, non-directories
  const lib = path.join(home, "Library");
  const noisy = (p: string): boolean => {
    if (p === home) return true;
    if (p === lib || p.startsWith(lib + path.sep)) return true;
    if (!existsSync(p) || !statSync(p).isDirectory()) return true;
    const rel = p.startsWith(home + path.sep) ? path.relative(home, p) : p;
    return rel.split(path.sep).some((part) => part.startsWith("."));
  };

  let kept = [...raws.values()].filter((r) => !noisy(r.path));
  if (opts.tools) kept = kept.filter((r) => [...r.sources].some((s) => opts.tools!.includes(s)));

  for (const r of kept) r.lastActive = Math.max(r.lastActive, statSync(r.path).mtimeMs);

  // nesting: a candidate inside another candidate folds into its parent
  const tops: Raw[] = [];
  for (const r of kept.sort((a, b) => a.path.length - b.path.length)) {
    const parent = tops.find((t) => r.path.startsWith(t.path + path.sep));
    if (parent) {
      parent.nested.push(path.relative(parent.path, r.path));
      for (const s of r.sources) parent.sources.add(s);
      parent.lastActive = Math.max(parent.lastActive, r.lastActive);
    } else tops.push(r);
  }

  const cutoff = now.getTime() - activeDays * 86_400_000;
  return tops
    .sort((a, b) => b.lastActive - a.lastActive)
    .map((r) => ({
      path: r.path,
      name: path.basename(r.path),
      sources: [...r.sources].sort(),
      lastActive: new Date(r.lastActive).toISOString().slice(0, 10),
      active: r.lastActive >= cutoff,
      hasGit: existsSync(path.join(r.path, ".git")),
      markers: MARKERS.filter((m) => existsSync(path.join(r.path, m))),
      nested: r.nested,
      inDownloads: r.path.split(path.sep).includes("Downloads"),
      inICloud: detectICloud(home, r.path),
    }));
}
