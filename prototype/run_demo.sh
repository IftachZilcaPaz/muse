#!/usr/bin/env bash
# End-to-end demo of the engine on the two messy samples. Re-runnable; everything lives under $1.
# Usage: run_demo.sh <work-dir> [backup-remote-url]
#   With a remote URL, the hidden refs are pushed there (only refs/timemachine/*, never branches).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for tool in git python3 age openssl; do command -v "$tool" >/dev/null || { echo "missing: $tool (on a Mac: brew install $tool)"; exit 1; }; done
W="${1:?work dir}"
REMOTE="${2:-}"
TM="python3 $HERE/tm.py --state $W/state"
A="$W/samples/home/Downloads/noa-landing"
B="$W/samples/home/development/recipes-bot"
NOW="2026-11-05T12:00:00+00:00"

ref_of() { (cd "$1" && git for-each-ref --format='%(refname)' refs/timemachine | head -1); }
count() { $TM list "$1" | tail -n +2 | grep -c .; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
check() { if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; FAILED=1; fi; }
FAILED=0

rm -rf "$W"; mkdir -p "$W"
"$HERE/make_samples.sh" "$W/samples" >/dev/null

step "1. discover from ~/.claude.json + Cursor workspaceStorage"
$TM discover --home "$W/samples/home"
OUT=$($TM discover --home "$W/samples/home" --json)
check "home dir, dot-dirs and ~/Library filtered out"   "! grep -q 'Library\\|\"/.claude\"' <<<'$OUT'"
check "nested folder folded into its parent"             "grep -q '\"scripts\"' <<<'$OUT'"
check "Cursor URL-encoding decoded (flights&hotels)"      "grep -q 'flights&hotels' <<<'$OUT'"
check "old folders are not pre-checked"                   "python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if [x for x in d if not x[\"active\"]] else 1)' '$OUT'"

step "2. track both projects"
if [ -n "$REMOTE" ]; then
  $TM track "$A" --remote "$REMOTE"; $TM track "$B" --remote "$REMOTE"
else
  $TM track "$A"; $TM track "$B"
fi

step "3. secret policy: yellow needs --ack, red is blocked"
$TM checkpoint noa-landing && true
check "yellow (sk_test in code) blocked without --ack"    "[ -z \"\$(ref_of '$A')\" ]"
$TM checkpoint noa-landing --ack
check "first checkpoint exists after --ack"               "(cd '$A' && git for-each-ref refs/timemachine | grep -q autosave)"
TREE_FILES=$(cd "$A" && git ls-tree -r --name-only "$(ref_of "$A")")
echo "  stored files:"; sed 's#^#    #' <<<"$TREE_FILES"
check "55MB asset excluded from the tree"                 "! grep -q hero-video <<<'$TREE_FILES'"
check "node_modules/dist/.DS_Store excluded"              "! grep -qE 'node_modules|dist/|DS_Store' <<<'$TREE_FILES'"
check ".env not stored in clear, secrets.age present"     "grep -q '^.timemachine/secrets.age' <<<'$TREE_FILES' && ! grep -qx '.env' <<<'$TREE_FILES'"
check "user's HEAD still unborn (no commit on main)"      "! (cd '$A' && git rev-parse -q --verify HEAD >/dev/null 2>&1)"
$TM checkpoint recipes-bot --ack && true
check "red (service_role in code) blocked even with --ack" "! (cd '$B' && git for-each-ref refs/timemachine | grep -q autosave)"
python3 -c 'import sys,pathlib; f=pathlib.Path(sys.argv[1]); f.write_text(f.read_text().split("\n# quick hack")[0] + "\n")' "$B/bot.py"   # the user applied the fix prompt
$TM checkpoint recipes-bot --ack
check "history-only finding is yellow: checkpoint after --ack" "(cd '$B' && git for-each-ref refs/timemachine | grep -q autosave)"
check "first checkpoint links the user's HEAD as parent"  "$TM list recipes-bot | grep -q 'user commit'"
check "user's branch, index and worktree untouched"       "(cd '$B' && [ \"\$(git rev-parse main)\" = \"\$(git log --format=%H -1 main)\" ] && git status --short | grep -q '^ M bot.py')"

step "4. busy repo and no-change detection"
mkdir -p "$B/.git/rebase-merge"; $TM checkpoint recipes-bot | tail -1; rmdir "$B/.git/rebase-merge"
check "no checkpoint while a rebase is in progress"       "[ \"\$(count recipes-bot)\" = 1 ]"
$TM checkpoint noa-landing | tail -1
check "unchanged tree -> no new checkpoint"               "[ \"\$(count noa-landing)\" = 1 ]"

step "5. the disaster: agent edits, then deletes and overwrites; restore"
printf 'export default function App(){ return <h1>v2</h1> }\n' > "$A/src/App.jsx"; echo "NEW_FLAG=1" >> "$A/.env"
$TM checkpoint noa-landing --at 2026-11-05T09:00:00+00:00 | tail -2 | head -1
GOOD=$($TM list noa-landing | tail -1 | awk '{print $1}')
rm "$A/src/lib/supabase.js"; echo "// oops" > "$A/src/main.jsx"
$TM checkpoint noa-landing --at 2026-11-05T09:20:00+00:00 | tail -2 | head -1
$TM restore noa-landing "$GOOD"
check "deleted file is back"                              "[ -f '$A/src/lib/supabase.js' ]"
check "overwritten file is back"                          "grep -q createRoot '$A/src/main.jsx'"
check ".env restored from the encrypted bundle"           "grep -q NEW_FLAG '$A/.env'"
check "restore recorded as a new checkpoint"              "$TM list noa-landing | tail -1 | grep -q 'restored to'"
check "HEAD still unborn after restore (no checkout)"     "! (cd '$A' && git rev-parse -q --verify HEAD >/dev/null 2>&1)"

step "6. second parent when the user makes a real commit"
(cd "$B" && git add notes.md && git -c user.name=Noa -c user.email=noa@example.com commit -q -m "add notes")
echo "- more" >> "$B/notes.md"; $TM checkpoint recipes-bot --at 2026-09-20T10:00:00+00:00 | tail -1
check "new checkpoint carries the user's commit as 2nd parent" "$TM list recipes-bot | tail -1 | grep -q 'user commit'"

step "7. retention thinning on a 36-checkpoint fake history"
python3 - "$B" "$W/state" "$HERE" <<'EOF'
import subprocess, datetime as dt, sys, pathlib
B, state, here = sys.argv[1:4]
now = dt.datetime(2026,11,5,12,0,tzinfo=dt.timezone.utc)
s = [now - dt.timedelta(days=d) for d in (80, 60, 45, 35)]
s += [now - dt.timedelta(days=d, hours=h) for d in (25, 20, 15, 10, 9, 8) for h in (1, 5)]
s += [now - dt.timedelta(days=d, minutes=m) for d in (6, 4, 2) for m in (0, 20, 40, 90)]
s += [now - dt.timedelta(hours=h, minutes=m) for h in (20, 10, 3, 1) for m in (0, 15)]
for i, t in enumerate(sorted(s)):
    pathlib.Path(B, "notes.md").write_text(f"# TODO\n- step {i}\n")
    subprocess.run(["python3", f"{here}/tm.py", "--state", state, "checkpoint", "recipes-bot", "--at", t.isoformat()], capture_output=True, check=True)
EOF
BEFORE=$(count recipes-bot); LINKS=$($TM list recipes-bot | grep -c 'user commit')
TIPTREE=$(cd "$B" && git rev-parse "$(ref_of "$B")^{tree}")
$TM thin recipes-bot --now "$NOW"
AFTER=$(count recipes-bot)
echo "  kept per policy: $BEFORE -> $AFTER"
check "newest checkpoint and its tree survive"            "[ \"\$(cd '$B' && git rev-parse \"\$(ref_of '$B')^{tree}\")\" = '$TIPTREE' ]"
check "links to the user's commits survive the rewrite"   "[ \"\$($TM list recipes-bot | grep -c 'user commit')\" = '$LINKS' ]"
check "one per hour in days 2-7"                          "[ \"\$($TM list recipes-bot | grep -c '2026-11-03T1[012]')\" = 3 ]"
check "one per day in days 8-30"                          "[ \"\$($TM list recipes-bot | grep -c '2026-10-2[678]')\" = 3 ]"
check "weekly beyond 30 days (Pro)"                       "$TM list recipes-bot | grep -q '2026-09-06'"
$TM thin recipes-bot --free --now "$NOW"
check "Free policy drops > 30 days"                       "! $TM list recipes-bot | grep -q '2026-08-17'"
check "stable ids remapped to new shas"                   "python3 -c 'import json,sys; d=json.load(open(\"$W/state/state.json\"))[\"index\"][\"recipes-bot\"]; sys.exit(0 if len(d)>5 else 1)'"
check "user's main untouched by thinning"                 "(cd '$B' && git log --format=%s main | head -1 | grep -q 'add notes')"

step "8. new machine: fetch the hidden ref into an empty repo and restore with the RECOVERY key only"
N="$W/new-machine/noa-landing"; mkdir -p "$N"; (cd "$N" && git init -q -b main && git fetch -q "$A" '+refs/timemachine/*:refs/timemachine/*')
REF=$(cd "$N" && git for-each-ref --format='%(refname)' refs/timemachine | head -1)
BLOB=$(cd "$N" && git ls-tree "$REF" .timemachine/secrets.age | awk '{print $3}')
(cd "$N" && git cat-file blob "$BLOB" | age -d -i "$W/state/recovery.key" | tar -x -C "$N")
check "secrets.age decrypts with the recovery key alone"  "grep -q NEW_FLAG '$N/.env'"
# simulate the same identity on a fresh disk: track the new folder under the same slug, then restore
$TM track "$N" --slug noa-landing >/dev/null
TIP=$(cd "$N" && git rev-parse "$REF")
$TM restore noa-landing "$TIP" | tail -2
check "working tree rebuilt on the new machine"           "[ -f '$N/src/lib/supabase.js' ] && [ -f '$N/package.json' ]"

if [ -n "$REMOTE" ]; then
  step "9. push hidden refs to the backup remote"
  $TM track "$A" --slug noa-landing --remote "$REMOTE" >/dev/null
  $TM push noa-landing; $TM push recipes-bot
  git ls-remote "$REMOTE" | grep -E 'refs/(heads|timemachine)' | sed 's#^#  #'
fi

echo; [ "$FAILED" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
