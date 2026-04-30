# 2026-04-30 — OpenTelemetry instrumentation plan (fork-friendly)

## Goal

Add OpenTelemetry tracing + minimal metrics to the daemon so we can debug
agent execution in production. **Constraint:** we maintain a local fork that
periodically rebases onto upstream `main`, so changes must minimize conflicts
in upstream-shared files.

## Non-goals (for first pass)

- Browser-side otel in `apps/agor-ui` (bundle weight, low ROI right now).
- CLI instrumentation (`apps/agor-cli`) — short-lived, no collector to ship to.
- Logs pipeline. Stick to traces + a small set of metrics.
- Trace context propagation across the WebSocket boundary. Defer until the
  daemon-only spans prove valuable.

## Strategy: keep changes at the edges

Two principles for rebase hygiene:

1. **New files own the work.** Bootstrap, wrappers, and hook registration live
   under a new `packages/core/src/observability/` directory. Upstream never
   touches it; rebases never conflict.
2. **One-line touchpoints in upstream-shared files.** Where we _have_ to edit
   existing code, change a single import or add a single registration call.
   Avoid sprinkling `tracer.startActiveSpan(...)` inline.

Conflict budget target: **≤ 5 lines in upstream-shared files**, all in
`apps/agor-daemon/src/index.ts` / `register-services.ts`.

## Phased rollout

### Phase 1 — Bootstrap + auto-instrumentation (low risk, high coverage)

Adds HTTP, WebSocket, SQLite/Drizzle, and outbound `fetch` spans for free.

**New files:**

- `packages/core/src/observability/index.ts` — exports `initTracing()`.
- `packages/core/src/observability/tracing.ts` — `NodeSDK` setup, OTLP
  exporter, resource attributes (`service.name=agor-daemon`,
  `service.version`, `deployment.environment`).
- `packages/core/src/observability/config.ts` — read env vars
  (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, etc.) with sensible
  defaults; no-op if no endpoint configured.

**Touchpoints (upstream-shared):**

- `apps/agor-daemon/src/main.ts` — **first line** becomes
  `import '@agor/core/observability/bootstrap';` (a side-effect import that
  calls `initTracing()` before anything else loads). 1 line.
- `package.json` workspace deps — add `@opentelemetry/sdk-node`,
  `@opentelemetry/auto-instrumentations-node`,
  `@opentelemetry/exporter-trace-otlp-http`. The peer deps already pinned
  in our root `package.json` (`@opentelemetry/core`, `resources`,
  `sdk-metrics`, `sdk-trace-base`) cover most transitive constraints.

**Why side-effect import, not `NODE_OPTIONS=--require`:** the daemon launches
via `node bin/run.js` (see `2026-04-26-static-ui-serving.md`) and we don't
want to couple instrumentation to launch scripts that change.

Phase 1 alone gives us: HTTP request traces, FeathersJS REST timing, SQLite
query timing, outbound fetch (Anthropic/OpenAI/etc.) timing. Most prod
debugging questions are answerable here.

### Phase 2 — FeathersJS hook for service-level spans

**New file:** `packages/core/src/observability/feathers-hook.ts` — a global
`before`/`after`/`error` hook that opens a span per service method
(`sessions.create`, `worktrees.patch`, etc.) with attributes for
`service`, `method`, `userId`.

**Touchpoint:** `apps/agor-daemon/src/register-hooks.ts` — register the hook
globally. 1-2 lines.

This is where we get "what FeathersJS service was slow" without editing any
service file individually.

### Phase 3 — Custom spans where auto-instrumentation can't see (intrusive zone)

This is the part that risks rebase conflicts. Wrap, don't sprinkle.

**Agent SDK calls** — `packages/executor/src/sdk-handlers/{claude,codex,gemini,copilot,opencode}/`:

- Don't edit handler files. Instead, add
  `packages/core/src/observability/instrumented-sdk.ts` exporting wrapper
  functions, and change **one import line** at each handler's call site to
  pull from the wrapper. ~5 files, 1-line change each.
- Span attributes: `agent.provider`, `agent.model`, `agent.effort`,
  `tokens.input`, `tokens.output`, `tokens.cache_read`, `tokens.cache_write`.

**Session lifecycle** — `apps/agor-daemon/src/services/sessions/`:

