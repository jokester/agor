# 2026-04-26 — Patch: Anonymous JWT Reauth + VIEWER 403 in `useAgorData`

Companion to `journal/2026-04-26-anonymous-auth-race-condition.md`.

Two code bugs were exposed by the `allowAnonymous: true` config. The patches are
stashed (`git stash`) and not yet applied. This document records the rationale so
the decision to apply or discard is informed.

---

## Patch 1 — `ServiceJWTStrategy.getEntity('anonymous')`

**File:** `apps/agor-daemon/src/auth/service-jwt-strategy.ts`

**Change:**

```typescript
// Before: fell through to super.getEntity() → users.get('anonymous') → throws
// After:
if (id === 'anonymous') {
  return {
    user_id: 'anonymous',
    email: 'anonymous@localhost',
    role: ROLES.VIEWER,
  };
}
```

**Why it's needed:**

`ServiceJWTStrategy` already has a special case for `executor-service` because
that id has no DB row. `'anonymous'` is the same situation: FeathersJS issues a
real JWT with `sub: 'anonymous'` when the anonymous strategy authenticates, but
there is no `users` row for it. Without the explicit case, any code path that
validates an anonymous JWT — including `reAuthenticate(true)` on socket reconnect
— causes `users.get('anonymous')` to throw. The FeathersJS client's `handleError`
treats all authentication errors the same way: it calls `reset()`, which sets
`app.authentication = null`. In a reconnect scenario this races against the fresh
auth promise being set, leaving service calls unauthenticated.

**Scope:**

Only triggered when `allowAnonymous: true` AND the browser has a stored
`feathers-jwt: anonymous` entry (i.e., the user has visited before on that
session). Config `allowAnonymous: false` makes this unreachable.

**Consequence of applying:**

`reAuthenticate(true)` succeeds for anonymous JWTs. The reconnect path resolves
cleanly without `reset()` firing. No DB changes — the synthetic user is returned
in memory only, identical to how `executor-service` works.

**Consequence of not applying:**

Every daemon restart causes a "Not authenticated" flash for anonymous users who
have a cached JWT. They can recover by clearing localStorage or a hard reload.
If Agor is ever deployed with `allowAnonymous: true` for real (e.g., public read-
only board access), this is a guaranteed UX failure on every redeploy.

---

## Patch 2 — `session-mcp-servers` 403 in `useAgorData`

**File:** `apps/agor-ui/src/hooks/useAgorData.ts`

**Change:**

```typescript
client
  .service('session-mcp-servers')
  .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } })
  .catch((err) => {
    if (err && (err.code === 403 || err.status === 403 || err.statusCode === 403)) return [];
    throw err;
  }),
```

**Why it's needed:**

`session-mcp-servers` enforces `requireMinimumRole(ROLES.MEMBER)`. Any user with
role `VIEWER` — whether anonymous or a logged-in human — gets `403 Forbidden`.
`isDefiniteAuthFailure()` in `authErrors.ts` treats 403 as equivalent to 401:

```typescript
if (status === 401 || status === 403) return true;
```

This was the right call for API endpoints that 403 unauthenticated requests, but
it's wrong for role-gated endpoints where the user IS authenticated — just not
privileged enough. The around-hook attempts a token refresh, finds no refresh
token (VIEWER users may not have one), and re-throws the original 403. `Promise.all`
in `useAgorData.fetchData` rejects, the top-level error state is set, and the
user sees "Failed to load data".

**Scope:**

Any VIEWER-role user, not just anonymous. This is independent of `allowAnonymous`.
A manually-created account with role `VIEWER` hits the same failure.

**Alternative approach (not taken):**

Change `isDefiniteAuthFailure` to exclude 403. This would be more principled —
403 means "forbidden", not "unauthenticated" — but it's a wider change that could
affect other callers and other services that legitimately 403 for auth reasons
(e.g., a service that conflates auth and authz). The targeted `.catch()` on this
one call is narrower and safer.

Another alternative: relax the `session-mcp-servers` hook to allow VIEWER access
(read-only). That would be correct conceptually but requires daemon changes and a
migration. Not appropriate as a bug fix.

**Consequence of applying:**

VIEWER users get an empty MCP server list instead of a fatal fetch error. The rest
of the app initialises normally. No data is leaked — they still can't call any
`session-mcp-servers` mutations.

**Consequence of not applying:**

Any VIEWER-role user (logged in or anonymous) hits "Failed to load data" on the
main page. Currently mitigated by not using VIEWER-role accounts, but will surface
if role-restricted sharing is used.

---

## What Was Stashed But Should Be Dropped

**Patch 3** (also in the stash) — `useAgorClient.ts` `initialAuthDoneByMainFlow` flag.

This guarded against a double `authenticate()` on initial connect. The timing
window is real but the consequence is minor and the fix adds complexity to an
already intricate connection lifecycle. The patch was included in the original
investigation as a "tertiary" fix but on reflection the risk/reward doesn't justify
it. Drop this hunk when applying the stash.

---

## Apply Decision

| Patch | Apply? | Reason |
|-------|--------|--------|
| 1 — `getEntity('anonymous')` | Yes, if `allowAnonymous` is ever `true` | Correctness: anonymous id has no DB row, same as executor-service |
| 2 — `session-mcp-servers` catch | Yes, unconditionally | Config-independent; VIEWER users are broken today |
| 3 — `initialAuthDoneByMainFlow` | No | Complexity without clear benefit |
