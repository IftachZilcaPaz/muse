/**
 * Checkpoints: a tree of the working directory built through a temporary index, committed onto our own
 * ref (refs/timemachine/<machine>/autosave), never touching the user's HEAD, index or branches.
 */
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Git } from "./git.js";
import { collectEnvFiles } from "./envfiles.js";
import { encryptBundle } from "./crypto.js";
import { scanHistory, scanWorktree, verdict } from "./secrets.js";
import type { Store } from "./store.js";
import type { CheckpointEntry, CheckpointResult, ProjectRecord } from "./types.js";

export const REF_NS = "refs/timemachine";
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // GitHub warns at 50MB and blocks at 100MB

export const DEFAULT_EXCLUDES = `# created by Time Machine
.git/
node_modules/
dist/
build/
.next/
.nuxt/
.output/
.turbo/
.cache/
coverage/
.venv/
venv/
__pycache__/
*.pyc
target/
.DS_Store
Thumbs.db
*.sqlite
*.sqlite3
*.db
dev.db
.env
.env.*
!.env.example
.timemachine/
`;

export function refFor(machineId: string, slug: string): string {
  // Spec: one backup repo per project, so the ref is refs/timemachine/<machine>/autosave.
  // The slug is included so several projects can share one repo during experiments.
  return `${REF_NS}/${machineId}/${slug}/autosave`;
}

/** git init if needed. HEAD stays unborn: we never create a commit on the user's branch. */
export async function ensureRepo(git: Git, project: string): Promise<boolean> {
  let created = false;
  if (!existsSync(path.join(project, ".git"))) {
    await git.run(["init", "-q", "-b", "main"], { cwd: project });
    created = true;
  }
  const gi = path.join(project, ".gitignore");
  if (!existsSync(gi)) await fs.writeFile(gi, DEFAULT_EXCLUDES);
  return created;
}

/** Builds a tree of the working directory through a temporary index (libgit2: git_index_new + add_all + write_tree_to). */
export class TreeBuild {
  private readonly indexFile: string;
  readonly env: Record<string, string>;
  excludedLarge: string[] = [];
  files: string[] = [];

  constructor(private readonly git: Git, private readonly project: string) {
    this.indexFile = path.join(os.tmpdir(), `tm-index-${randomBytes(6).toString("hex")}`);
    this.env = { GIT_INDEX_FILE: this.indexFile };
  }

  private async withExcludes(extra: string[], fn: (file: string) => Promise<void>) {
    const f = path.join(os.tmpdir(), `tm-excludes-${randomBytes(6).toString("hex")}`);
    await fs.writeFile(f, DEFAULT_EXCLUDES + extra.map((p) => `/${p}`).join("\n") + "\n");
    try {
      await fn(f);
    } finally {
      await fs.rm(f, { force: true });
    }
  }

  async buildFilesTree(): Promise<string> {
    // pass 1: dry run to find oversized files without hashing them
    await this.withExcludes([], async (ex) => {
      const dry = await this.git.run(["-c", `core.excludesFile=${ex}`, "add", "-A", "-n", "--", "."], { cwd: this.project, env: this.env });
      for (const line of dry.split("\n")) {
        const m = /^add '(.+)'$/.exec(line);
        if (!m) continue;
        try {
          if ((await fs.stat(path.join(this.project, m[1]))).size > MAX_FILE_BYTES) this.excludedLarge.push(m[1]);
        } catch {
          /* vanished */
        }
      }
    });
    // pass 2: real add with large files excluded
    await this.withExcludes(this.excludedLarge, async (ex) => {
      await this.git.run(["-c", `core.excludesFile=${ex}`, "add", "-A", "--", "."], { cwd: this.project, env: this.env });
    });
    this.files = (await this.git.run(["ls-files", "-z"], { cwd: this.project, env: this.env })).split("\0").filter(Boolean);
    return (await this.git.run(["write-tree"], { cwd: this.project, env: this.env })).trim();
  }

  async addBlob(rel: string, data: Buffer, mode = "100644") {
    const sha = (await this.git.run(["hash-object", "-w", "--stdin"], { cwd: this.project, input: data })).trim();
    await this.git.run(["update-index", "--add", "--cacheinfo", `${mode},${sha},${rel}`], { cwd: this.project, env: this.env });
  }

  async writeTree(): Promise<string> {
    return (await this.git.run(["write-tree"], { cwd: this.project, env: this.env })).trim();
  }

  async cleanup() {
    await fs.rm(this.indexFile, { force: true });
  }
}

/** The files-only tree of the working directory right now (used to verify a restore). */
export async function currentFilesTree(git: Git, project: string): Promise<string> {
  const tb = new TreeBuild(git, project);
  try {
    return await tb.buildFilesTree();
  } finally {
    await tb.cleanup();
  }
}

export interface CheckpointOptions {
  message?: string;
  ack?: boolean;
  /** Fake timestamp for tests (ISO 8601). */
  at?: string;
  identity?: { name: string; email: string };
}

