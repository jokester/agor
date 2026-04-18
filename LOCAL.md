# LOCAL.md

Local, uncommitted modifications to this worktree. Kept to a minimum so
rebasing against upstream stays painless. Two scripts, zero Makefile diff.

## Files added

- `./agor-dev` — runs the 2-process dev stack (daemon + UI) under one
  supervisor. Ctrl-C stops both.
- `./agor` — dev-worktree wrapper around the real CLI. Auto-builds
  `@agor/core` on first run. Works from any CWD.

**Makefile:** unchanged vs. upstream. `make dev` still means
`docker compose up`. Local dev goes through `./agor-dev`, not make.

## Typical worktree flow

```
pnpm install        # once
./agor-dev          # starts daemon (:3030) + UI (:5173)

# in another shell:
./agor --help
./agor session list
```

Ctrl-C in the `agor-dev` terminal tears the whole stack down (daemon, core
tsup-watch, vite) via `concurrently --kill-others-on-fail`.

## Process tree under `./agor-dev`

Upstream's documented "2-process workflow" is 2 *terminals*, 3 Node
processes. `./agor-dev` runs all of them under one outer supervisor:

```
concurrently (outer, started by ./agor-dev)
├─ daemon  → pnpm --filter @agor/daemon dev
│           └─ concurrently (inner, from apps/agor-daemon/package.json)
│              ├─ @agor/core  tsup --watch     # packages/core/dist rebuild
│              └─ daemon      tsx watch        # FeathersJS on :$PORT
└─ ui      → pnpm --filter agor-ui dev
              └─ vite                          # HMR on :$VITE_PORT
```

So: **3 watchers** (core tsup, daemon tsx, vite) + 2 `concurrently`
supervisors. The executor, docs, CLI, etc. are *not* running — those only
show up with `pnpm dev` / `turbo run dev` and cause the TS7016 noise noted
below.

## Env vars honored by the scripts

- `PORT` — daemon port (default 3030). Read by `agor-dev` and passed through
  to the daemon. The CLI picks it up indirectly via `daemon.port` in
  `~/.agor/config.yaml`, or you can force it with `DAEMON_URL`.
- `VITE_PORT` — UI port (default 5173; upstream default). Set to e.g. 25173
  here if you want to avoid colliding with a global Agor instance also on
  5173.
- `DAEMON_URL` — absolute URL override for `./agor`. Highest priority in the
  CLI's daemon-URL resolution (`packages/core/src/config/config-manager.ts`).

Example, dev worktree on alternate ports:

```
PORT=4030 VITE_PORT=25173 ./agor-dev
DAEMON_URL=http://localhost:4030 ./agor session list
```

## Config scope

There is **no `AGOR_HOME` env override** — `getAgorHome()` is hardcoded to
`os.homedir()/.agor`. Both the dev daemon and `./agor` therefore share
`~/.agor/config.yaml` and `~/.agor/agor.db` with any global Agor install on
this machine. Only `AGOR_DATA_HOME` can be redirected, and only for git
data (`repos/`, `worktrees/`).

If you need full isolation from a global install: run the whole stack under
a different `$HOME`.

## Gotchas

### `./agor init` prints misleading "Next steps"

```
Next steps:
  1. Start the daemon: agor daemon start
  2. Open the UI: agor open
```

That's the onboarding message baked into the CLI for **global npm
install**. In a dev worktree, ignore it — `agor daemon start` would launch
a detached background daemon and bypass the watch-mode reload you want.

Instead: `./agor-dev` (or don't run `init` at all; the daemon creates
`~/.agor/` on first start).

### TS7016 "Could not find a declaration file for module '@agor/core/types'"

Only happens under `pnpm dev` / `turbo run dev` (full fan-out), not
`./agor-dev`. `@agor/executor`'s `tsc --watch` races `@agor/core`'s
`tsup --watch` during the startup window where JS exists but DTS hasn't
landed. Errors clear once tsup finishes. Avoid by sticking with
`./agor-dev`.
