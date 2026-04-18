import { cpSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { build } from 'tsup'
import tsupConfig from './tsup.config'

// ── Tune this to control peak tsc memory ─────────────────────────────────────
// Lower = fewer entries per tsc invocation = less memory, more passes.
// Start at 10; halve if you hit OOM, double if builds are too slow.
const DTS_BATCH_SIZE = 10
// ─────────────────────────────────────────────────────────────────────────────

// Source the entry map and externals from tsup.config so this stays in lockstep
// with upstream. tsup's defineConfig returns the input object unchanged.
const upstream = tsupConfig as { entry: Record<string, string>; external?: string[] }
const entry: Record<string, string> = upstream.entry

const shared = {
  format: ['cjs', 'esm'] as const,
  splitting: false,
  shims: true,
  clean: false, // we handle dist cleanup manually so batches don't nuke each other
  external: upstream.external,
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
