# Time Machine (app)

Electron + React + TypeScript. One language for everything; the engine is plain Node and has no Electron dependency, so it runs in the app, in tests, in the CLI, and later in the MCP server.

```
src/engine/     the engine: discovery, secrets, checkpoint, restore, thin, crypto, store
src/main/       Electron main process: window + IPC handlers that call the engine
src/preload/    the narrow bridge the renderer sees (window.tm)
src/renderer/   React screens: Welcome (S1), Tools (S1b), Projects (S2), first checkpoint (S5 stand-in)
test/           vitest: the same scenario as prototype/run_demo.sh, as 14 checks
```

## Run on a Mac

```bash
cd app && npm install
```

```bash
npm run dev
```

Requirements: Node 22+, git on the PATH (a bundled git comes in week 3). `npm test` runs the engine suite in about six seconds; set `TM_TEST_REMOTE=https://github.com/<you>/<backup-repo>` to also test the push.

## Engine CLI (same commands as prototype/tm.py)

```bash
npm run engine -- discover --home ~
```

```bash
npm run engine -- track ~/Downloads/noa-landing --remote https://github.com/you/noa-landing-timemachine
npm run engine -- checkpoint noa-landing --ack
npm run engine -- list noa-landing
npm run engine -- restore noa-landing <tm-id>
npm run engine -- thin noa-landing --free
```

State lives in `~/.timemachine` for the CLI and in Electron's `userData/state` for the app (JSON for now; SQLite in week 4). Keys: `device.key`, `recovery.key` and the recovery kit text file, in the same directory, until the Keychain work in week 3.

## Week 1 status

Done: engine ported from the prototype with tests, discovery from Claude Code and Cursor path lists with tool and recency filters, nested-folder folding, iCloud and Downloads flags, screens S1, S1b, S2, and a first local checkpoint per chosen project.

Not yet: GitHub (week 3), encryption key in the Keychain (week 3), watcher and debounce (week 2), MCP mode (week 4), tray (week 5), bundled git, SQLite.