export async function checkpoint(git: Git, store: Store, project: ProjectRecord, opts: CheckpointOptions = {}): Promise<CheckpointResult> {
  const root = project.path;
  const ref = refFor(store.machineId, project.slug);
  await ensureRepo(git, root);

  const busy = await git.busyReason(root);
  if (busy) return { status: "skipped-busy", reason: busy, findings: [], excludedLarge: [] };

  const prev = await git.revParse(root, ref);
  const prevTr = prev ? await git.trailers(root, prev) : {};
  const head = await git.headSha(root);

  const tb = new TreeBuild(git, root);
  try {
    const filesTree = await tb.buildFilesTree();

    // secret scan: what we are about to store, plus the user's history when HEAD moved
    const findings = await scanWorktree(root, tb.files);
    if (head && prevTr["TM-Head"] !== head) findings.push(...(await scanHistory(git, root)));
    const acked = store.acks(project.slug);
    const v = verdict(findings, acked);
    if (v === "red") return { status: "blocked", findings, excludedLarge: tb.excludedLarge, reason: "a secret that must never be stored was found" };
    if (v === "yellow" && !opts.ack) return { status: "needs-ack", findings, excludedLarge: tb.excludedLarge, reason: "secrets found; acknowledge to back up anyway and rotate them" };
    if (v === "yellow") await store.addAcks(project.slug, findings.filter((f) => f.severity === "yellow").map((f) => f.fingerprint));

    // encrypted .env bundle
    const envFiles = await collectEnvFiles(root);
    let secretsDigest = "";
    if (Object.keys(envFiles).length) {
      const bundle = await encryptBundle(envFiles, await store.recipients());
      secretsDigest = bundle.digest;
      await tb.addBlob(".timemachine/secrets.age", bundle.ciphertext);
    }

    if (prev && prevTr["TM-Tree"] === filesTree && (prevTr["TM-Secrets"] ?? "") === secretsDigest && (prevTr["TM-Head"] ?? "") === (head ?? "")) {
      return { status: "unchanged", sha: prev, tmId: prevTr["TM-Id"], findings, excludedLarge: tb.excludedLarge };
    }

    const tmId = randomBytes(6).toString("hex");
    const manifest = { tmId, machine: store.machineId, created: opts.at ?? new Date().toISOString(), head, excludedLarge: tb.excludedLarge, envFiles: Object.keys(envFiles).sort() };
    await tb.addBlob(".timemachine/manifest.json", Buffer.from(JSON.stringify(manifest, null, 1)));
    const tree = await tb.writeTree();

    const message = opts.message ?? (await describeChange(git, root, prev, tree, tb.files.length));
    const parents: string[] = [];
    if (prev) parents.push("-p", prev);
    if (head && prevTr["TM-Head"] !== head) parents.push("-p", head); // the user's real commit moved since last time
    const full = `${message}\n\nTM-Id: ${tmId}\nTM-Machine: ${store.machineId}\nTM-Head: ${head ?? ""}\nTM-Tree: ${filesTree}\nTM-Secrets: ${secretsDigest}\n`;
    const id = opts.identity ?? { name: "Time Machine", email: "timemachine@users.noreply.github.com" };
    const env: Record<string, string> = {
      GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email,
    };
    if (opts.at) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = opts.at;
    const sha = (await git.run(["commit-tree", tree, ...parents, "-m", full], { cwd: root, env })).trim();
    await git.run(["update-ref", ref, sha, prev ?? "0".repeat(40)], { cwd: root }); // compare-and-swap on our ref only
    await store.setIndex(project.slug, { ...store.index(project.slug), [tmId]: sha });
    return { status: "created", sha, tmId, message, findings, excludedLarge: tb.excludedLarge };
  } finally {
    await tb.cleanup();
  }
}

async function describeChange(git: Git, root: string, prev: string | null, tree: string, fileCount: number): Promise<string> {
  if (!prev) return `first checkpoint: ${fileCount} files`;
  const stat = (await git.run(["diff", "--shortstat", `${prev}^{tree}`, tree, "--", ".", ":!.timemachine"], { cwd: root })).trim();
  const names = (await git.run(["diff", "--name-only", `${prev}^{tree}`, tree, "--", ".", ":!.timemachine"], { cwd: root })).split("\n").filter(Boolean);
  const dirs = new Map<string, number>();
  for (const n of names) {
    const d = n.includes("/") ? n.split("/")[0] : ".";
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const top = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (stat || "env/metadata update") + (top && top !== "." ? ` (mostly in ${top}/)` : "");
}

/** Our chain, oldest first. Stops at the first commit without a TM-Id trailer (the user's own history). */
export async function chain(git: Git, root: string, ref: string): Promise<CheckpointEntry[]> {
  if (!(await git.revParse(root, ref))) return [];
  const fmt = "%H%x1f%P%x1f%cI%x1f%s%x1f%(trailers:key=TM-Id,valueonly)%x1f%(trailers:key=TM-Tree,valueonly)%x1e";
  const out: Array<CheckpointEntry & { parents: string[] }> = [];
  for (const rec of (await git.run(["log", "--first-parent", `--format=${fmt}`, ref], { cwd: root })).split("\x1e")) {
    if (!rec.trim()) continue;
    const [sha, parents, date, subject, tmId, filesTree] = rec.split("\x1f").map((s) => s.trim());
    if (!tmId) break;
    out.push({ sha, parents: parents.split(" ").filter(Boolean), date, subject, tmId, filesTree, userParents: [] });
  }
  out.reverse();
  const ours = new Set(out.map((e) => e.sha));
  return out.map(({ parents, ...e }) => ({ ...e, userParents: parents.filter((p) => !ours.has(p)) }));
}

/** Push only our namespace. Force is allowed there because thinning rewrites it. */
export async function push(git: Git, store: Store, project: ProjectRecord): Promise<string> {
  if (!project.remote) throw new Error("no backup remote configured");
  const ref = refFor(store.machineId, project.slug);
  if (!(await git.revParse(project.path, ref))) throw new Error("nothing to push yet");
  return git.run(["push", "--porcelain", project.remote, `+${ref}:${ref}`], { cwd: project.path });
}
