#!/usr/bin/env tsx
/** Developer CLI over the engine. Mirrors prototype/tm.py so the two can be compared. */
import os from "node:os";
import path from "node:path";
import { Engine } from "./index.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["ack", "free", "json"].includes(args[i - 1].slice(2))));

async function main() {
  const stateDir = flag("state") ?? path.join(os.homedir(), ".timemachine");
  const engine = await Engine.open(stateDir);
  const [cmd, a1, a2] = positional;
  switch (cmd) {
    case "discover": {
      const home = flag("home") ?? os.homedir();
      const res = await engine.discover({ home });
      if (has("json")) return console.log(JSON.stringify(res, null, 1));
      for (const r of res) {
        const extra = [
          r.nested.length ? `contains ${r.nested.length} nested: ${r.nested.join(", ")}` : "",
          r.inDownloads ? "in Downloads: suggest moving to ~/Projects" : "",
          r.inICloud ? "in iCloud: suggest moving out" : "",
          r.hasGit ? "" : "no git",
        ].filter(Boolean);
        console.log(`${r.active ? "[x]" : "[ ]"} ${r.lastActive}  ${r.name.padEnd(28)} ${r.sources.join(",").padEnd(20)} ${extra.join("; ")}`);
      }
      return;
    }
    case "tools":
      return console.log(await engine.detectTools(flag("home") ?? os.homedir()));
    case "track":
      return console.log(await engine.track(a1, flag("remote"), flag("slug")));
    case "scan": {
      const r = await engine.scan(a1);
      for (const f of r.findings) console.log(`  [${f.severity.padEnd(6)}] ${f.rule.padEnd(22)} ${f.where}  ${f.sample}  ${f.note}`);
      return console.log(`  verdict: ${r.verdict.toUpperCase()}`);
    }
    case "checkpoint": {
      const r = await engine.checkpoint(a1, { message: flag("m"), ack: has("ack"), at: flag("at") });
      for (const f of r.findings) if (f.severity !== "green") console.log(`  [${f.severity.toUpperCase().padEnd(6)}] ${f.rule.padEnd(22)} ${f.where}  ${f.sample}  ${f.note}`);
      if (r.status === "created") console.log(`  checkpoint ${r.tmId} -> ${r.sha!.slice(0, 10)}  "${r.message}"${r.excludedLarge.length ? `, excluded ${r.excludedLarge.join(", ")}` : ""}`);
      else console.log(`  ${r.status}${r.reason ? `: ${r.reason}` : ""}`);
      return;
    }
    case "list":
      for (const e of await engine.list(a1)) console.log(`  ${e.tmId.padEnd(12)} ${e.sha.slice(0, 10)} ${e.date}  ${e.subject}${e.userParents.length ? `  (+ user commit ${e.userParents[0].slice(0, 8)})` : ""}`);
      return;
    case "push":
      return console.log(await engine.push(a1));
    case "restore":
      return console.log(await engine.restore(a1, a2));
    case "thin":
      return console.log(await engine.thin(a1, { keepWeeklyBeyond30Days: !has("free") }, flag("now") ? new Date(flag("now")!) : undefined));
    case "status":
      return console.log(await engine.status(a1));
    default:
      console.error("usage: engine <discover|tools|track|scan|checkpoint|list|push|restore|thin|status> ...");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
