import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine, Git, JsonStore, refFor } from "../src/engine/index.js";
import { decryptBundle } from "../src/engine/crypto.js";
import { buildSamples, type Samples } from "./fixtures.js";

const REMOTE = process.env.TM_TEST_REMOTE; // optional: a GitHub repo URL to push the hidden refs to

let root: string;
let samples: Samples;
let engine: Engine;
const git = new Git();

const ourRef = async (repo: string) => (await git.run(["for-each-ref", "--format=%(refname)", "refs/timemachine"], { cwd: repo })).trim().split("\n")[0];
const storedFiles = async (repo: string) => (await git.run(["ls-tree", "-r", "--name-only", await ourRef(repo)], { cwd: repo })).trim().split("\n");
const status = async (repo: string) => (await git.run(["status", "--short"], { cwd: repo })).trimEnd();

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tm-test-"));
  samples = await buildSamples(path.join(root, "samples"));
  engine = await Engine.open(path.join(root, "state"));
});

describe("1. discovery", () => {
  it("reads Claude Code and Cursor path lists, filters noise, folds nested, decodes, sorts by recency", async () => {
    const res = await engine.discover({ home: samples.home });
    const names = res.map((r) => r.name);
    expect(names).toEqual(["recipes-bot", "noa-landing", "flights&hotels", "untitled folder 12"]);
    expect(res.every((r) => !r.path.includes("Library") && !r.path.endsWith(".claude") && r.path !== samples.home)).toBe(true);
    const bot = res.find((r) => r.name === "recipes-bot")!;
    expect(bot.nested).toEqual(["scripts"]);
    expect(bot.sources).toEqual(["claude-code", "cursor"]);
    expect(res.filter((r) => r.active).map((r) => r.name)).toEqual(["recipes-bot", "noa-landing"]);
    expect(res.find((r) => r.name === "noa-landing")!.inDownloads).toBe(true);
    expect(res.find((r) => r.name === "flights&hotels")!.inICloud).toBe(true);
  });

  it("filters by tool, keeping projects reached through any selected tool", async () => {
    const claudeOnly = await engine.discover({ home: samples.home, tools: ["claude-code"] });
    expect(claudeOnly.map((r) => r.name)).toEqual(["recipes-bot", "noa-landing", "untitled folder 12"]);
    const cursorOnly = await engine.discover({ home: samples.home, tools: ["cursor"] });
    expect(cursorOnly.map((r) => r.name)).toEqual(["recipes-bot", "flights&hotels"]);
  });

  it("detects installed tools", async () => {
    const tools = await engine.detectTools(samples.home);
    expect(tools.find((t) => t.id === "claude-code")!.installed).toBe(true);
    expect(tools.find((t) => t.id === "cursor")!.installed).toBe(true);
    expect(tools.find((t) => t.id === "lovable")!.browserOnly).toBe(true);
  });
});

describe("2. secret policy and the first checkpoint", () => {
  it("yellow (sk_test in code) needs an acknowledgement", async () => {
    await engine.track(samples.noaLanding, REMOTE);
    const r = await engine.checkpoint("noa-landing");
    expect(r.status).toBe("needs-ack");
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual(
      expect.arrayContaining([["stripe-test-secret", "yellow"], ["stripe-publishable", "green"], ["supabase-jwt", "green"]]),
    );
    expect(existsSync(path.join(samples.noaLanding, ".git"))).toBe(true);
    expect(await git.headSha(samples.noaLanding)).toBeNull(); // HEAD unborn: no commit on main
  });

  it("stores the right files after --ack: no junk, no 55MB asset, .env only encrypted", async () => {
    const r = await engine.checkpoint("noa-landing", { ack: true });
    expect(r.status).toBe("created");
    expect(r.excludedLarge).toEqual(["assets/hero-video.mp4"]);
    const files = await storedFiles(samples.noaLanding);
    expect(files).toContain(".timemachine/secrets.age");
    expect(files).toContain("src/lib/supabase.js");
    expect(files).toContain(".gitignore");
    expect(files.some((f) => /node_modules|^dist\/|DS_Store|hero-video|^\.env$/.test(f))).toBe(false);
    expect(await git.headSha(samples.noaLanding)).toBeNull();
  });

  it("red (service_role in code) blocks even with --ack; history-only findings are yellow", async () => {
    await engine.track(samples.recipesBot, REMOTE);
    const blocked = await engine.checkpoint("recipes-bot", { ack: true });
    expect(blocked.status).toBe("blocked");
    expect(blocked.findings.find((f) => f.where.startsWith("worktree:bot.py"))!.severity).toBe("red");
    expect(blocked.findings.filter((f) => f.where.startsWith("history:")).every((f) => f.severity === "yellow")).toBe(true);

    // the user applied the fix prompt
    const bot = path.join(samples.recipesBot, "bot.py");
    await fs.writeFile(bot, (await fs.readFile(bot, "utf8")).split("\n# quick hack")[0] + "\n");
    const r = await engine.checkpoint("recipes-bot", { ack: true });
    expect(r.status).toBe("created");
    const chain = await engine.list("recipes-bot");
    expect(chain).toHaveLength(1);
    expect(chain[0].userParents).toHaveLength(1); // the user's HEAD is the first checkpoint's parent
    expect(await status(samples.recipesBot)).toMatch(/^ M bot.py/m); // dirty tree untouched
    expect(await git.run(["log", "--format=%s", "main"], { cwd: samples.recipesBot })).toContain("oops, remove env");
  });
});

