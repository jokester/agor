# 2026-04-26 — Fix static UI serving in distributed mode

## Problem

Running `./agor-ui && ./agor-daemon` (the distributed / production workflow)
left `localhost:3030/` returning **"Cannot GET /"** — the daemon was not
serving the UI static bundle even though `apps/agor-daemon/ui/` was correctly
populated by `./agor-ui`.

## Root Cause

`apps/agor-daemon/src/index.ts` gates static file serving with:

```ts
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && serveStaticFiles) { ... }
```

`./agor-daemon` previously invoked the daemon via:

```bash
exec pnpm --filter @agor/cli run dev daemon start --foreground
```

The CLI's `dev` script runs:

```bash
NODE_NO_WARNINGS=1 tsx bin/dev.ts
```

which calls:

```ts
await execute({ development: true, dir: import.meta.url });
```

oclif's `execute` with `development: true` **unconditionally** sets:

```js
process.env.NODE_ENV = 'development';
```

No guard — it overwrites whatever was in the environment. Setting
`NODE_ENV=production` in the shell before exec had no effect because oclif
reset it before the daemon code ran, making `isProduction` always `false`.

## Fix

Switch from oclif's dev entrypoint to its production entrypoint:

| | Before | After |
|---|---|---|
| Entrypoint | `tsx bin/dev.ts` via `pnpm run dev` | `node bin/run.js` directly |
| oclif mode | `development: true` | `development: false` |
| NODE_ENV | clobbered to `'development'` | preserved from shell |

`bin/run.js` uses `execute({ development: false })` so oclif never touches
`NODE_ENV`. Combined with `NODE_ENV=production` in the exec line, `isProduction`
is now `true` and the static middleware registers correctly.

**`scripts/_build-lib.sh`** — added `ensure_cli_built`:

```bash
ensure_cli_built() {
  _agor_build_if_stale "@agor/cli" \
    "/tmp/agor-cli-build.lock" \
    "$REPO_ROOT/apps/agor-cli/dist/commands/daemon/start.js" \
    "$REPO_ROOT/apps/agor-cli/src" \
    pnpm --filter @agor/cli build
}
```

`bin/run.js` (production mode) requires compiled commands in `dist/commands/`,
so the CLI must be built before exec. Sentinel is
`dist/commands/daemon/start.js` — the specific command used by both scripts.

**`./agor-daemon`** and **`./agor`** — updated exec lines and added
`ensure_cli_built` to the build sequence. `set -x` moved to just before exec
so build-phase output stays readable.

## Build sequence (after)

| Script | Sequence |
|--------|----------|
| `./agor` | core → executor → client → **cli** |
| `./agor-daemon` | core → executor → client → daemon → **cli** |
| `./agor-ui` | core → executor → client _(unchanged)_ |

## Reference

- Two entrypoints: `apps/agor-cli/bin/dev.ts` (`development: true`) vs
  `apps/agor-cli/bin/run.js` (`development: false`)
- Static serving code: `apps/agor-daemon/src/index.ts` (~line 394)
- Build helpers: `scripts/_build-lib.sh`
