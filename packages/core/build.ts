import { cpSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { build } from 'tsup'

// ── Tune this to control peak tsc memory ─────────────────────────────────────
// Lower = fewer entries per tsc invocation = less memory, more passes.
// Start at 10; halve if you hit OOM, double if builds are too slow.
const DTS_BATCH_SIZE = 10
// ─────────────────────────────────────────────────────────────────────────────

const entry: Record<string, string> = {
  index: 'src/index.ts',
  'types/index': 'src/types/index.ts',
  'db/index': 'src/db/index.ts',
  'db/session-guard': 'src/db/session-guard.ts',
  'git/index': 'src/git/index.ts',
  'api/index': 'src/api/index.ts',
  'claude/index': 'src/claude/index.ts',
  'config/index': 'src/config/index.ts',
  'config/browser': 'src/config/browser.ts',
  'permissions/index': 'src/permissions/index.ts',
  'feathers/index': 'src/feathers/index.ts',
  'lib/feathers-validation': 'src/lib/feathers-validation.ts',
  'templates/handlebars-helpers': 'src/templates/handlebars-helpers.ts',
  'templates/session-context': 'src/templates/session-context.ts',
  'environment/variable-resolver': 'src/environment/variable-resolver.ts',
  'environment/render-snapshot': 'src/environment/render-snapshot.ts',
  'utils/errors': 'src/utils/errors.ts',
  'utils/url': 'src/utils/url.ts',
  'utils/permission-mode-mapper': 'src/utils/permission-mode-mapper.ts',
  'utils/cron': 'src/utils/cron.ts',
  'utils/context-window': 'src/utils/context-window.ts',
  'utils/board-placement': 'src/utils/board-placement.ts',
  'utils/host-ip': 'src/utils/host-ip.ts',
  'utils/path': 'src/utils/path.ts',
  'utils/logger': 'src/utils/logger.ts',
  'seed/index': 'src/seed/index.ts',
  'callbacks/child-completion-template': 'src/callbacks/child-completion-template.ts',
  'client/index': 'src/client/index.ts',
  'models/browser': 'src/models/browser.ts',
  'models/gemini-shared': 'src/models/gemini-shared.ts',
  'models/index': 'src/models/index.ts',
  'sdk/index': 'src/sdk/index.ts',
  'tools/mcp/jwt-auth': 'src/tools/mcp/jwt-auth.ts',
  'tools/mcp/oauth-auth': 'src/tools/mcp/oauth-auth.ts',
  'tools/mcp/oauth-mcp-transport': 'src/tools/mcp/oauth-mcp-transport.ts',
  'tools/mcp/oauth-refresh': 'src/tools/mcp/oauth-refresh.ts',
  'unix/index': 'src/unix/index.ts',
  'mcp/index': 'src/mcp/index.ts',
  'gateway/index': 'src/gateway/index.ts',
  'yaml/index': 'src/yaml/index.ts',
}

const shared = {
  format: ['cjs', 'esm'] as const,
  splitting: false,
  shims: true,
  clean: false, // we handle dist cleanup manually so batches don't nuke each other
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@google/gemini-cli-core',
    '@google/genai',
    '@opencode-ai/sdk',
    '@slack/web-api',
    '@slack/socket-mode',
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:os',
    'node:url',
  ],
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size))
  return result
}

async function main() {
  await rm('dist', { recursive: true, force: true })

  // Pass 1: JS only — esbuild, fast, low memory
  console.log('[1/2] Building JS (CJS + ESM)…')
  await build({ ...shared, entry, dts: false })
  cpSync('drizzle', 'dist/drizzle', { recursive: true })
  console.log('  ✓ drizzle migrations → dist/')
  cpSync('src/templates/agor-system-prompt.md', 'dist/templates/agor-system-prompt.md')
  console.log('  ✓ agor-system-prompt.md → dist/templates/')

  // Pass 2: declarations in batches — tsc is memory-hungry, process each batch
  // sequentially so the previous language service is GC'd before the next starts
  const batches = chunk(Object.entries(entry), DTS_BATCH_SIZE)
  console.log(`[2/2] Building declarations — ${batches.length} batches of ≤${DTS_BATCH_SIZE} entries`)
  for (let i = 0; i < batches.length; i++) {
    const batchEntry = Object.fromEntries(batches[i])
    console.log(`  Batch ${i + 1}/${batches.length}: ${Object.keys(batchEntry).join(', ')}`)
    await build({ ...shared, entry: batchEntry, dts: { only: true } })
  }

  console.log('✅ Build complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