describe("3. busy repo and no-change detection", () => {
  it("skips while a rebase is in progress", async () => {
    const marker = path.join(samples.recipesBot, ".git", "rebase-merge");
    await fs.mkdir(marker);
    try {
      expect((await engine.checkpoint("recipes-bot", { ack: true })).status).toBe("skipped-busy");
    } finally {
      await fs.rmdir(marker);
    }
  });
  it("does not create a checkpoint when nothing changed", async () => {
    expect((await engine.checkpoint("noa-landing")).status).toBe("unchanged");
    expect(await engine.list("noa-landing")).toHaveLength(1);
  });
});

describe("4. the disaster and the restore", () => {
  let good: string;
  it("records edits, then the damage", async () => {
    await fs.writeFile(path.join(samples.noaLanding, "src/App.jsx"), "export default function App(){ return <h1>v2</h1> }\n");
    await fs.appendFile(path.join(samples.noaLanding, ".env"), "NEW_FLAG=1\n");
    const r = await engine.checkpoint("noa-landing", { at: "2026-11-05T09:00:00+00:00" });
    expect(r.status).toBe("created");
    expect(r.message).toMatch(/1 file changed/);
    good = r.tmId!;
    await fs.rm(path.join(samples.noaLanding, "src/lib/supabase.js"));
    await fs.writeFile(path.join(samples.noaLanding, "src/main.jsx"), "// oops\n");
    expect((await engine.checkpoint("noa-landing", { at: "2026-11-05T09:20:00+00:00" })).status).toBe("created");
  });
  it("restores files without touching HEAD and records the restore", async () => {
    const r = await engine.restore("noa-landing", good);
    expect(r.ok).toBe(true);
    expect(r.envFiles).toEqual([".env", ".env.local"]);
    expect(existsSync(path.join(samples.noaLanding, "src/lib/supabase.js"))).toBe(true);
    expect(await fs.readFile(path.join(samples.noaLanding, "src/main.jsx"), "utf8")).toContain("createRoot");
    expect(await fs.readFile(path.join(samples.noaLanding, ".env"), "utf8")).toContain("NEW_FLAG");
    expect(await git.headSha(samples.noaLanding)).toBeNull();
    const chain = await engine.list("noa-landing");
    expect(chain[chain.length - 1].subject).toMatch(/^restored to/);
  });
});

