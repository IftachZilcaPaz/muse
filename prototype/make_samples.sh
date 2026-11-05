#!/usr/bin/env bash
# Generates two deliberately messy sample projects plus a fake "home" directory
# that mimics what ~/.claude.json and Cursor's workspaceStorage look like on a Mac.
#
# Usage: make_samples.sh <target-dir>
# Result:
#   <target-dir>/home/                      fake $HOME (for `tm.py discover --home`)
#   <target-dir>/home/Downloads/noa-landing  Vite+React app, no git, hardcoded keys, .env, junk
#   <target-dir>/home/development/recipes-bot Python bot, messy git, secret in history, dirty tree
#
# All "secrets" below are fabricated strings that match scanner patterns but are not real keys.
set -euo pipefail

ROOT="${1:?target dir}"
HOME_DIR="$ROOT/home"
rm -rf "$ROOT"
mkdir -p "$HOME_DIR"

# ---------- fake Supabase JWTs (header.payload.signature, payload carries the role) ----------
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
HDR=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
ANON=$(printf '{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"anon","iat":1700000000,"exp":2000000000}' | b64url)
SVC=$(printf '{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"service_role","iat":1700000000,"exp":2000000000}' | b64url)
SIG=$(head -c 32 /dev/urandom | b64url)
ANON_JWT="$HDR.$ANON.$SIG"
SVC_JWT="$HDR.$SVC.$SIG"

# =====================================================================================
# Project A: noa-landing  (persona: no git at all, keys in code, everything in Downloads)
# =====================================================================================
A="$HOME_DIR/Downloads/noa-landing"
mkdir -p "$A/src/lib" "$A/public" "$A/node_modules/react" "$A/node_modules/.vite" "$A/dist/assets" "$A/assets"

cat > "$A/package.json" <<'EOF'
{
  "name": "noa-landing",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "@supabase/supabase-js": "^2.45.0" },
  "devDependencies": { "vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.1" }
}
EOF
cat > "$A/index.html" <<'EOF'
<!doctype html>
<html><head><meta charset="utf-8"><title>Noa Landing</title></head>
<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>
EOF
cat > "$A/src/main.jsx" <<'EOF'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<App />)
EOF
cat > "$A/src/App.jsx" <<'EOF'
import { supabase } from './lib/supabase.js'
export default function App() {
  return <main><h1>Noa's landing page</h1><p>Sign up below</p></main>
}
EOF
# Public key in code: allowed (anon role) -> should be GREEN
cat > "$A/src/lib/supabase.js" <<EOF
import { createClient } from '@supabase/supabase-js'
export const supabase = createClient(
  'https://abcdefghijklmnopqrst.supabase.co',
  '$ANON_JWT'
)
EOF
# Secret test key in code: YELLOW in a private backup (warn + explicit ack)
cat > "$A/src/config.js" <<'EOF'
// TODO move to env
export const STRIPE_SECRET = 'sk_test_51FAKEfakefakefakefakefakefakeFAKE0000000000'
export const STRIPE_PUBLISHABLE = 'pk_test_51FAKEfakefakefakefakefakefakeFAKE0000000000'
export const MAPS = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK'
EOF
cat > "$A/.env" <<EOF
VITE_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co
VITE_SUPABASE_ANON_KEY=$ANON_JWT
OPENAI_API_KEY=sk-proj-FAKEfakefakefakefakefakefakefakefakefakefakeFAKE
EOF
cat > "$A/.env.local" <<'EOF'
RESEND_API_KEY=re_FAKEfakefakefakefakefakefake
EOF
echo "console.log('fake react')" > "$A/node_modules/react/index.js"
echo '{"hash":"deadbeef"}' > "$A/node_modules/.vite/deps.json"
head -c 200000 /dev/urandom > "$A/dist/assets/index-abc123.js"
head -c 4096 /dev/urandom > "$A/public/logo.png"
touch "$A/.DS_Store"
# Oversized asset (55 MB): must be excluded by the size guard with a notice
dd if=/dev/zero of="$A/assets/hero-video.mp4" bs=1M count=55 status=none

# =====================================================================================
# Project B: recipes-bot  (persona #2: git exists but messy; .env was committed once)
# =====================================================================================
B="$HOME_DIR/development/recipes-bot"
mkdir -p "$B/.venv/lib" "$B/__pycache__"
cat > "$B/pyproject.toml" <<'EOF'
[project]
name = "recipes-bot"
version = "0.1.0"
dependencies = ["python-telegram-bot>=21", "openai>=1.40", "supabase>=2.5"]
EOF
cat > "$B/requirements.txt" <<'EOF'
python-telegram-bot>=21
openai>=1.40
supabase>=2.5
EOF
cat > "$B/bot.py" <<'EOF'
import os
from telegram.ext import Application

TOKEN = os.environ["TELEGRAM_TOKEN"]

def main():
    app = Application.builder().token(TOKEN).build()
    app.run_polling()

if __name__ == "__main__":
    main()
