#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseReleaseArgs, runRelease } from './release-lib.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '../../..')

async function main() {
  const { version } = parseReleaseArgs(process.argv.slice(2))
  await runRelease({ repositoryRoot, version })
  process.stdout.write([
    `Prepared Zen Agent ${version}.`,
    'Review the synchronized manifests, lockfile, bundle, and notices.',
    `Commit with: release(zen-agent): v${version}`,
    `Tag with: zen-agent-v${version}`,
    '',
  ].join('\n'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write([
      'Usage: node plugins/zen-agent/scripts/release.mjs --version X.Y.Z',
      `release: ${error instanceof Error ? error.message : String(error)}`,
      '',
    ].join('\n'))
    process.exitCode = 1
  })
}
