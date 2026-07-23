#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
export const serverRoot = path.resolve(scriptDirectory, '..')

export function zenAgentBuildOptions(overrides = {}) {
  return {
    absWorkingDir: serverRoot,
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'dist/index.js',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    ...overrides,
  }
}

export function buildZenAgent(overrides = {}) {
  return build(zenAgentBuildOptions(overrides))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildZenAgent()
}
