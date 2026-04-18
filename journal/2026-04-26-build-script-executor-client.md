# 2026-04-26 — Add executor and client to ./agor* build scripts

## Problem

`./agor-daemon` was failing at runtime with:

```
ERROR: Could not load executor CLI
ERR_MODULE_NOT_FOUND: Cannot find module '/home/mono/oss/agor/packages/executor/src/commands/index.js'
```

The executor's `dist/` was never built before the daemon tried to spawn it.
`scripts/_build-lib.sh` had `ensure_executor_built` missing entirely, and
`ensure_client_built` was defined but never called by `agor-daemon`.

## Root Cause

The `./agor*` dev scripts were added/updated incrementally and fell out of
sync with the Docker entrypoint (`docker/docker-entrypoint.sh`), which is the
canonical reference for what needs to be built before the stack starts:

```
core → executor → client → (daemon/UI)
```

`_build-lib.sh` had helpers for core, client, and daemon — but not executor.
And none of the three scripts called the full sequence.

## Fix

**`scripts/_build-lib.sh`** — added `ensure_executor_built`:

```bash
ensure_executor_built() {
  _agor_build_if_stale "@agor/executor" \
    "/tmp/agor-executor-build.lock" \
    "$REPO_ROOT/packages/executor/dist/cli.js" \
    "$REPO_ROOT/packages/executor/src" \
    pnpm --filter @agor/executor build
}
```

Sentinel is `dist/cli.js` — the file the bin script checks for. Build command
is plain `pnpm build` (`tsc`). No batched DTS trick needed: executor is a
single-output `tsc` package, not a tsup library with 40 entry points.

**All three `./agor*` scripts** updated to run the full sequence:

| Script | Before | After |
|--------|--------|-------|
| `./agor` | core | core → executor → client |
| `./agor-daemon` | core → daemon | core → executor → client → daemon |
| `./agor-ui` | client | core → executor → client |

## Why the full sequence in every script

Each script may be the first one invoked (e.g. user runs `./agor-ui` without
having run `./agor-daemon` first). The `_agor_build_if_stale` flock ensures
concurrent invocations don't double-build — whichever process wins the lock
does the work, the other waits and then skips (sentinel already present).
Cost of a no-op staleness check is negligible.

## Reference

- Docker entrypoint (canonical build order): `docker/docker-entrypoint.sh`
- Memory-efficient core build: `journal/2026-04-25-core-batched-dts-build.md`
- Build helpers: `scripts/_build-lib.sh`