EOF
cat > "$B/.env" <<EOF
TELEGRAM_TOKEN=123456789:FAKEfakefakefakefakefakefakefakefak
SUPABASE_SERVICE_ROLE=$SVC_JWT
EOF
echo "fake venv" > "$B/.venv/lib/site.py"
echo "cache" > "$B/__pycache__/bot.cpython-313.pyc"
python3 - "$B/dev.db" <<'EOF'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("create table recipes(id integer primary key, name text)")
c.execute("insert into recipes(name) values ('shakshuka')"); c.commit()
EOF

# messy git history: commit 1 includes .env (secret in history), commit 2 is normal,
# then a dirty working tree (modified bot.py + untracked file)
(
  cd "$B"
  git init -q -b main
  git config user.name "Noa"; git config user.email "noa@example.com"
  git add pyproject.toml requirements.txt bot.py .env
  GIT_AUTHOR_DATE="2026-09-01T10:00:00+02:00" GIT_COMMITTER_DATE="2026-09-01T10:00:00+02:00" git commit -q -m "first version"
  git rm -q --cached .env
  printf '.env\n' > .gitignore
  git add .gitignore
  GIT_AUTHOR_DATE="2026-09-02T10:00:00+02:00" GIT_COMMITTER_DATE="2026-09-02T10:00:00+02:00" git commit -q -m "oops, remove env"
)
# hardcoded service_role key in code: RED (blocked until fixed)
cat >> "$B/bot.py" <<EOF

# quick hack for the admin script, remove later
ADMIN_KEY = "$SVC_JWT"
EOF
cat > "$B/notes.md" <<'EOF'
# TODO
- add /random command
- deploy somewhere
EOF

# =====================================================================================
# Fake home: what ~/.claude.json and Cursor's workspaceStorage look like
# =====================================================================================
mkdir -p "$HOME_DIR/Desktop/xcode_tests/flights&hotels"; touch "$HOME_DIR/Desktop/xcode_tests/flights&hotels/index.html"
mkdir -p "$HOME_DIR/.claude/projects" "$HOME_DIR/Library/Application Support/Claude/scratch-workspaces/x/y/scratch-1"
mkdir -p "$HOME_DIR/Library/Application Support/Cursor/User/workspaceStorage"
mkdir -p "$HOME_DIR/Downloads/untitled folder 12" "$HOME_DIR/development/recipes-bot/scripts"
touch "$HOME_DIR/Downloads/untitled folder 12/index.html"

enc() { printf '%s' "$1" | sed 's#/#-#g'; }           # Claude Code's lossy path encoding
mk_session() { local p="$1" when="$2"; local d="$HOME_DIR/.claude/projects/$(enc "$p")"; mkdir -p "$d"; printf '{"cwd":"%s"}\n' "$p" > "$d/session.jsonl"; touch -d "$when" "$d/session.jsonl" "$d"; }

touch -d "3 days ago" "$A"; touch -d "10 days ago" "$B"; touch -d "200 days ago" "$HOME_DIR/Downloads/untitled folder 12"; touch -d "120 days ago" "$HOME_DIR/Desktop/xcode_tests/flights&hotels" 2>/dev/null || true
mk_session "$HOME_DIR/Downloads/noa-landing"                "3 days ago"
mk_session "$HOME_DIR/development/recipes-bot"              "10 days ago"
mk_session "$HOME_DIR/development/recipes-bot/scripts"      "12 days ago"     # nested
mk_session "$HOME_DIR/Downloads/untitled folder 12"         "200 days ago"    # old
mk_session "$HOME_DIR"                                      "1 day ago"       # noise: home itself
mk_session "$HOME_DIR/.claude"                              "1 day ago"       # noise: dot dir
mk_session "$HOME_DIR/Library/Application Support/Claude/scratch-workspaces/x/y/scratch-1" "1 day ago"  # noise

python3 - "$HOME_DIR" <<'EOF'
import json, sys, os
h = sys.argv[1]
paths = [f"{h}/Downloads/noa-landing", f"{h}/development/recipes-bot", f"{h}/development/recipes-bot/scripts",
         f"{h}/Downloads/untitled folder 12", h, f"{h}/.claude",
         f"{h}/Library/Application Support/Claude/scratch-workspaces/x/y/scratch-1"]
json.dump({"numStartups": 42, "projects": {p: {"allowedTools": []} for p in paths}}, open(f"{h}/.claude.json", "w"), indent=1)
EOF

# Cursor: one shared project (recipes-bot) + one Cursor-only project with '&' in its name
mk_ws() { local p="$1" when="$2" id="$3"; local d="$HOME_DIR/Library/Application Support/Cursor/User/workspaceStorage/$id"; mkdir -p "$d"
  python3 -c "import json,sys,urllib.parse;print(json.dumps({'folder':'file://'+urllib.parse.quote(sys.argv[1])}))" "$p" > "$d/workspace.json"; touch -d "$when" "$d/workspace.json" "$d"; }
mk_ws "$HOME_DIR/development/recipes-bot"              "5 days ago"   "aaaa1111"
mk_ws "$HOME_DIR/Desktop/xcode_tests/flights&hotels"   "120 days ago" "bbbb2222"

echo "samples ready under $ROOT"
echo "  A: $A"
echo "  B: $B"
