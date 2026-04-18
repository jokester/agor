# 2026-04-26 — "Not Authenticated" on Anonymous Sessions After Daemon Restart

## Experience

Opened the UI at `/` after restarting the daemon (a config change had triggered
an automatic restart). The page showed:

```
Failed to load data
Not authenticated
```

The daemon health endpoint showed everything was configured correctly at the
time:

```
GET http://100.100.62.28:3030/health
→ { "auth": { "requireAuth": false, "allowAnonymous": true }, ... }
```

No login wall appeared. The error came from inside the app after it had already
loaded. A hard refresh didn't help; the error persisted.

---

## Actual Root Cause: Config

After investigation, the config file (`~/.agor/config.yaml`) already had
`requireAuth: true` set — but the daemon had not been restarted to pick it up.
The health endpoint reflected the previous in-memory state (`requireAuth: false,
allowAnonymous: true`). The combination of:

- `allowAnonymous: true` — anonymous users could connect and get a `feathers-jwt`
  with `sub: 'anonymous'` stored in browser localStorage
- `requireAuth: false` — no login gate was shown; the app tried to load data as
  an anonymous user
- daemon restart — triggered the reconnect path, which replayed the anonymous JWT
  through a server-side path that was broken (see code bugs below)

The correct config for "login required" mode is:

```yaml
daemon:
  requireAuth: true      # shows login page to unauthenticated users
  allowAnonymous: false  # disables anonymous connections entirely
```

With `allowAnonymous: false`, no anonymous JWTs are ever issued, the broken
reauth path is never reached, and the login gate fires before any service calls.

---

## Latent Code Bugs (Exposed by `allowAnonymous: true`)

Two real bugs in the code were exposed by the `allowAnonymous: true` config.
They are harmless with `allowAnonymous: false` but will bite anyone who enables
anonymous mode. They are documented and patched separately — see
`journal/2026-04-26-anonymous-jwt-reauth-patch.md`.

### Bug 1 — `users.get('anonymous')` throws on JWT reauth (triggered by daemon restart)

When the daemon restarts, the socket disconnects. FeathersJS `authentication-client`
calls `reAuthenticate(true)` on disconnect if `this.authenticated === true`. It
reads `feathers-jwt` from localStorage, finds the anonymous JWT (`sub: 'anonymous'`),
and sends it as a JWT auth attempt. On the server, `ServiceJWTStrategy.getEntity('anonymous')`
had no explicit case and fell through to `super.getEntity()` → `users.get('anonymous')`
→ no DB row → throws. This failure triggers `handleError()` → `reset()` →
`app.set('authentication', null)`. Meanwhile the socket reconnected and a new
auth Promise was set — `reset()` then cleared it, leaving service calls with no
authentication → "Not authenticated".

This bug is only reachable when `allowAnonymous: true` has been active long
enough for a `feathers-jwt: anonymous` entry to exist in the browser.

### Bug 2 — `session-mcp-servers` 403 treated as auth failure (config-independent)

`session-mcp-servers` requires role `MEMBER`. Any `VIEWER`-role user (anonymous
or a logged-in human with VIEWER role) gets `403 Forbidden`. `isDefiniteAuthFailure()`
classifies 403 as an auth failure (same as 401), so the around-hook attempts a
token refresh. Anonymous sessions have no refresh token; the refresh returns null
and re-throws the 403, which bubbles up to `useAgorData` and sets the top-level
error state.

Unlike Bug 1, this affects any VIEWER-role user regardless of `allowAnonymous`.

---

## Workaround (immediate, no restart needed)

Clear `feathers-jwt` from browser localStorage:

```
DevTools → Application → Local Storage → [your origin] → delete feathers-jwt
```

Then reload. Without the stale anonymous JWT, `reAuthenticate(true)` finds
nothing and skips the broken path entirely.
