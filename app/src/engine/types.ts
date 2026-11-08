/** Shared engine types. The engine has no Electron dependency: it runs in the main process, in tests, and in the CLI. */

export type Severity = "green" | "yellow" | "red";

export type ToolId = "claude-code" | "cursor" | "claude-desktop" | "codex" | "lovable" | "bolt" | "v0" | "replit";

export interface DetectedTool {
  id: ToolId;
  installed: boolean;
  /** Browser tools leave nothing on disk; the user has to tell us. */
  browserOnly: boolean;
  projectCount: number;
}

export interface Candidate {
  path: string;
  name: string;
  sources: ToolId[];
  /** ISO date of the last activity we could see (tool session, workspace, or folder mtime). */
  lastActive: string;
  active: boolean;
  hasGit: boolean;
  markers: string[];
  /** Child folders that were opened as their own project; they are backed up with the parent. */
  nested: string[];
  inDownloads: boolean;
  inICloud: boolean;
}

export interface DiscoverOptions {
  home: string;
  /** Only candidates reached through these tools are returned. Omit for all. */
  tools?: ToolId[];
  activeDays?: number;
  now?: Date;
}

export interface Finding {
  rule: string;
  severity: Severity;
  /** "worktree:path:line" or "history:<blob>:path:line" */
  where: string;
  sample: string;
  note: string;
  fingerprint: string;
}

export interface ScanResult {
  findings: Finding[];
  verdict: Severity;
}

export interface CheckpointEntry {
  sha: string;
  tmId: string;
  date: string;
  subject: string;
  filesTree: string;
  /** Parents that are the user's own commits (sole parent on the first checkpoint, second parent later). */
  userParents: string[];
}

export interface CheckpointResult {
  status: "created" | "unchanged" | "skipped-busy" | "blocked" | "needs-ack";
  sha?: string;
  tmId?: string;
  message?: string;
  findings: Finding[];
  excludedLarge: string[];
  reason?: string;
}

export interface ProjectRecord {
  slug: string;
  path: string;
  /** Name of the git remote that points at the backup repo (never "origin"). */
  remote?: string;
}

export interface RetentionPolicy {
  /** Keep weekly checkpoints beyond 30 days (Pro) or drop them (Free). */
  keepWeeklyBeyond30Days: boolean;
}
