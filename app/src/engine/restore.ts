/**
 * Restore writes files; it never checks out and never moves HEAD. The current state is checkpointed
 * first, so nothing is ever lost, and the result is verified against the checkpoint's tree.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Git } from "./git.js";
import { checkpoint, currentFilesTree, refFor } from "./checkpoint.js";
import { decryptBundle } from "./crypto.js";
import type { Store } from "./store.js";
import type { ProjectRecord } from "./types.js";

export interface RestoreResult {
  ok: boolean;
  attempts: number;
  wrote: number;
  deleted: number;
  envFiles: string[];
  /** When not ok: whether the folder was returned to its pre-restore state. */
  rolledBack?: boolean;
  message: string;
}

async function writeTreeToWorktree(git: Git, root: string, targetTree: string, currentTree: string | null) {
  const strip = (m: Map<string, { mode: string; sha: string }>) => new Map([...m].filter(([p]) => !p.startsWith(".timemachine/")));
  const target = strip(await git.lsTree(root, targetTree));
  const current = currentTree ? strip(await git.lsTree(root, currentTree)) : new Map<string, { mode: string; sha: string }>();
  let wrote = 0;
  let deleted = 0;
  for (const [rel, { mode, sha }] of target) {
    const cur = current.get(rel);
    if (cur && cur.mode === mode && cur.sha === sha) continue;
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tm-tmp`);
    await fs.writeFile(tmp, await git.catBlob(root, sha), { mode: mode === "100755" ? 0o755 : 0o644 });
    await fs.rename(tmp, dest); // atomic per file
    wrote++;
  }
  for (const rel of current.keys()) {
    if (target.has(rel)) continue;
    const f = path.join(root, rel);
    await fs.rm(f, { force: true });
    deleted++;
    let d = path.dirname(f);
    while (d !== root) {
      if ((await fs.readdir(d)).length) break;
      await fs.rmdir(d);
      d = path.dirname(d);
    }
  }
  return { wrote, deleted };
}

async function restoreSecrets(git: Git, root: string, sha: string, identity: string): Promise<string[]> {
  const entries = await git.lsTree(root, sha);
  const blob = entries.get(".timemachine/secrets.age");
  if (!blob) return [];
  const files = await decryptBundle(await git.catBlob(root, blob.sha), identity);
  for (const [rel, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), data);
  }
  return Object.keys(files);
}

export async function restore(git: Git, store: Store, project: ProjectRecord, target: string, attempts = 2): Promise<RestoreResult> {
  const root = project.path;
  const ref = refFor(store.machineId, project.slug);
  const idx = store.index(project.slug);
  const sha = idx[target] ?? Object.entries(idx).find(([id]) => id.startsWith(target))?.[1] ?? (await git.revParse(root, target));
  if (!sha) throw new Error(`unknown checkpoint ${target}`);
  const targetTr = await git.trailers(root, sha);
  const identity = await store.deviceIdentity();

  // 1) save the current state first; "unchanged" means the latest checkpoint already is the current state
  const pre = await checkpoint(git, store, project, { message: "before restore", ack: true });
  const preSha = pre.sha ?? (await git.revParse(root, ref));
  if (!preSha) throw new Error("could not record the current state before restoring");
  const preTr = await git.trailers(root, preSha);

  let wrote = 0;
  let deleted = 0;
  let envFiles: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    ({ wrote, deleted } = await writeTreeToWorktree(git, root, sha, preSha));
    envFiles = await restoreSecrets(git, root, sha, identity);
    if ((await currentFilesTree(git, root)) === targetTr["TM-Tree"]) {
      const post = await checkpoint(git, store, project, { message: `restored to ${targetTr["TM-Id"] ?? sha.slice(0, 10)}`, ack: true });
      return { ok: true, attempts: attempt, wrote, deleted, envFiles, message: `restored; recorded as ${post.tmId ?? "unchanged"}` };
    }
    if (attempt === attempts) {
      await writeTreeToWorktree(git, root, preSha, null);
      await restoreSecrets(git, root, preSha, identity);
      const rolledBack = (await currentFilesTree(git, root)) === preTr["TM-Tree"];
      return {
        ok: false, attempts, wrote, deleted, envFiles, rolledBack,
        message: rolledBack
          ? "something kept changing the folder while restoring; it is back to how it was. Close the agent and try again."
          : "the folder could not be settled. Both states are still in the timeline; nothing is lost.",
      };
    }
  }
  throw new Error("unreachable");
}
