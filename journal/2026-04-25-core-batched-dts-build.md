# 2026-04-25 — Batched DTS Build for @agor/core

## Problem

`@agor/core` has ~40 entry points and generates declaration files for all of them
in a single tsup invocation. On pinkiepie (Raspberry Pi, limited RAM) the tsc
language service OOM-killed the build. The existing workaround was
`NODE_OPTIONS='--max-old-space-size=4096'` in the dev script — not a real fix,
just a raised ceiling.

## Root Cause

tsup's `dts: true` mode runs tsc internally to produce `.d.ts` files. With many
entry points, tsc loads a language service for all of them at once, causing a
large peak allocation. The JS bundling step (esbuild) has no such problem — it's
fast and uses very little memory — but the two steps were coupled in the same
tsup invocation.

## Fix: Two-Pass Build with Chunked DTS

Technique sourced from a workaround in the tsup GitHub repo.

### `packages/core/build.ts`

A standalone script that splits the build into two sequential passes:

**Pass 1 — JS only (esbuild)**

```
build({ dts: false, format: ['cjs', 'esm'], ... })
```

esbuild compiles all 40+ entries in one shot. No type resolution, negligible
memory. Copies drizzle migrations and the system prompt template to `dist/`
when done.

**Pass 2 — DTS in batches (tsc)**

```
for each batch of DTS_BATCH_SIZE entries:
  build({ dts: { only: true }, entry: batch })
```

Each `build()` call starts and completes a fresh tsc language service for only
`DTS_BATCH_SIZE` entries, then the process moves on. Because the loop is
sequential (`for...of` + `await`), the previous service is GC'd before the next
batch begins. Peak memory is bounded by the batch size, not the total entry count.

**Tuning**

```ts
const DTS_BATCH_SIZE = 10  // ← top of build.ts, easy to find
```

Lower = less peak memory, more tsc passes. Start at 10; halve if OOM persists,
double if builds feel slow and memory is available.

**Why `clean: false` on all `build()` calls**

`clean: true` wipes `dist/` before each build call. With multiple calls, pass 2
would delete pass 1's JS output. Instead, the script calls `rm('dist', ...)` once
at the top, then all `build()` calls use `clean: false`.

**Why `package.json` is unchanged**

`"build": "tsup"` remains as-is. `build.ts` is only wired into our own dev
scripts, not the package's published interface.

### `scripts/_build-lib.sh`

`ensure_core_built` updated from:

```bash
pnpm --filter @agor/core build
```

to:

```bash
pnpm --filter @agor/core exec tsx build.ts
```

`pnpm exec` resolves `tsx` from the package's own `node_modules`, so no PATH
dependency. The script runs in the package directory, where `build.ts` lives.

## Lessons

- Separate the esbuild pass (fast, cheap) from the tsc pass (slow, memory-hungry)
  when a package has many entry points.
- Sequential batching is the key: parallel `build()` calls would reproduce the
  original OOM since all language services would be live simultaneously.
- Avoid `clean: true` when running multiple `build()` calls — manage the initial
  clean manually instead.
- Don't touch `package.json` build scripts when the change is only relevant to
  the local dev toolchain.
