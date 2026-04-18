# Shared build helpers for agor dev scripts.
# REPO_ROOT must be set by the caller before sourcing.
#
# Each ensure_*_built function:
#   - Acquires an exclusive flock so concurrent script invocations don't
#     double-build the same package.
#   - Re-checks staleness after acquiring the lock (the first holder may
#     have just finished the build).
#   - Runs the build only when dist is absent or any .ts source is newer
#     than the sentinel dist file.

_agor_build_if_stale() {
  local label="$1" lockfile="$2" sentinel="$3" srcdir="$4"
  shift 4
  # $@ is the build command
  (
    flock -x 9
    if [ ! -f "$sentinel" ] || \
       [ -n "$(find "$srcdir" -newer "$sentinel" -name '*.ts' 2>/dev/null | head -1)" ]; then
      echo "[agor] Building $label..."
      set -uex
      cd "$REPO_ROOT"
      "$@"
    fi
  ) 9>"$lockfile"
}

ensure_core_built() {
  _agor_build_if_stale "@agor/core" \
    "/tmp/agor-core-build.lock" \
    "$REPO_ROOT/packages/core/dist/index.d.ts" \
    "$REPO_ROOT/packages/core/src" \
    pnpm --filter @agor/core exec tsx build.ts
}

ensure_client_built() {
  _agor_build_if_stale "@agor-live/client" \
    "/tmp/agor-client-build.lock" \
    "$REPO_ROOT/packages/client/dist/index.d.ts" \
    "$REPO_ROOT/packages/client/src" \
    pnpm --filter @agor-live/client build
}

ensure_daemon_built() {
  _agor_build_if_stale "@agor/daemon" \
    "/tmp/agor-daemon-build.lock" \
    "$REPO_ROOT/apps/agor-daemon/dist/index.d.ts" \
    "$REPO_ROOT/apps/agor-daemon/src" \
    pnpm --filter @agor/daemon build
}

ensure_executor_built() {
  _agor_build_if_stale "@agor/executor" \
    "/tmp/agor-executor-build.lock" \
    "$REPO_ROOT/packages/executor/dist/cli.js" \
    "$REPO_ROOT/packages/executor/src" \
    pnpm --filter @agor/executor build
}

ensure_cli_built() {
  _agor_build_if_stale "@agor/cli" \
    "/tmp/agor-cli-build.lock" \
    "$REPO_ROOT/apps/agor-cli/dist/commands/daemon/start.js" \
    "$REPO_ROOT/apps/agor-cli/src" \
    pnpm --filter @agor/cli build
  # CLI's tsup.config.ts globs include *.test.ts (upstream behavior).
  # Strip the emitted test artifacts so they don't bloat dist/ or get
  # registered as oclif commands.
  find "$REPO_ROOT/apps/agor-cli/dist" \
    \( -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.test.js.map' \) \
    -delete 2>/dev/null || true
}
