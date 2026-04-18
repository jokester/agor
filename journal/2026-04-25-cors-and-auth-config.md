# 2026-04-25 — CORS Configuration & CLI Auth Debugging

## Problem 1: `agor user update` fails with "Authentication required"

Running `./agor user update admin@agor.live --password '...'` failed even though
the daemon was up and `allowAnonymous: true` was set in config.

### Root Cause

The `users` service `find` hook in `register-hooks.ts` throws `NotAuthenticated`
when all three conditions are true:

1. Request comes from an external provider (`params.provider` is set — i.e. REST/socket, not internal)
2. User is not authenticated (`params.user` is null — anonymous session)
3. No `email` query param (the one bypass allowed for LocalStrategy lookups)

`user update` calls `usersService.findAll()` immediately (to resolve the email/ID
argument to a user record). Since the CLI fell through to anonymous auth (no stored
JWT), this `find` call hit condition 3 and threw before even reaching `patch`.

### Fix

Log in first so the CLI stores a JWT:

```bash
agor login
```

Alternatively, pass an API key via env to bypass the JWT path entirely:

```bash
AGOR_API_KEY=<key> agor user update admin@agor.live --password '...'
```

`BaseCommand.connectToDaemon()` checks `getApiKeyFromEnv()` before attempting JWT
or anonymous auth.

---

## Problem 2: CORS blocking requests from external host

The UI was being accessed from `http://100.100.62.28:5173/` (Tailscale IP), which
was not in the CORS allowlist. The daemon defaults to `list` mode which only
auto-allows `localhost:<uiPort>` through.

### Fix

Added a `security.cors` block to `~/.agor/config.yaml`:

```yaml
security:
  cors:
    origins:
      - "http://100.100.62.28:5173/"
```

`list` mode (the default) is used — no `mode:` key needed. This keeps credentials
enabled (the default), unlike `wildcard` mode which forces credentials off per the
CORS spec.

Restart the daemon after editing config for changes to take effect.

### CORS mode reference

| Mode | `Allow-Origin` header | Credentials |
|---|---|---|
| `list` (default) | matched origins only | yes (default) |
| `wildcard` | `*` | forced off |
| `reflect` | echoes request Origin | forced off |
| `null-origin` | only `null` origin | configurable |

Regex patterns work in `origins` if wrapped in `/slashes/`.
