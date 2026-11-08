/**
 * Engine facade: what the Electron main process, the MCP server and the CLI call.
 */
import path from "node:path";
import { Git } from "./git.js";
import { JsonStore, type Store } from "./store.js";
import { discover, detectTools } from "./discovery.js";
import { chain, checkpoint, currentFilesTree, ensureRepo, push, refFor, TreeBuild, type CheckpointOptions } from "./checkpoint.js";
import { restore } from "./restore.js";
import { thin } from "./thin.js";
import { scanHistory, scanWorktree, toScanResult } from "./secrets.js";
import type { CheckpointEntry, CheckpointResult, DiscoverOptions, ProjectRecord, RetentionPolicy, ScanResult } from "./types.js";

export * from "./types.js";
export { Git } from "./git.js";
export { JsonStore } from "./store.js";
export { discover, detectTools } from "./discovery.js";
export { refFor, DEFAULT_EXCLUDES } from "./checkpoint.js";

export function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "project";
}

export class Engine {
  constructor(readonly git: Git, readonly store: Store) {}

  static async open(stateDir: string, gitBinary = "git"): Promise<Engine> {
    return new Engine(new Git(gitBinary), await JsonStore.open(stateDir));
  }

  discover(opts: DiscoverOptions) {
    return discover(opts);
  }
  detectTools(home: string) {
    return detectTools(home);
  }

  /** Register a project. The backup remote is added under the name "timemachine", never "origin". */
  async track(projectPath: string, remoteUrl?: string, slug?: string): Promise<ProjectRecord> {
    const p = path.resolve(projectPath);
    const rec: ProjectRecord = { slug: slug ?? slugify(path.basename(p)), path: p, ...(this.store.getProject(slug ?? slugify(path.basename(p))) ?? {}) };
    rec.path = p;
    if (remoteUrl) {
      await ensureRepo(this.git, p);
      const has = (await this.git.run(["remote", "get-url", "timemachine"], { cwd: p, allowFailure: true })).trim();
      await this.git.run(has ? ["remote", "set-url", "timemachine", remoteUrl] : ["remote", "add", "timemachine", remoteUrl], { cwd: p });
      rec.remote = "timemachine";
    }
    await this.store.putProject(rec);
    return rec;
  }

  project(slug: string): ProjectRecord {
    const p = this.store.getProject(slug);
    if (!p) throw new Error(`unknown project '${slug}'`);
    return p;
  }

  async scan(slug: string): Promise<ScanResult> {
    const p = this.project(slug);
    const tb = new TreeBuild(this.git, p.path);
    try {
      await tb.buildFilesTree();
      const findings = [...(await scanWorktree(p.path, tb.files)), ...(await scanHistory(this.git, p.path))];
      return toScanResult(findings, this.store.acks(slug));
    } finally {
      await tb.cleanup();
    }
  }

  checkpoint(slug: string, opts?: CheckpointOptions): Promise<CheckpointResult> {
    return checkpoint(this.git, this.store, this.project(slug), opts);
  }

  list(slug: string): Promise<CheckpointEntry[]> {
    const p = this.project(slug);
    return chain(this.git, p.path, refFor(this.store.machineId, slug));
  }

  push(slug: string) {
    return push(this.git, this.store, this.project(slug));
  }

  restore(slug: string, target: string) {
    return restore(this.git, this.store, this.project(slug), target);
  }

  thin(slug: string, policy: RetentionPolicy, now?: Date) {
    return thin(this.git, this.store, this.project(slug), policy, now);
  }

  async status(slug: string) {
    const p = this.project(slug);
    const ref = refFor(this.store.machineId, slug);
    const entries = await this.list(slug);
    const tip = entries[entries.length - 1];
    const localTree = await currentFilesTree(this.git, p.path);
    let pushed: string | null = null;
    if (p.remote) {
      const out = await this.git.run(["ls-remote", p.remote, ref], { cwd: p.path, allowFailure: true });
      pushed = out.trim().split(/\s/)[0] || null;
    }
    return {
      ref,
      checkpoints: entries.length,
      last: tip ? { date: tip.date, subject: tip.subject, tmId: tip.tmId } : null,
      unsavedChanges: !tip || tip.filesTree !== localTree,
      pushed: pushed && tip ? (pushed === tip.sha ? "yes" : "behind") : "never",
      userHead: await this.git.headSha(p.path),
    } as const;
  }
}
