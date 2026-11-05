#!/usr/bin/env python3
"""
Time Machine engine prototype (throwaway reference implementation).

Every git operation here is done with the git CLI in a way that maps 1:1 onto libgit2:
  temp index + write-tree      -> git_index_new / git_index_add_all / git_index_write_tree
  commit-tree                  -> git_commit_create (with explicit parents)
  update-ref with old value    -> git_reference_create_matching (compare-and-swap)
  push +refs/timemachine/*     -> git_remote_push with a force refspec on OUR namespace only

Hard rules enforced by this file:
  * never touch the user's HEAD, index or branches
  * never push to the user's branches/tags; only refs/timemachine/* (force allowed there)
  * secret scan runs before every checkpoint; red blocks, yellow needs --ack
  * restore writes files; it never checks out, never moves HEAD

Subcommands: discover, scan, track, checkpoint, list, push, restore, thin, status
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import uuid
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------------------
# constants
# --------------------------------------------------------------------------------------
REF_NS = "refs/timemachine"
MAX_FILE_BYTES = 50 * 1024 * 1024          # GitHub warns at 50MB, blocks at 100MB
ACTIVE_DAYS = 90
DEFAULT_EXCLUDES = """
# --- Time Machine default excludes (applied on top of the project's .gitignore) ---
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
"""
RECOVERY_KIT_NAME = "TIME-MACHINE-RECOVERY-KIT.txt"


# --------------------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------------------
def git(args: list[str], cwd: Path, env: dict | None = None, check=True, input: bytes | None = None) -> str:
    e = os.environ.copy()
    if env:
        e.update(env)
    r = subprocess.run(["git", *args], cwd=cwd, env=e, capture_output=True, input=input)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed ({r.returncode}):\n{r.stderr.decode(errors='replace')}")
    return r.stdout.decode(errors="replace")


def git_bytes(args: list[str], cwd: Path) -> bytes:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=True)
    return r.stdout


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", name).strip("-").lower()
    return s or "project"


def die(msg: str, code=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


# --------------------------------------------------------------------------------------
# state (stands in for SQLite + Keychain in the real app)
# --------------------------------------------------------------------------------------
class State:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.file = root / "state.json"
        self.data = json.loads(self.file.read_text()) if self.file.exists() else {}
        self.data.setdefault("machine_id", secrets.token_hex(4))
        self.data.setdefault("projects", {})       # slug -> {path, remote}
        self.data.setdefault("index", {})          # slug -> {tm_id -> sha}   (stable id -> current sha)
        self.data.setdefault("acks", {})           # slug -> [finding fingerprints the user accepted]
        self._ensure_keys()
        self.save()

    def save(self):
        self.file.write_text(json.dumps(self.data, indent=1, sort_keys=True))

    @property
    def machine_id(self) -> str:
        return self.data["machine_id"]

    # --- keys: device key (Keychain in the real app) + recovery key (the printed kit) ---
    def _ensure_keys(self):
        dev = self.root / "device.key"
        rec = self.root / "recovery.key"
        if not dev.exists():
            subprocess.run(["age-keygen", "-o", str(dev)], check=True, capture_output=True)
            dev.chmod(0o600)
        if not rec.exists():
            subprocess.run(["age-keygen", "-o", str(rec)], check=True, capture_output=True)
            rec.chmod(0o600)
            kit = self.root / RECOVERY_KIT_NAME
            kit.write_text(
                "TIME MACHINE RECOVERY KIT\n"
                "Keep this somewhere that survives your computer: password manager, iCloud Drive, or print it.\n"
                "Without it, the encrypted .env files in your backups cannot be read on a new machine.\n\n"
                f"{rec.read_text()}"
            )

    @staticmethod
    def _pub(identity_file: Path) -> str:
        for line in identity_file.read_text().splitlines():
            if line.startswith("# public key:"):
                return line.split(":", 1)[1].strip()
        raise RuntimeError("no public key in identity file")

    def recipients(self) -> list[str]:
        return [self._pub(self.root / "device.key"), self._pub(self.root / "recovery.key")]

    def identity_file(self) -> Path:
        return self.root / "device.key"

    # --- projects ---
    def project(self, slug: str) -> dict:
        p = self.data["projects"].get(slug)
        if not p:
            die(f"unknown project '{slug}'. Run: tm.py track <path>")
        return p


# --------------------------------------------------------------------------------------
# discover: ~/.claude.json + Cursor workspaceStorage, filtered, nested, by recency
# --------------------------------------------------------------------------------------
@dataclass
class Candidate:
    path: Path
    sources: set = field(default_factory=set)
    last_active: float = 0.0
    nested: list = field(default_factory=list)

    def bump(self, ts: float):
        self.last_active = max(self.last_active, ts)


def claude_encoded(path: Path) -> str:
    # Claude Code's lossy encoding: every '/' becomes '-' (so it can't be reversed reliably)
    return str(path).replace("/", "-")


def discover(home: Path) -> list[dict]:
    cands: dict[Path, Candidate] = {}

    def add(p: Path, src: str, ts: float):
        p = p.resolve() if p.exists() else p
        c = cands.setdefault(p, Candidate(p))
        c.sources.add(src)
        c.bump(ts)

    # 1) Claude Code: ~/.claude.json  { "projects": { "/abs/path": {...} } }
    cj = home / ".claude.json"
    if cj.exists():
        try:
            projects = json.loads(cj.read_text()).get("projects", {})
        except json.JSONDecodeError:
            projects = {}
        for raw in projects:
            p = Path(raw)
            ts = 0.0
            sess = home / ".claude" / "projects" / claude_encoded(p)
            if sess.exists():
                ts = max((f.stat().st_mtime for f in sess.rglob("*") if f.is_file()), default=sess.stat().st_mtime)
            add(p, "claude-code", ts)

    # 2) Cursor: ~/Library/Application Support/Cursor/User/workspaceStorage/<id>/workspace.json {"folder": "file:///..."}
    ws_root = home / "Library" / "Application Support" / "Cursor" / "User" / "workspaceStorage"
    if ws_root.exists():
        for wj in ws_root.glob("*/workspace.json"):
            try:
                folder = json.loads(wj.read_text()).get("folder", "")
            except json.JSONDecodeError:
                continue
            if not folder.startswith("file://"):
                continue
            p = Path(urllib.parse.unquote(folder[len("file://"):]))      # %26 -> &
            add(p, "cursor", wj.stat().st_mtime)

    # 3) filters: home itself, dot-directories, anything under ~/Library, non-existent
    home_r = home.resolve()
    lib = home_r / "Library"

    def noisy(p: Path) -> bool:
        if p == home_r or not p.is_dir():
            return True
        if lib in p.parents or p == lib:
            return True
        rel = p.relative_to(home_r) if home_r in p.parents else p
        return any(part.startswith(".") for part in rel.parts)

    kept = {p: c for p, c in cands.items() if not noisy(p)}

    # folder mtime counts too (work done outside both tools)
    for c in kept.values():
        c.bump(c.path.stat().st_mtime)

    # 4) nesting: a candidate inside another candidate is folded into its parent
    tops: dict[Path, Candidate] = {}
    for p, c in sorted(kept.items(), key=lambda kv: len(kv[0].parts)):
        parent = next((q for q in tops if q in p.parents), None)
        if parent:
            tops[parent].nested.append(str(p.relative_to(parent)))
            tops[parent].sources |= c.sources
            tops[parent].bump(c.last_active)
        else:
            tops[p] = c

    cutoff = dt.datetime.now().timestamp() - ACTIVE_DAYS * 86400
    out = []
    for c in sorted(tops.values(), key=lambda c: -c.last_active):
        out.append({
            "path": str(c.path),
            "sources": sorted(c.sources),
            "last_active": dt.datetime.fromtimestamp(c.last_active).date().isoformat(),
            "active": c.last_active >= cutoff,
            "has_git": (c.path / ".git").exists(),
            "markers": [m for m in ("package.json", "pyproject.toml", "requirements.txt", "index.html", "Cargo.toml", "go.mod") if (c.path / m).exists()],
            "nested": c.nested,
            "in_downloads": "Downloads" in c.path.parts,
        })
    return out


# --------------------------------------------------------------------------------------
# secret scanning: small gitleaks-style rule set + allowlist for keys that are public by design
# --------------------------------------------------------------------------------------
GREEN, YELLOW, RED = "green", "yellow", "red"
RULES = [
    # (name, regex, severity)  -- severity may be refined by a callback
    ("supabase-jwt", r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", None),
    ("supabase-publishable", r"sb_publishable_[A-Za-z0-9_-]{10,}", GREEN),
    ("supabase-secret", r"sb_secret_[A-Za-z0-9_-]{10,}", RED),
    ("stripe-live-secret", r"\b[sr]k_live_[0-9a-zA-Z]{20,}", RED),
    ("stripe-test-secret", r"\bsk_test_[0-9a-zA-Z]{20,}", YELLOW),
    ("stripe-publishable", r"\bpk_(live|test)_[0-9a-zA-Z]{20,}", GREEN),
    ("openai", r"\bsk-(proj-)?[A-Za-z0-9_-]{20,}", YELLOW),
    ("aws-access-key", r"\bAKIA[0-9A-Z]{16}\b", YELLOW),
    ("github-token", r"\bgh[pousr]_[A-Za-z0-9]{30,}", YELLOW),
    ("google-api-key", r"\bAIza[0-9A-Za-z_-]{35}", GREEN),      # Firebase/Maps browser keys: public if restricted
    ("private-key", r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----", RED),
    ("telegram-bot", r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b", YELLOW),
    ("resend", r"\bre_[A-Za-z0-9]{20,}", YELLOW),
    ("generic-assignment", r"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]", YELLOW),
]
COMPILED = [(n, re.compile(rx), sev) for n, rx, sev in RULES]


def jwt_role(token: str) -> str | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("role")
    except Exception:
        return None


@dataclass
class Finding:
    rule: str
    severity: str
    where: str          # "worktree:path:line" or "history:<sha>:path"
    sample: str
    note: str = ""

    def fingerprint(self) -> str:
        return hashlib.sha256(f"{self.rule}|{self.sample}".encode()).hexdigest()[:16]


def scan_text(text: str, where: str) -> list[Finding]:
    out = []
    for name, rx, sev in COMPILED:
        for m in rx.finditer(text):
            tok = m.group(0)
            line = text.count("\n", 0, m.start()) + 1
            note = ""
            if name == "supabase-jwt":
                role = jwt_role(tok)
                if role == "anon":
                    sev, note = GREEN, "anon key: public by design"
                elif role == "service_role":
                    sev, note = RED, "service_role bypasses RLS: never ship it in code"
                else:
                    sev, note = YELLOW, f"jwt role={role!r}"
            if name == "google-api-key":
                note = "public if restricted in Google Cloud console"
            out.append(Finding(name, sev, f"{where}:{line}", tok[:12] + "…" + tok[-4:], note))
    return out


def is_probably_text(b: bytes) -> bool:
    return b"\x00" not in b[:8000]


def scan_worktree(repo: Path, paths: list[str]) -> list[Finding]:
    findings = []
    for rel in paths:
        f = repo / rel
        try:
            if f.stat().st_size > 1_000_000:
                continue
            b = f.read_bytes()
        except OSError:
            continue
        if is_probably_text(b):
            findings += scan_text(b.decode("utf-8", errors="replace"), f"worktree:{rel}")
    return findings


def scan_history(repo: Path, limit_objects=5000) -> list[Finding]:
    """Scan blobs reachable from the user's own refs (branches/tags). A secret here means a
    checkpoint with the user's HEAD as a parent would push that history to the backup repo."""
    if not (repo / ".git").exists():
        return []
    try:
        objs = git(["rev-list", "--objects", "--branches", "--tags"], repo)
    except RuntimeError:
        return []
    findings, seen = [], set()
    for line in objs.splitlines()[:limit_objects]:
        parts = line.split(" ", 1)
        if len(parts) != 2 or not parts[1]:
            continue
        sha, path = parts
        if sha in seen:
            continue
        seen.add(sha)
        if git(["cat-file", "-t", sha], repo).strip() != "blob":
            continue
        b = git_bytes(["cat-file", "blob", sha], repo)
        if len(b) > 1_000_000 or not is_probably_text(b):
            continue
        for fnd in scan_text(b.decode("utf-8", errors="replace"), f"history:{sha[:8]}:{path}"):
            # History cannot be "fixed" by editing a file; the only remedy is rotating the key.
            # So a history finding is never a hard block: it is YELLOW, and --ack means "I rotated it".
            if fnd.severity == RED:
                fnd.severity = YELLOW
                fnd.note = (fnd.note + "; " if fnd.note else "") + "in git history: rotate this key, we cannot scrub GitHub"
            findings.append(fnd)
    return findings


