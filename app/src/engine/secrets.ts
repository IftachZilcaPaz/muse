/**
 * Secret scanning: a gitleaks-style rule set plus an allowlist for keys that are public by design.
 * Policy: red blocks; yellow needs an explicit acknowledgement; findings in git history are never red,
 * because history cannot be fixed by editing a file: the remedy is rotating the key.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Git } from "./git.js";
import type { Finding, ScanResult, Severity } from "./types.js";

type Rule = { name: string; re: RegExp; severity: Severity | null };

const RULES: Rule[] = [
  { name: "supabase-jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, severity: null },
  { name: "supabase-publishable", re: /sb_publishable_[A-Za-z0-9_-]{10,}/g, severity: "green" },
  { name: "supabase-secret", re: /sb_secret_[A-Za-z0-9_-]{10,}/g, severity: "red" },
  { name: "stripe-live-secret", re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/g, severity: "red" },
  { name: "stripe-test-secret", re: /\bsk_test_[0-9a-zA-Z]{20,}/g, severity: "yellow" },
  { name: "stripe-publishable", re: /\bpk_(live|test)_[0-9a-zA-Z]{20,}/g, severity: "green" },
  { name: "openai", re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g, severity: "yellow" },
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, severity: "yellow" },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, severity: "yellow" },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, severity: "yellow" },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g, severity: "green" },
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, severity: "red" },
  { name: "telegram-bot", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, severity: "yellow" },
  { name: "resend", re: /\bre_[A-Za-z0-9]{20,}/g, severity: "yellow" },
  { name: "generic-assignment", re: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/gi, severity: "yellow" },
];

export function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role ?? null;
  } catch {
    return null;
  }
}

function fingerprint(rule: string, sample: string): string {
  return createHash("sha256").update(`${rule}|${sample}`).digest("hex").slice(0, 16);
}

export function scanText(text: string, where: string): Finding[] {
  const out: Finding[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const tok = m[0];
      const line = text.slice(0, m.index).split("\n").length;
      let severity: Severity = rule.severity ?? "yellow";
      let note = "";
      if (rule.name === "supabase-jwt") {
        const role = jwtRole(tok);
        if (role === "anon") [severity, note] = ["green", "anon key: public by design"];
        else if (role === "service_role") [severity, note] = ["red", "service_role bypasses RLS: never ship it in code"];
        else note = `jwt role=${role}`;
      }
      if (rule.name === "google-api-key") note = "public if restricted in Google Cloud console";
      const sample = `${tok.slice(0, 12)}…${tok.slice(-4)}`;
      out.push({ rule: rule.name, severity, where: `${where}:${line}`, sample, note, fingerprint: fingerprint(rule.name, sample) });
    }
  }
  return out;
}

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

export async function scanWorktree(root: string, files: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const rel of files) {
    try {
      const st = await fs.stat(path.join(root, rel));
      if (st.size > 1_000_000) continue;
      const b = await fs.readFile(path.join(root, rel));
      if (isText(b)) out.push(...scanText(b.toString("utf8"), `worktree:${rel}`));
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

/**
 * Blobs reachable from the user's own branches and tags. A checkpoint links the user's HEAD as a
 * parent, so pushing the chain pushes this history too; that is why it must be scanned.
 */
export async function scanHistory(git: Git, root: string, limitObjects = 5000): Promise<Finding[]> {
  const list = await git.run(["rev-list", "--objects", "--branches", "--tags"], { cwd: root, allowFailure: true });
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const line of list.split("\n").slice(0, limitObjects)) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const sha = line.slice(0, sp);
    const file = line.slice(sp + 1);
    if (!file || seen.has(sha)) continue;
    seen.add(sha);
    const type = (await git.run(["cat-file", "-t", sha], { cwd: root })).trim();
    if (type !== "blob") continue;
    const b = await git.catBlob(root, sha);
    if (b.length > 1_000_000 || !isText(b)) continue;
    for (const f of scanText(b.toString("utf8"), `history:${sha.slice(0, 8)}:${file}`)) {
      if (f.severity === "red") {
        f.severity = "yellow";
        f.note = `${f.note ? f.note + "; " : ""}in git history: rotate this key, we cannot scrub GitHub`;
      }
      out.push(f);
    }
  }
  return out;
}

export function verdict(findings: Finding[], acked: Set<string>): Severity {
  if (findings.some((f) => f.severity === "red")) return "red";
  if (findings.some((f) => f.severity === "yellow" && !acked.has(f.fingerprint))) return "yellow";
  return "green";
}

export function toScanResult(findings: Finding[], acked: Set<string>): ScanResult {
  return { findings, verdict: verdict(findings, acked) };
}
