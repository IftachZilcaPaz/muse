/**
 * Thin wrapper over a git binary. Week 1 uses the system git; the binary path is injectable so a
 * bundled git (dugite) can replace it without touching the engine.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: Buffer | string;
  /** Return raw bytes (for blobs). */
  binary?: boolean;
  /** Do not throw on a non-zero exit. */
  allowFailure?: boolean;
}

export class GitError extends Error {
  constructor(public readonly args: string[], public readonly code: number | null, public readonly stderr: string) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

export class Git {
  constructor(private readonly binary = "git") {}

  run(args: string[], opts: GitOptions): Promise<string>;
  run(args: string[], opts: GitOptions & { binary: true }): Promise<Buffer>;
  run(args: string[], opts: GitOptions): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.binary,
        args,
        { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = (err as { code?: number } | null)?.code ?? 0;
          if (err && !opts.allowFailure) {
            reject(new GitError(args, typeof code === "number" ? code : null, stderr.toString()));
            return;
          }
          resolve(opts.binary ? (stdout as Buffer) : stdout.toString("utf8"));
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
  }

  async revParse(cwd: string, ref: string): Promise<string | null> {
    const out = await this.run(["rev-parse", "--verify", "-q", ref], { cwd, allowFailure: true });
    const sha = out.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async headSha(cwd: string): Promise<string | null> {
    return this.revParse(cwd, "HEAD");
  }

  /** A marker file git leaves while a rebase, merge, cherry-pick, revert or bisect is in progress. */
  async busyReason(cwd: string): Promise<string | null> {
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
      const rel = (await this.run(["rev-parse", "--git-path", marker], { cwd })).trim();
      if (existsSync(path.resolve(cwd, rel))) return marker;
    }
    return null;
  }

  /** Parse "Key: value" trailers from a commit message. */
  async trailers(cwd: string, sha: string): Promise<Record<string, string>> {
    const body = await this.run(["log", "-1", "--format=%(trailers:only,unfold)", sha], { cwd });
    const out: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }

  async lsTree(cwd: string, treeish: string): Promise<Map<string, { mode: string; sha: string }>> {
    const out = await this.run(["ls-tree", "-r", "-z", treeish], { cwd });
    const map = new Map<string, { mode: string; sha: string }>();
    for (const rec of out.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      const [mode, , sha] = rec.slice(0, tab).split(" ");
      map.set(rec.slice(tab + 1), { mode, sha });
    }
    return map;
  }

  catBlob(cwd: string, sha: string): Promise<Buffer> {
    return this.run(["cat-file", "blob", sha], { cwd, binary: true }) as unknown as Promise<Buffer>;
  }
}