def verdict(findings: list[Finding], acked: set[str]) -> str:
    if any(f.severity == RED for f in findings):
        return RED
    if any(f.severity == YELLOW and f.fingerprint() not in acked for f in findings):
        return YELLOW
    return GREEN


# --------------------------------------------------------------------------------------
# checkpoint engine
# --------------------------------------------------------------------------------------
def ref_for(state: State, slug: str) -> str:
    # spec: refs/timemachine/<machine-id>/autosave in a per-project backup repo.
    # This prototype pushes both samples to ONE repo, so the project slug is part of the ref.
    return f"{REF_NS}/{state.machine_id}/{slug}/autosave"


def repo_busy(repo: Path) -> str | None:
    for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"):
        p = git(["rev-parse", "--git-path", marker], repo).strip()
        if (repo / p).exists():
            return marker
    return None


def head_sha(repo: Path) -> str | None:
    r = subprocess.run(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=repo, capture_output=True, text=True)
    return r.stdout.strip() or None


def ref_sha(repo: Path, ref: str) -> str | None:
    r = subprocess.run(["git", "rev-parse", "--verify", "-q", ref], cwd=repo, capture_output=True, text=True)
    return r.stdout.strip() or None


def trailers(repo: Path, sha: str) -> dict:
    body = git(["log", "-1", "--format=%(trailers:only,unfold)", sha], repo)
    out = {}
    for line in body.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def ensure_repo(project: Path) -> bool:
    """git init if needed. Leaves HEAD unborn: we never create commits on the user's branch.
    Writes a .gitignore only when the project has none (so Cursor's git view stays clean too)."""
    created = False
    if not (project / ".git").exists():
        git(["init", "-q", "-b", "main"], project)
        created = True
    gi = project / ".gitignore"
    if not gi.exists():
        gi.write_text(DEFAULT_EXCLUDES.replace("# --- Time Machine default excludes (applied on top of the project's .gitignore) ---",
                                               "# created by Time Machine").lstrip())
    return created