- Use the Phase 2 FeathersJS hook for create/patch. No new touchpoints.
- For spawn/fork/subsession (where the hook isn't granular enough), add a
  wrapper around the spawn function in
  `packages/core/src/observability/instrumented-spawn.ts` and change the
  import in the one place spawn is invoked.

**Git operations** — `packages/core/src/git/index.ts`:

- This file is ours-shared with upstream and gets churn. Add an instrumented
  re-export in `packages/core/src/observability/instrumented-git.ts` that
  proxies `simple-git` calls. Migrate call sites one at a time, only where
  trace value is high (worktree create/remove, fetch, push). Each migration
  is a 1-line import change.

### Phase 4 — Metrics (small, deferred)

A handful of counters/gauges, registered in Phase 1 bootstrap so no extra
touchpoints:

- `agor.sessions.active` (gauge) — count of running sessions.
- `agor.executor.queue_depth` (gauge).
- `agor.sdk.tokens` (counter, by provider/model).
- `agor.git.worktrees.total` (gauge).

Source these from existing in-memory state; do not add new tracking just for
metrics.

## File inventory

| Type | Path | Phase | Conflict risk |
|---|---|---|---|
| new | `packages/core/src/observability/tracing.ts` | 1 | none |
| new | `packages/core/src/observability/config.ts` | 1 | none |
| new | `packages/core/src/observability/bootstrap.ts` | 1 | none |
| new | `packages/core/src/observability/feathers-hook.ts` | 2 | none |
| new | `packages/core/src/observability/instrumented-sdk.ts` | 3 | none |
| new | `packages/core/src/observability/instrumented-spawn.ts` | 3 | none |
| new | `packages/core/src/observability/instrumented-git.ts` | 3 | none |
| edit | `apps/agor-daemon/src/main.ts` | 1 | low (1 line, top of file) |
| edit | `apps/agor-daemon/src/register-hooks.ts` | 2 | low (1-2 lines) |
| edit | `package.json` (root + daemon + core) | 1 | medium (deps churn) |
| edit | `packages/executor/src/sdk-handlers/*/index.ts` | 3 | **high** — these get upstream churn |
| edit | call sites of spawn/git in daemon services | 3 | medium |

## Configuration

All env-driven, no `~/.agor/config.yaml` changes needed for first pass:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=agor-daemon
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod,host.name=$(hostname)
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, `initTracing()` is a no-op — safe
default for upstream users who pull the fork accidentally.

## Estimated effort

| Phase | Effort | Value |
|---|---|---|
| 1 | half day | high — covers 60% of debugging questions |
| 2 | 1-2 hours | high — service-level visibility |
| 3 | 1 day | high — agent SDK timing is the actual reason we want this |
| 4 | half day | medium — useful for dashboards |

Total: ~2-3 days for everything; Phase 1+2 alone in an afternoon.

## Rebase playbook

When upstream `main` advances:

1. `git rebase upstream/main`. Conflicts will land almost exclusively in
   `package.json` (deps) and the Phase 3 SDK handler import lines.
2. For SDK handler imports: re-apply the 1-line `import` change. The wrapper
   contract is stable, so the new upstream code calls the wrapper unchanged.
3. If upstream renames a handler file or restructures `sdk-handlers/`, re-do
   the 1-line import in the new location. Do not migrate logic — the wrapper
   is in `packages/core/src/observability/`, untouched.
4. `register-hooks.ts` and `main.ts` touchpoints are at top of file / list
   registration, so conflicts there are mechanical.

## Open questions

- **Collector target:** Tempo / Honeycomb / Jaeger / Grafana Cloud? Affects
  exporter choice (OTLP/HTTP works for all; gRPC only for some). Default to
  OTLP/HTTP.
- **Sampling at the daemon vs. collector:** start with parent-based 10% in
  daemon; revisit if volume is fine.
- **PII in spans:** session prompts and agent outputs must NOT land in span
  attributes. Wrappers should record token counts and model IDs only, never
  message content. Add a lint rule or test to enforce this on the wrapper
  files.
- **Multi-process attribution:** when the daemon spawns executor subprocesses,
  do we want trace context to propagate? Probably yes eventually (env var
  `TRACEPARENT`), but not in Phase 1.

## Reference

- Auto-instrumentation list:
  https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/metapackages/auto-instrumentations-node
- FeathersJS hooks: `apps/agor-daemon/src/register-hooks.ts`
- Daemon entrypoint: `apps/agor-daemon/src/main.ts`
- Existing peer deps: root `package.json` `peerDependencyRules`
