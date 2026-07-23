#!/usr/bin/env node
import {
  lstat,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildZenAgent, serverRoot as defaultServerRoot } from './build.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultNoticesPath = path.resolve(scriptDirectory, '../../THIRD_PARTY_NOTICES.md')
const LEGAL_FILE = /^(?:licen[cs]e|copying|notice)(?:\.|$)/i

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizeSource(repository, packageName) {
  let source = typeof repository === 'string' ? repository : repository?.url
  if (!source) return `https://www.npmjs.com/package/${packageName}`
  if (/^[^/:\s]+\/[^/\s]+$/.test(source)) source = `https://github.com/${source}`
  source = source
    .replace(/^git\+/, '')
    .replace(/^git:\/\/github\.com\//, 'https://github.com/')
    .replace(/^git\+ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/\.git$/, '')
  return source
}

function packageRootForInput(serverRoot, input) {
  const absolute = path.resolve(serverRoot, input)
  const relative = path.relative(serverRoot, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`bundled input escapes the server root: ${input}`)
  }
  const parts = relative.split(path.sep)
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  if (nodeModulesIndex === -1) return null
  const packageStart = nodeModulesIndex + 1
  const packageLength = parts[packageStart]?.startsWith('@') ? 2 : 1
  if (!parts[packageStart] || !parts[packageStart + packageLength - 1]) {
    throw new Error(`cannot resolve bundled package owner: ${input}`)
  }
  return path.join(serverRoot, ...parts.slice(0, packageStart + packageLength))
}

async function readPackageNotice(packageRoot) {
  const manifestPath = path.join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.name || !manifest.version) {
    throw new Error(`bundled package metadata is incomplete: ${manifestPath}`)
  }
  if (typeof manifest.license !== 'string' || !manifest.license) {
    throw new Error(`bundled package has no SPDX license: ${manifest.name}`)
  }

  const legalFiles = []
  for (const entry of (await readdir(packageRoot, { withFileTypes: true }))) {
    if (!LEGAL_FILE.test(entry.name)) continue
    const legalPath = path.join(packageRoot, entry.name)
    const status = await lstat(legalPath)
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`bundled package legal file must be regular: ${legalPath}`)
    }
    legalFiles.push(entry.name)
  }
  legalFiles.sort(compareText)
  if (legalFiles.length === 0) {
    throw new Error(`license file not found for bundled package ${manifest.name}`)
  }

  const legalSections = []
  for (const file of legalFiles) {
    const contents = (await readFile(path.join(packageRoot, file), 'utf8'))
      .replaceAll('\r\n', '\n')
      .replace(/\n*$/, '\n')
    legalSections.push({ file, contents })
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    source: normalizeSource(manifest.repository, manifest.name),
    legalSections,
    licenseText: legalSections.map(section => section.contents).join('\n'),
  }
}

export async function collectBundledPackagesFromMetafile({
  metafile,
  serverRoot = defaultServerRoot,
}) {
  const bundlePath = path.join(serverRoot, 'dist/index.js')
  const bundleOutputs = Object.entries(metafile.outputs ?? {}).filter(([output]) => (
    path.resolve(serverRoot, output) === bundlePath
  ))
  if (bundleOutputs.length !== 1) {
    throw new Error('esbuild metafile must contain exactly one dist/index.js output')
  }

  const packageRoots = new Set()
  const output = bundleOutputs[0][1]
  for (const external of output.imports ?? []) {
    if (external.external && !external.path.startsWith('node:')) {
      throw new Error(`unexpected external runtime import: ${external.path}`)
    }
  }
  for (const [input, details] of Object.entries(output.inputs ?? {})) {
    if (!(details.bytesInOutput > 0)) continue
    const packageRoot = packageRootForInput(serverRoot, input)
    if (packageRoot) packageRoots.add(packageRoot)
  }

  const packages = []
  for (const packageRoot of [...packageRoots].sort(compareText)) {
    packages.push(await readPackageNotice(packageRoot))
  }
  packages.sort((left, right) => (
    compareText(left.name, right.name) || compareText(left.version, right.version)
  ))
  return packages
}

export async function collectBundledPackages() {
  const result = await buildZenAgent({ write: false, metafile: true })
  const bundle = result.outputFiles.find(file => file.path.endsWith(`${path.sep}dist${path.sep}index.js`))
  if (!bundle) throw new Error('esbuild did not produce dist/index.js')
  const trackedBundle = await readFile(path.join(defaultServerRoot, 'dist/index.js'))
  if (!Buffer.from(bundle.contents).equals(trackedBundle)) {
    throw new Error('tracked server/dist/index.js does not match the in-memory build')
  }
  return collectBundledPackagesFromMetafile({ metafile: result.metafile })
}

export function renderThirdPartyNotices(packages) {
  const lines = [
    '# Zen Agent Third-Party Notices',
    '',
    `This distribution includes ${packages.length} third-party packages.`,
    '',
  ]
  for (const dependency of packages) {
    lines.push(
      `## ${dependency.name} ${dependency.version}`,
      '',
      `License: ${dependency.license}`,
      '',
      `Source: ${dependency.source}`,
      '',
    )
    for (const section of dependency.legalSections) {
      lines.push(`### ${section.file}`, '', '```text', section.contents.trimEnd(), '```', '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export async function generateThirdPartyNotices() {
  return renderThirdPartyNotices(await collectBundledPackages())
}

async function main() {
  const notices = await generateThirdPartyNotices()
  if (process.argv[2] === '--check') {
    if (await readFile(defaultNoticesPath, 'utf8') !== notices) {
      throw new Error('THIRD_PARTY_NOTICES.md is stale; run npm run notices')
    }
    return
  }
  if (process.argv.length > 2) throw new Error(`unexpected argument: ${process.argv[2]}`)
  await writeFile(defaultNoticesPath, notices, 'utf8')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`third-party-notices: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