def write_excludes(project: Path, extra: list[str]) -> Path:
    f = Path(tempfile.mkstemp(prefix="tm-excludes-")[1])
    f.write_text(DEFAULT_EXCLUDES + "\n".join(f"/{p}" for p in extra) + "\n")
    return f


class TreeBuild:
    """Builds a tree object of the working directory through a temporary index.
    libgit2: git_index_new + git_index_add_all + git_index_write_tree_to."""

    def __init__(self, project: Path):
        self.project = project
        self.index = Path(tempfile.mkstemp(prefix="tm-index-")[1])
        self.index.unlink()
        self.env = {"GIT_INDEX_FILE": str(self.index)}
        self.excluded_large: list[str] = []
        self.files: list[str] = []

    def _add_all(self, excludes: Path):
        git(["-c", f"core.excludesFile={excludes}", "add", "-A", "--", "."], self.project, env=self.env)

    def build_files_tree(self) -> str:
        # pass 1: dry run to find oversized files without hashing them
        ex = write_excludes(self.project, [])
        dry = git(["-c", f"core.excludesFile={ex}", "add", "-A", "-n", "--", "."], self.project, env=self.env)
        for line in dry.splitlines():
            m = re.match(r"add '(.+)'", line)
            if not m:
                continue
            rel = m.group(1)
            try:
                if (self.project / rel).stat().st_size > MAX_FILE_BYTES:
                    self.excluded_large.append(rel)
            except OSError:
                pass
        ex.unlink()
        # pass 2: real add with large files excluded
        ex = write_excludes(self.project, self.excluded_large)
        self._add_all(ex)
        ex.unlink()
        self.files = [p for p in git(["ls-files", "-z"], self.project, env=self.env).split("\0") if p]
        return git(["write-tree"], self.project, env=self.env).strip()

    def add_blob(self, rel: str, data: bytes, mode="100644"):
        sha = git(["hash-object", "-w", "--stdin"], self.project, input=data).strip()
        git(["update-index", "--add", "--cacheinfo", f"{mode},{sha},{rel}"], self.project, env=self.env)

    def write_tree(self) -> str:
        return git(["write-tree"], self.project, env=self.env).strip()

    def cleanup(self):
        if self.index.exists():
            self.index.unlink()