describe("5. second parent and retention", () => {
  it("links the user's new commit as second parent", async () => {
    await git.run(["add", "notes.md"], { cwd: samples.recipesBot });
    await git.run(["commit", "-q", "-m", "add notes"], { cwd: samples.recipesBot, env: { GIT_AUTHOR_NAME: "Noa", GIT_AUTHOR_EMAIL: "noa@example.com", GIT_COMMITTER_NAME: "Noa", GIT_COMMITTER_EMAIL: "noa@example.com" } });
    await fs.appendFile(path.join(samples.recipesBot, "notes.md"), "- more\n");
    const r = await engine.checkpoint("recipes-bot", { at: "2026-09-20T10:00:00+00:00" });
    expect(r.status).toBe("created");
    const chain = await engine.list("recipes-bot");
    expect(chain[chain.length - 1].userParents).toHaveLength(1);
  });

  it("thins a 36-checkpoint fake history per policy and keeps the user's history intact", async () => {
    const now = new Date("2026-11-05T12:00:00Z");
    const stamps: Date[] = [];
    for (const d of [80, 60, 45, 35]) stamps.push(new Date(now.getTime() - d * 864e5));
    for (const d of [25, 20, 15, 10, 9, 8]) for (const h of [1, 5]) stamps.push(new Date(now.getTime() - d * 864e5 - h * 36e5));
    for (const d of [6, 4, 2]) for (const m of [0, 20, 40, 90]) stamps.push(new Date(now.getTime() - d * 864e5 - m * 6e4));
    for (const h of [20, 10, 3, 1]) for (const m of [0, 15]) stamps.push(new Date(now.getTime() - h * 36e5 - m * 6e4));
    stamps.sort((a, b) => a.getTime() - b.getTime());
    for (const [i, t] of stamps.entries()) {
      await fs.writeFile(path.join(samples.recipesBot, "notes.md"), `# TODO\n- step ${i}\n`);
      expect((await engine.checkpoint("recipes-bot", { at: t.toISOString() })).status).toBe("created");
    }
    const before = await engine.list("recipes-bot");
    const links = before.filter((e) => e.userParents.length).length;
    const tipTree = (await git.run(["rev-parse", `${before[before.length - 1].sha}^{tree}`], { cwd: samples.recipesBot })).trim();

    const pro = await engine.thin("recipes-bot", { keepWeeklyBeyond30Days: true }, now);
    expect(pro!.before).toBe(38);
    expect(pro!.after).toBe(29);
    const after = await engine.list("recipes-bot");
    expect(after).toHaveLength(29);
    expect((await git.run(["rev-parse", `${after[after.length - 1].sha}^{tree}`], { cwd: samples.recipesBot })).trim()).toBe(tipTree);
    expect(after.filter((e) => e.userParents.length).length).toBe(links);
    expect(after.filter((e) => e.date.startsWith("2026-11-03T1")).length).toBe(3); // one per hour in days 2-7
    expect(after.filter((e) => /^2026-10-2[678]/.test(e.date)).length).toBe(3); // one per day in days 8-30
    expect(after.some((e) => e.date.startsWith("2026-09-06"))).toBe(true); // weekly beyond 30 days
    expect(Object.values(engine.store.index("recipes-bot"))).toContain(after[after.length - 1].sha); // stable ids remapped

    const free = await engine.thin("recipes-bot", { keepWeeklyBeyond30Days: false }, now);
    expect(free!.after).toBe(24);
    expect((await engine.list("recipes-bot")).some((e) => e.date.startsWith("2026-08-17"))).toBe(false);
    expect(await git.run(["log", "--format=%s", "-1", "main"], { cwd: samples.recipesBot })).toContain("add notes");
  });
});

describe("6. a new machine", () => {
  it("fetches only our ref into an empty repo, decrypts with the recovery key, rebuilds the folder", async () => {
    const fresh = path.join(root, "new-machine", "noa-landing");
    await fs.mkdir(fresh, { recursive: true });
    await git.run(["init", "-q", "-b", "main"], { cwd: fresh });
    await git.run(["fetch", "-q", samples.noaLanding, "+refs/timemachine/*:refs/timemachine/*"], { cwd: fresh });
    const ref = await ourRef(fresh);
    expect(ref).toBe(refFor(engine.store.machineId, "noa-landing"));

    const blob = (await git.lsTree(fresh, ref)).get(".timemachine/secrets.age")!;
    const recovery = await (engine.store as JsonStore).recoveryIdentity();
    const env = await decryptBundle(await git.catBlob(fresh, blob.sha), recovery);
    expect(env[".env"].toString()).toContain("NEW_FLAG");

    await engine.track(fresh, undefined, "noa-landing"); // same identity, new disk
    const tip = await git.revParse(fresh, ref);
    const r = await engine.restore("noa-landing", tip!);
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(fresh, "src/lib/supabase.js"))).toBe(true);
    expect(existsSync(path.join(fresh, "package.json"))).toBe(true);
  });
});

describe.skipIf(!REMOTE)("7. push to the backup remote", () => {
  it("pushes only refs/timemachine/*", async () => {
    await engine.track(samples.noaLanding, REMOTE, "noa-landing");
    const out = await engine.push("noa-landing");
    expect(out).toMatch(/refs\/timemachine/);
  });
});
