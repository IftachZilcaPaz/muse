/**
 * Builds the two messy sample projects and a fake home directory, the same shapes as
 * prototype/make_samples.sh. All "secrets" are fabricated strings that match scanner patterns.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Git } from "../src/engine/git.js";
import { cursorStorageDir } from "../src/engine/discovery.js";

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const HDR = b64url('{"alg":"HS256","typ":"JWT"}');
const SIG = b64url(randomBytes(32));
export const ANON_JWT = `${HDR}.${b64url('{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"anon","iat":1700000000,"exp":2000000000}')}.${SIG}`;
export const SVC_JWT = `${HDR}.${b64url('{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"service_role","iat":1700000000,"exp":2000000000}')}.${SIG}`;

export interface Samples {
  home: string;
  noaLanding: string;
  recipesBot: string;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function write(file: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function touch(p: string, when: Date) {
  await fs.utimes(p, when, when);
}

export async function buildSamples(root: string): Promise<Samples> {
  await fs.rm(root, { recursive: true, force: true });
  const home = path.join(root, "home");
  const A = path.join(home, "Downloads", "noa-landing");
  const B = path.join(home, "development", "recipes-bot");
  const git = new Git();

  // ---- A: noa-landing (no git, keys in code, junk, 55MB asset) ----
  await write(path.join(A, "package.json"), JSON.stringify({ name: "noa-landing", private: true, type: "module", dependencies: { react: "^18.3.1" } }, null, 2));
  await write(path.join(A, "index.html"), '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n');
  await write(path.join(A, "src/main.jsx"), "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\ncreateRoot(document.getElementById('root')).render(<App />)\n");
  await write(path.join(A, "src/App.jsx"), "export default function App() {\n  return <main><h1>Noa's landing page</h1><p>Sign up below</p></main>\n}\n");
  await write(path.join(A, "src/lib/supabase.js"), `import { createClient } from '@supabase/supabase-js'\nexport const supabase = createClient(\n  'https://abcdefghijklmnopqrst.supabase.co',\n  '${ANON_JWT}'\n)\n`);
  await write(
    path.join(A, "src/config.js"),
    "// TODO move to env\nexport const STRIPE_SECRET = 'sk_test_51FAKEfakefakefakefakefakefakeFAKE0000000000'\nexport const STRIPE_PUBLISHABLE = 'pk_test_51FAKEfakefakefakefakefakefakeFAKE0000000000'\nexport const MAPS = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK'\n",
  );
  await write(path.join(A, ".env"), `VITE_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nVITE_SUPABASE_ANON_KEY=${ANON_JWT}\nOPENAI_API_KEY=sk-proj-FAKEfakefakefakefakefakefakefakefakefakefakeFAKE\n`);
  await write(path.join(A, ".env.local"), "RESEND_API_KEY=re_FAKEfakefakefakefakefakefake\n");
  await write(path.join(A, "node_modules/react/index.js"), "console.log('fake react')\n");
  await write(path.join(A, "node_modules/.vite/deps.json"), '{"hash":"deadbeef"}\n');
  await write(path.join(A, "dist/assets/index-abc123.js"), randomBytes(200_000));
  await write(path.join(A, "public/logo.png"), randomBytes(4096));
  await write(path.join(A, ".DS_Store"), "");
  await write(path.join(A, "assets/hero-video.mp4"), Buffer.alloc(55 * 1024 * 1024));

  // ---- B: recipes-bot (messy git: .env committed once, dirty tree, service_role in code) ----
  await write(path.join(B, "pyproject.toml"), '[project]\nname = "recipes-bot"\nversion = "0.1.0"\n');
  await write(path.join(B, "requirements.txt"), "python-telegram-bot>=21\nopenai>=1.40\n");
  await write(path.join(B, "bot.py"), 'import os\nfrom telegram.ext import Application\n\nTOKEN = os.environ["TELEGRAM_TOKEN"]\n\ndef main():\n    app = Application.builder().token(TOKEN).build()\n    app.run_polling()\n\nif __name__ == "__main__":\n    main()\n');
  await write(path.join(B, ".env"), `TELEGRAM_TOKEN=123456789:FAKEfakefakefakefakefakefakefakefak\nSUPABASE_SERVICE_ROLE=${SVC_JWT}\n`);
  await write(path.join(B, ".venv/lib/site.py"), "fake venv\n");
  await write(path.join(B, "__pycache__/bot.cpython-313.pyc"), "cache\n");
  await write(path.join(B, "dev.db"), randomBytes(2048));
  const userEnv = { GIT_AUTHOR_NAME: "Noa", GIT_AUTHOR_EMAIL: "noa@example.com", GIT_COMMITTER_NAME: "Noa", GIT_COMMITTER_EMAIL: "noa@example.com" };
  await git.run(["init", "-q", "-b", "main"], { cwd: B });
  await git.run(["add", "pyproject.toml", "requirements.txt", "bot.py", ".env"], { cwd: B });
  await git.run(["commit", "-q", "-m", "first version"], { cwd: B, env: { ...userEnv, GIT_AUTHOR_DATE: "2026-09-01T10:00:00+02:00", GIT_COMMITTER_DATE: "2026-09-01T10:00:00+02:00" } });
  await git.run(["rm", "-q", "--cached", ".env"], { cwd: B });
  await write(path.join(B, ".gitignore"), ".env\n");
  await git.run(["add", ".gitignore"], { cwd: B });
  await git.run(["commit", "-q", "-m", "oops, remove env"], { cwd: B, env: { ...userEnv, GIT_AUTHOR_DATE: "2026-09-02T10:00:00+02:00", GIT_COMMITTER_DATE: "2026-09-02T10:00:00+02:00" } });
  await fs.appendFile(path.join(B, "bot.py"), `\n# quick hack for the admin script, remove later\nADMIN_KEY = "${SVC_JWT}"\n`);
  await write(path.join(B, "notes.md"), "# TODO\n- add /random command\n- deploy somewhere\n");

  // ---- fake home: Claude Code and Cursor path lists, plus noise ----
  const untitled = path.join(home, "Downloads", "untitled folder 12");
  const flights = path.join(home, "Desktop", "xcode_tests", "flights&hotels");
  const scratch = path.join(home, "Library", "Application Support", "Claude", "scratch-workspaces", "x", "y", "scratch-1");
  await write(path.join(untitled, "index.html"), "<html></html>\n");
  await write(path.join(flights, "index.html"), "<html></html>\n");
  await fs.mkdir(scratch, { recursive: true });
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.mkdir(path.join(B, "scripts"), { recursive: true });
  // "Desktop & Documents" iCloud sync is on: Desktop is mirrored into iCloud
  await fs.mkdir(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Desktop"), { recursive: true });

  const session = async (p: string, days: number) => {
    const d = path.join(home, ".claude", "projects", p.replace(/\//g, "-"));
    await write(path.join(d, "session.jsonl"), JSON.stringify({ cwd: p }) + "\n");
    await touch(path.join(d, "session.jsonl"), daysAgo(days));
    await touch(d, daysAgo(days));
  };
  await session(A, 3);
  await session(B, 10);
  await session(path.join(B, "scripts"), 12);
  await session(untitled, 200);
  await session(home, 1);
  await session(path.join(home, ".claude"), 1);
  await session(scratch, 1);
  await write(
    path.join(home, ".claude.json"),
    JSON.stringify({ numStartups: 42, projects: Object.fromEntries([A, B, path.join(B, "scripts"), untitled, home, path.join(home, ".claude"), scratch].map((p) => [p, { allowedTools: [] }])) }, null, 1),
  );
  const ws = async (p: string, days: number, id: string) => {
    const d = path.join(cursorStorageDir(home), id);
    await write(path.join(d, "workspace.json"), JSON.stringify({ folder: "file://" + encodeURI(p).replace(/&/g, "%26") }));
    await touch(path.join(d, "workspace.json"), daysAgo(days));
    await touch(d, daysAgo(days));
  };
  await ws(B, 5, "aaaa1111");
  await ws(flights, 120, "bbbb2222");

  await touch(A, daysAgo(3));
  await touch(B, daysAgo(10));
  await touch(untitled, daysAgo(200));
  await touch(flights, daysAgo(120));

  return { home, noaLanding: A, recipesBot: B };
}