def collect_env_files(project: Path) -> dict[str, bytes]:
    """Files git ignores on purpose but the user cannot afford to lose: .env and friends (root + one level)."""
    out = {}
    for pat in (".env", ".env.*"):
        for f in list(project.glob(pat)) + list(project.glob(f"*/{pat}")):
            if f.is_file() and f.name != ".env.example" and "node_modules" not in f.parts:
                out[str(f.relative_to(project))] = f.read_bytes()
    return out


def secrets_bundle(files: dict[str, bytes], recipients: list[str]) -> tuple[bytes, str]:
    """tar (deterministic) -> age encrypt to device key + recovery key. Returns (ciphertext, plaintext-digest)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name in sorted(files):
            ti = tarfile.TarInfo(name)
            ti.size = len(files[name])
            ti.mtime = 0
            tar.addfile(ti, io.BytesIO(files[name]))
    plain = buf.getvalue()
    digest = hashlib.sha256(b"".join(n.encode() + b"\0" + files[n] for n in sorted(files))).hexdigest()
    args = ["age"]
    for r in recipients:
        args += ["-r", r]
    ct = subprocess.run(args, input=plain, capture_output=True, check=True).stdout
    return ct, digest


def checkpoint(state: State, slug: str, message: str | None, ack: bool, at: str | None = None, quiet=False) -> str | None:
    proj = state.project(slug)
    project = Path(proj["path"])
    ref = ref_for(state, slug)
    created = ensure_repo(project)
    if created and not quiet:
        print(f"  git init (HEAD left unborn; no commit on the user's branch)")

    busy = repo_busy(project)
    if busy:
        print(f"  skip: repository busy ({busy} in progress)")
        return None

    prev = ref_sha(project, ref)
    prev_tr = trailers(project, prev) if prev else {}
    head = head_sha(project)

    tb = TreeBuild(project)
    try:
        files_tree = tb.build_files_tree()

        # ---- secret scan: worktree files that would be stored + the user's own history ----
        findings = scan_worktree(project, tb.files)
        if head and prev_tr.get("TM-Head") != head:      # history only re-scanned when HEAD moved
            findings += scan_history(project)
        acked = set(state.data["acks"].get(slug, []))
        v = verdict(findings, acked)
        for f in findings:
            flag = "ok " if f.severity == GREEN else ("ACK" if f.fingerprint() in acked else f.severity.upper())
            if not quiet or f.severity != GREEN:
                print(f"  [{flag:6}] {f.rule:22} {f.where}  {f.sample}  {f.note}")
        if v == RED:
            print("  BLOCKED: a secret that must never be stored was found. Fix it (prompt for Claude/Cursor), then retry.")
            return None
        if v == YELLOW and not ack:
            print("  WARNING: secrets found. Re-run with --ack to back up anyway (private repo), and rotate those keys.")
            return None
        if v == YELLOW and ack:
            state.data["acks"].setdefault(slug, [])
            for f in findings:
                if f.severity == YELLOW and f.fingerprint() not in acked:
                    state.data["acks"][slug].append(f.fingerprint())
            state.save()

        # ---- encrypted .env bundle ----
        env_files = collect_env_files(project)
        secrets_digest = ""
        if env_files:
            ct, secrets_digest = secrets_bundle(env_files, state.recipients())
            tb.add_blob(".timemachine/secrets.age", ct)

        # ---- nothing changed? ----
        if prev and prev_tr.get("TM-Tree") == files_tree and prev_tr.get("TM-Secrets", "") == secrets_digest and prev_tr.get("TM-Head", "") == (head or ""):
            if not quiet:
                print("  no changes since last checkpoint")
            return prev

        tm_id = uuid.uuid4().hex[:12]
        manifest = {
            "tm_id": tm_id, "machine": state.machine_id, "created": at or now_iso(), "head": head,
            "excluded_large": tb.excluded_large, "env_files": sorted(env_files),
        }
        tb.add_blob(".timemachine/manifest.json", json.dumps(manifest, indent=1).encode())
        tree = tb.write_tree()
    finally:
        tb.cleanup()

    # ---- message from diff stat (no LLM) ----
    if not message:
        if prev:
            stat = git(["diff", "--shortstat", f"{prev}^{{tree}}", tree, "--", ".", ":!.timemachine"], project).strip()
            names = git(["diff", "--name-only", f"{prev}^{{tree}}", tree, "--", ".", ":!.timemachine"], project).split()
            dirs = {}
            for n in names:
                d = n.split("/")[0] if "/" in n else "."
                dirs[d] = dirs.get(d, 0) + 1
            top = max(dirs, key=dirs.get) if dirs else "."
            message = f"{stat or 'env/metadata update'}" + (f" (mostly in {top}/)" if top != "." else "")
        else:
            message = f"first checkpoint: {len(tb.files)} files"

    parents = []
    if prev:
        parents += ["-p", prev]
    if head and prev_tr.get("TM-Head") != head:
        parents += ["-p", head]           # second parent: the user's real commit moved since last time
    full_msg = (
        f"{message}\n\n"
        f"TM-Id: {tm_id}\nTM-Machine: {state.machine_id}\nTM-Head: {head or ''}\n"
        f"TM-Tree: {files_tree}\nTM-Secrets: {secrets_digest}\n"
    )
    env = {
        "GIT_AUTHOR_NAME": "Time Machine", "GIT_AUTHOR_EMAIL": "timemachine@users.noreply.github.com",
        "GIT_COMMITTER_NAME": "Time Machine", "GIT_COMMITTER_EMAIL": "timemachine@users.noreply.github.com",
    }
    if at:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = at
    sha = git(["commit-tree", tree, *parents, "-m", full_msg], project, env=env).strip()
    # compare-and-swap on our ref only (libgit2: git_reference_create_matching)
    git(["update-ref", ref, sha, prev or "0" * 40], project)
    state.data["index"].setdefault(slug, {})[tm_id] = sha
    state.save()
    if not quiet:
        extra = f", +{len(tb.excluded_large)} oversized file(s) excluded" if tb.excluded_large else ""
        print(f"  checkpoint {tm_id} -> {sha[:10]}  \"{message}\"{extra}")
        for big in tb.excluded_large:
            print(f"    excluded (> {MAX_FILE_BYTES // (1024 * 1024)}MB): {big}")
    return sha


def chain(project: Path, ref: str) -> list[dict]:
    if not ref_sha(project, ref):
        return []
    # trailer placeholders emit their own newlines, so records are separated with RS (0x1e), fields with US (0x1f)
    fmt = "%H%x1f%P%x1f%cI%x1f%s%x1f%(trailers:key=TM-Id,valueonly)%x1f%(trailers:key=TM-Tree,valueonly)%x1e"
    out = []
    for rec in git(["log", "--first-parent", f"--format={fmt}", ref], project).split("\x1e"):
        if not rec.strip():
            continue
        sha, parents, date, subject, tm_id, tree = [f.strip() for f in rec.split("\x1f")]
        if not tm_id:
            break            # the first checkpoint's only parent is the user's HEAD: the chain ends here
        out.append({"sha": sha, "parents": parents.split(), "date": date, "subject": subject,
                    "tm_id": tm_id, "files_tree": tree})
    out.reverse()            # oldest first
    ours = {e["sha"] for e in out}
    for e in out:
        e["user_parents"] = [p for p in e["parents"] if p not in ours]   # links into the user's own history
    return out


# --------------------------------------------------------------------------------------
# restore: write files, never checkout
# --------------------------------------------------------------------------------------
def tree_entries(repo: Path, tree: str) -> dict[str, tuple[str, str]]:
    out = {}
    for line in git(["ls-tree", "-r", "-z", tree], repo).split("\0"):
        if not line:
            continue
        meta, path = line.split("\t", 1)
        mode, _type, sha = meta.split()
        out[path] = (mode, sha)
    return out


def write_tree_to_worktree(repo: Path, target_tree: str, current_tree: str | None):
    target = {p: e for p, e in tree_entries(repo, target_tree).items() if not p.startswith(".timemachine/")}
    current = {p: e for p, e in tree_entries(repo, current_tree).items() if not p.startswith(".timemachine/")} if current_tree else {}
    written = deleted = 0
    for path, (mode, sha) in target.items():
        if current.get(path) == (mode, sha):
            continue
        dest = repo / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = git_bytes(["cat-file", "blob", sha], repo)
        tmp = dest.with_name(f".{dest.name}.tm-tmp")
        tmp.write_bytes(data)
        tmp.chmod(0o755 if mode == "100755" else 0o644)
        os.replace(tmp, dest)              # atomic per file
        written += 1
    for path in current.keys() - target.keys():
        f = repo / path
        if f.exists():
            f.unlink()
            deleted += 1
            d = f.parent
            while d != repo and not any(d.iterdir()):
                d.rmdir()
                d = d.parent
    return written, deleted


def restore_secrets(repo: Path, sha: str, identity: Path) -> list[str]:
    entries = tree_entries(repo, sha)
    if ".timemachine/secrets.age" not in entries:
        return []
    ct = git_bytes(["cat-file", "blob", entries[".timemachine/secrets.age"][1]], repo)
    plain = subprocess.run(["age", "-d", "-i", str(identity)], input=ct, capture_output=True, check=True).stdout
    names = []
    with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
        for m in tar.getmembers():
            if not m.isfile() or m.name.startswith("/") or ".." in m.name.split("/"):
                continue
            (repo / m.name).parent.mkdir(parents=True, exist_ok=True)
            (repo / m.name).write_bytes(tar.extractfile(m).read())
            names.append(m.name)
    return names


def current_files_tree(project: Path) -> str:
    tb = TreeBuild(project)
    try:
        return tb.build_files_tree()
    finally:
        tb.cleanup()


def restore(state: State, slug: str, target: str, attempts: int = 2):
    proj = state.project(slug)
    project = Path(proj["path"])
    ref = ref_for(state, slug)
    # resolve a tm_id or a sha prefix
    idx = state.data["index"].get(slug, {})
    sha = idx.get(target) or next((s for t, s in idx.items() if t.startswith(target)), None) or ref_sha(project, target)
    if not sha:
        die(f"unknown checkpoint {target}")
    target_tr = trailers(project, sha)

    print("  1) saving the current state first")
    pre = checkpoint(state, slug, "before restore", ack=True, quiet=True) or ref_sha(project, ref)
    pre_tr = trailers(project, pre)

    for attempt in range(1, attempts + 1):
        print(f"  2) writing files from {target_tr.get('TM-Id', sha[:10])} (attempt {attempt})")
        w, d = write_tree_to_worktree(project, sha, pre)
        envs = restore_secrets(project, sha, state.identity_file())
        print(f"     wrote {w}, deleted {d}, restored env files: {envs or 'none'}")
        print("  3) verifying the working tree matches the checkpoint")
        if current_files_tree(project) == target_tr["TM-Tree"]:
            print("     OK")
            break
        print("     MISMATCH: something changed the folder while restoring (an agent still running?)")
        if attempt == attempts:
            print("  4) giving up: re-applying the pre-restore state")
            write_tree_to_worktree(project, pre, None)
            restore_secrets(project, pre, state.identity_file())
            if current_files_tree(project) == pre_tr["TM-Tree"]:
                print("     folder is back to how it was. Close the agent and try again.")
            else:
                print("     could not settle the folder. Both states are still in the timeline; nothing is lost.")
            return
    print("  4) recording the restore as a new checkpoint")
    checkpoint(state, slug, f"restored to {target_tr.get('TM-Id', sha[:10])}", ack=True)


# --------------------------------------------------------------------------------------
# thinning: rewrite OUR chain (same trees, new parents), then force-update OUR ref
# --------------------------------------------------------------------------------------
def keep_set(entries: list[dict], now: dt.datetime, free: bool) -> set[str]:
    keep, buckets = set(), set()
    for e in entries:
        t = dt.datetime.fromisoformat(e["date"])
        age = now - t
        if age <= dt.timedelta(hours=24):
            key = ("all", e["sha"])
        elif age <= dt.timedelta(days=7):
            key = ("hour", t.strftime("%Y-%m-%d %H"))
        elif age <= dt.timedelta(days=30):
            key = ("day", t.strftime("%Y-%m-%d"))
        elif free:
            continue
        else:
            key = ("week", t.strftime("%G-%V"))
        if key in buckets:
            continue            # entries are oldest-first; the first in a bucket is kept
        buckets.add(key)
        keep.add(e["sha"])
    keep.add(entries[-1]["sha"])   # newest always survives
    return keep


def thin(state: State, slug: str, free: bool, now: dt.datetime | None = None):
    proj = state.project(slug)
    project = Path(proj["path"])
    ref = ref_for(state, slug)
    entries = chain(project, ref)
    if not entries:
        print("  nothing to thin")
        return
    now = now or dt.datetime.now(dt.timezone.utc)
    keep = keep_set(entries, now, free)
    old_tip = entries[-1]["sha"]
    new_prev = None
    remap = {}
    for e in entries:
        if e["sha"] not in keep:
            continue
        tree = git(["rev-parse", f"{e['sha']}^{{tree}}"], project).strip()
        body = git(["log", "-1", "--format=%B", e["sha"]], project)
        dates = git(["log", "-1", "--format=%aI%x1f%cI%x1f%an%x1f%ae", e["sha"]], project).strip().split("\x1f")
        parents = []
        if new_prev:
            parents += ["-p", new_prev]
        for p in e["user_parents"]:       # keep links into the user's history (sole parent on the first checkpoint, second parent later)
            parents += ["-p", p]
        env = {"GIT_AUTHOR_DATE": dates[0], "GIT_COMMITTER_DATE": dates[1],
               "GIT_AUTHOR_NAME": dates[2], "GIT_AUTHOR_EMAIL": dates[3],
               "GIT_COMMITTER_NAME": dates[2], "GIT_COMMITTER_EMAIL": dates[3]}
        new_sha = git(["commit-tree", tree, *parents, "-m", body], project, env=env).strip()
        remap[e["sha"]] = new_sha
        new_prev = new_sha
    git(["update-ref", ref, new_prev, old_tip], project)     # force on OUR ref only
    # stable ids: the index now points at the rewritten shas
    idx = state.data["index"].setdefault(slug, {})
    for e in entries:
        if e["tm_id"] in idx:
            if e["sha"] in remap:
                idx[e["tm_id"]] = remap[e["sha"]]
            else:
                idx.pop(e["tm_id"], None)
    state.save()
    print(f"  kept {len(keep)} of {len(entries)} checkpoints; ref rewritten {old_tip[:10]} -> {new_prev[:10]}")


# --------------------------------------------------------------------------------------
# push: only our namespace, force allowed there
# --------------------------------------------------------------------------------------
def push(state: State, slug: str):
    proj = state.project(slug)
    project = Path(proj["path"])
    remote = proj.get("remote")
    if not remote:
        die("no backup remote. Run: tm.py track <path> --remote <url>")
    ref = ref_for(state, slug)
    if not ref_sha(project, ref):
        die("nothing to push yet")
    out = git(["push", "--porcelain", remote, f"+{ref}:{ref}"], project)
    print("  " + out.strip().replace("\n", "\n  "))


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", default=os.path.expanduser("~/.timemachine"), help="state dir (stands in for SQLite + Keychain)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("discover", help="find project folders from Claude Code and Cursor");  s.add_argument("--home", default=os.path.expanduser("~")); s.add_argument("--json", action="store_true")
    s = sub.add_parser("track", help="register a project (and its backup remote)");          s.add_argument("path"); s.add_argument("--remote"); s.add_argument("--slug")
    s = sub.add_parser("scan", help="secret scan only");                                      s.add_argument("slug")
    s = sub.add_parser("checkpoint", help="create a checkpoint");                             s.add_argument("slug"); s.add_argument("-m", "--message"); s.add_argument("--ack", action="store_true"); s.add_argument("--at", help="fake timestamp (testing)")
    s = sub.add_parser("list", help="show the chain");                                        s.add_argument("slug")
    s = sub.add_parser("push", help="push our ref to the backup remote");                     s.add_argument("slug")
    s = sub.add_parser("restore", help="restore files from a checkpoint");                    s.add_argument("slug"); s.add_argument("target")
    s = sub.add_parser("thin", help="apply the retention policy");                            s.add_argument("slug"); s.add_argument("--free", action="store_true"); s.add_argument("--now")
    s = sub.add_parser("status", help="what the dashboard would show");                       s.add_argument("slug")
    a = ap.parse_args()

    state = State(Path(a.state))

    if a.cmd == "discover":
        res = discover(Path(a.home))
        if a.json:
            print(json.dumps(res, indent=1, ensure_ascii=False))
        else:
            for r in res:
                flag = "[x]" if r["active"] else "[ ]"
                extra = []
                if r["nested"]:
                    extra.append(f"contains {len(r['nested'])} nested: {', '.join(r['nested'])}")
                if r["in_downloads"]:
                    extra.append("in Downloads: suggest moving to ~/Projects")
                if not r["has_git"]:
                    extra.append("no git")
                print(f"{flag} {r['last_active']}  {Path(r['path']).name:28} {','.join(r['sources']):20} {'; '.join(extra)}")
        return

    if a.cmd == "track":
        p = Path(a.path).resolve()
        if not p.is_dir():
            die(f"not a directory: {p}")
        slug = a.slug or slugify(p.name)
        state.data["projects"][slug] = {"path": str(p), "remote": a.remote}
        state.save()
        if a.remote:
            ensure_repo(p)
            existing = subprocess.run(["git", "remote", "get-url", "timemachine"], cwd=p, capture_output=True, text=True)
            if existing.returncode == 0:
                git(["remote", "set-url", "timemachine", a.remote], p)
            else:
                git(["remote", "add", "timemachine", a.remote], p)   # never touches 'origin'
            state.data["projects"][slug]["remote"] = "timemachine"
            state.save()
        print(f"tracking {slug} -> {p}")
        return

    slug = a.slug
    proj = state.project(slug)
    project = Path(proj["path"])
    print(f"[{slug}] {project}")

    if a.cmd == "scan":
        tb = TreeBuild(project)
        try:
            tb.build_files_tree()
            findings = scan_worktree(project, tb.files) + scan_history(project)
        finally:
            tb.cleanup()
        acked = set(state.data["acks"].get(slug, []))
        for f in findings:
            print(f"  [{f.severity:6}] {f.rule:22} {f.where}  {f.sample}  {f.note}")
        print(f"  verdict: {verdict(findings, acked).upper()}")
    elif a.cmd == "checkpoint":
        checkpoint(state, slug, a.message, a.ack, a.at)
    elif a.cmd == "list":
        for e in chain(project, ref_for(state, slug)):
            second = f"  (+ user commit {e['user_parents'][0][:8]})" if e["user_parents"] else ""
            print(f"  {e['tm_id']:12} {e['sha'][:10]} {e['date']}  {e['subject']}{second}")
    elif a.cmd == "push":
        push(state, slug)
    elif a.cmd == "restore":
        restore(state, slug, a.target)
    elif a.cmd == "thin":
        now = dt.datetime.fromisoformat(a.now) if a.now else None
        thin(state, slug, a.free, now)
    elif a.cmd == "status":
        ref = ref_for(state, slug)
        entries = chain(project, ref)
        tip = entries[-1] if entries else None
        local_tree = current_files_tree(project)
        pushed = None
        if proj.get("remote"):
            r = subprocess.run(["git", "ls-remote", proj["remote"], ref], cwd=project, capture_output=True, text=True)
            pushed = r.stdout.split()[0] if r.stdout.strip() else None
        print(f"  ref:            {ref}")
        print(f"  checkpoints:    {len(entries)}")
        print(f"  last:           {tip['date'] + '  ' + tip['subject'] if tip else '-'}")
        print(f"  unsaved changes:{'no' if tip and tip['files_tree'] == local_tree else 'yes'}")
        print(f"  pushed:         {'yes' if pushed and tip and pushed == tip['sha'] else ('behind' if pushed else 'never')}")
        print(f"  user HEAD:      {head_sha(project) or 'unborn (we never created a commit on main)'}")


if __name__ == "__main__":
    main()
