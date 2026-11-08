/**
 * Retention: rewrite OUR chain with the same trees and new parents, then force-update OUR ref.
 * The user's branches, tags and commits are never touched; links into their history are preserved.
 */
import type { Git } from "./git.js";
import { chain, refFor } from "./checkpoint.js";
import type { Store } from "./store.js";
import type { CheckpointEntry, ProjectRecord, RetentionPolicy } from "./types.js";

const H = 3_600_000;
const D = 24 * H;

export function keepSet(entries: CheckpointEntry[], now: Date, policy: RetentionPolicy): Set<string> {
  const keep = new Set<string>();
  const buckets = new Set<string>();
  for (const e of entries) {
    const t = new Date(e.date);
    const age = now.getTime() - t.getTime();
    let key: string;
    if (age <= D) key = `all:${e.sha}`;
    else if (age <= 7 * D) key = `hour:${t.toISOString().slice(0, 13)}`;
    else if (age <= 30 * D) key = `day:${t.toISOString().slice(0, 10)}`;
    else if (!policy.keepWeeklyBeyond30Days) continue;
    else key = `week:${isoWeek(t)}`;
    if (buckets.has(key)) continue; // entries are oldest-first: the first in a bucket is kept
    buckets.add(key);
    keep.add(e.sha);
  }
  keep.add(entries[entries.length - 1].sha); // the newest always survives
  return keep;
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / D + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface ThinResult {
  before: number;
  after: number;
  oldTip: string;
  newTip: string;
}

export async function thin(git: Git, store: Store, project: ProjectRecord, policy: RetentionPolicy, now = new Date()): Promise<ThinResult | null> {
  const root = project.path;
  const ref = refFor(store.machineId, project.slug);
  const entries = await chain(git, root, ref);
  if (!entries.length) return null;
  const keep = keepSet(entries, now, policy);
  const oldTip = entries[entries.length - 1].sha;
  let newPrev: string | null = null;
  const remap = new Map<string, string>();
  for (const e of entries) {
    if (!keep.has(e.sha)) continue;
    const tree = (await git.run(["rev-parse", `${e.sha}^{tree}`], { cwd: root })).trim();
    const body = await git.run(["log", "-1", "--format=%B", e.sha], { cwd: root });
    const [aDate, cDate, name, email] = (await git.run(["log", "-1", "--format=%aI%x1f%cI%x1f%an%x1f%ae", e.sha], { cwd: root })).trim().split("\x1f");
    const parents: string[] = [];
    if (newPrev) parents.push("-p", newPrev);
    for (const p of e.userParents) parents.push("-p", p); // keep links into the user's history
    const env = { GIT_AUTHOR_DATE: aDate, GIT_COMMITTER_DATE: cDate, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    const sha = (await git.run(["commit-tree", tree, ...parents, "-m", body], { cwd: root, env })).trim();
    remap.set(e.sha, sha);
    newPrev = sha;
  }
  await git.run(["update-ref", ref, newPrev!, oldTip], { cwd: root }); // force on OUR ref only
  const idx = { ...store.index(project.slug) };
  for (const e of entries) {
    if (!(e.tmId in idx)) continue;
    const mapped = remap.get(e.sha);
    if (mapped) idx[e.tmId] = mapped;
    else delete idx[e.tmId];
  }
  await store.setIndex(project.slug, idx);
  return { before: entries.length, after: keep.size, oldTip, newTip: newPrev! };
}
