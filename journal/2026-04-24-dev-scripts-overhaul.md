# 2026-04-24 — Dev Scripts Overhaul

## Problem

`./agor-dev` failed to start on pinkiepie (Raspberry Pi, limited RAM).

Two separate failures:

**1. UI vite.config.ts import failed**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/mono/oss/agor/apps/agor-ui/node_modules/@agor-live/client/dist/config.js'
```

`@agor-live/client` is a local workspace package (`packages/client`) that ships
no pre-built `dist/`. It needed a one-time build before Vite could start.

**2. OOM killing the daemon watcher**

The daemon's dev script ran:

```
concurrently
  ├─ pnpm --filter @agor/core dev   ← tsup --watch with NODE_OPTIONS='--max-old-space-size=4096'
  └─ tsx watch src/main.ts
```

On a memory-constrained machine, tsup reserving 4 GB of heap alongside Vite and
tsx caused the OOM killer to terminate the watcher. The inner `concurrently -k`
then SIGTERM'd the surviving processes, collapsing the whole tree silently.

## Root Cause Analysis

The original `./agor-dev` was designed for a well-resourced dev workstation.
On a Pi it hit two walls:

- `@agor-live/client` had no pre-built dist (workspace package, not installed from npm)
- `tsup --watch` with a 4 GB heap reservation is incompatible with limited RAM

The fix for the first issue (add `pnpm --filter @agor-live/client build` to
`agor-dev`) revealed the second issue on the next run.

Key insight: **hot-reload of server code is not needed** for day-to-day use.
The server can be built once and run as a plain `node` process. Only the UI
benefits from a live dev server (Vite HMR).

## What We Built

Replaced `./agor-dev` with three focused scripts and a shared build library.

### `scripts/_build-lib.sh`

Shared by all three scripts. Each `ensure_*_built` function:

1. Acquires an exclusive `flock` on a `/tmp` lock file — concurrent invocations
   (e.g. starting daemon and UI in separate terminals simultaneously) wait rather
   than double-building.
2. Re-checks staleness after acquiring the lock (the first holder may have just
   finished).
3. Builds only if the sentinel `.d.ts` file is absent or any `.ts` source file
   is newer than it.

The sentinel is `.d.ts` (not `.js`) because tsup writes type declarations last.
A build interrupted during the DTS phase leaves `.js` files but no `.d.ts`,
so using `.d.ts` as the sentinel ensures a partial build triggers a retry.

```
ensure_core_built    → packages/core/dist/index.d.ts
ensure_client_built  → packages/client/dist/index.d.ts
ensure_daemon_built  → apps/agor-daemon/dist/index.d.ts
```

### `./agor-daemon`

```
ensure_core_built + ensure_daemon_built → node apps/agor-daemon/dist/main.js
```

No tsup watch. No tsx watch. One Node process. Daemon reads `PORT` and
`AGOR_CONFIG_PATH` from the environment as before.

### `./agor-ui`

```
ensure_client_built → pnpm --filter agor-ui dev --port $VITE_PORT
```

Vite still gives full HMR for UI changes.

### `./agor`

```
ensure_core_built → pnpm --filter @agor/cli run dev -- "$@"
```

CLI runs via tsx from source (`bin/dev.ts`, `development: true`) — no separate
CLI build required.

### `./agor-dev` removed

Was just a `concurrently` wrapper around daemon + UI. With two separate
terminals the logs are cleaner anyway, and Ctrl-C works per-process.

## Lessons

- Use `.d.ts` as the build sentinel when the package generates type declarations —
  it's the last artifact written and proves the build completed cleanly.
- `flock` double-check pattern: re-test staleness inside the lock, not outside.
  The script that waits for the lock should skip the build if the first holder
  already did it.
- `pnpm --filter @agor/daemon exec concurrently` as a process supervisor was
  only needed because tsup watch and tsx watch had to coexist. Once we dropped
  the watchers, `concurrently` itself became unnecessary.
