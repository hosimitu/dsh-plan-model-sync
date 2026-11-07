import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: true,
  // Harness packages are resolved by the host at runtime, never bundled.
  deps: { neverBundle: [/^@deepseek-ai\//] },
  // `package.json` names `lib/index.js` and `lib/index.d.ts`; keep those
  // extensions rather than tsdown's ESM defaults.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
