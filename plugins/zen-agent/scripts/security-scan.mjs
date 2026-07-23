#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanRepository } from './release-lib.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '../../..')

scanRepository(repositoryRoot).then(files => {
  process.stdout.write(`Security scan passed for ${files.length} tracked files.\n`)
}).catch(error => {
  process.stderr.write(`security-scan: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
