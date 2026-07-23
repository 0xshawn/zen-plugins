import { execFile } from 'node:child_process'
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const VERSION_FILES = [
  'plugins/zen-agent/.codex-plugin/plugin.json',
  'plugins/zen-agent/.claude-plugin/plugin.json',
  'plugins/zen-agent/server/package.json',
]
const LOCK_FILE = 'plugins/zen-agent/server/package-lock.json'

const PATH_SEGMENT_RULES = [
  ['backend or runner path', segments => (
    segments.join('/') === 'services/backend'
    || segments.join('/').startsWith('services/backend/')
    || segments.join('/') === 'services/agent-runner'
    || segments.join('/').startsWith('services/agent-runner/')
  )],
  ['deployment path', segments => segments.some(segment => (
    ['deploy', 'deployment', 'k8s', 'helm', 'terraform'].includes(segment.toLowerCase())
  ))],
]

function contentRules() {
  return [
    ['private key', new RegExp(['-----BEGIN ', '[A-Z0-9 ]*', 'PRIVATE KEY-----'].join(''))],
    ['GitHub credential', new RegExp(['\\bgh', '[pousr]_', '[A-Za-z0-9_]{20,}\\b'].join(''))],
    ['GitHub credential', new RegExp(['\\bgithub', '_pat_', '[A-Za-z0-9_]{20,}\\b'].join(''))],
    ['OpenAI credential', new RegExp(['\\bsk', '-(?:proj-)?', '[A-Za-z0-9_-]{20,}\\b'].join(''))],
    ['AWS credential', new RegExp(['\\bAK', 'IA', '[0-9A-Z]{16}\\b'].join(''))],
    [
      'Zen master key',
      new RegExp([
        '(?:^|[^A-Za-z0-9_])',
        'ZEN_',
        'MASTER_',
        'KEY',
        '\\s*(?:=|:)\\s*(?:["\'`][^"\'`\\r\\n]+["\'`]|[^\\s,}]+)',
      ].join(''), 'm'),
    ],
    ['absolute Linux home path', new RegExp(['/', 'home/', '[A-Za-z0-9._-]+/'].join(''))],
    ['absolute Linux root path', new RegExp(['/', 'root/'].join(''))],
    ['absolute macOS home path', new RegExp(['/', 'Users/', '[A-Za-z0-9._-]+/'].join(''))],
    [
      'absolute Windows user path',
      new RegExp(['[A-Za-z]:', '\\\\{1,2}', 'Users', '\\\\{1,2}', '[^\\\\]+', '\\\\{1,2}'].join('')),
    ],
    [
      'private Zen repository URL',
      new RegExp([
        'github\\.com[/:]',
        '0xshawn\\/',
        'zen',
        '(?:\\.git)?(?=[/"\'\\s?#]|$)',
      ].join(''), 'i'),
    ],
  ]
}

function resolveRepositoryPath(repositoryRoot, relative) {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new Error(`tracked path must be relative: ${relative}`)
  }
  const root = path.resolve(repositoryRoot)
  const resolved = path.resolve(root, relative)
  const fromRoot = path.relative(root, resolved)
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`tracked path escapes repository: ${relative}`)
  }
  return resolved
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function requireStableVersion(value) {
  if (typeof value !== 'string' || !STABLE_SEMVER.test(value)) {
    throw new Error('release version must be stable SemVer (major.minor.patch)')
  }
  return value
}

export function compareStableSemver(left, right) {
  const leftParts = requireStableVersion(left).split('.').map(BigInt)
  const rightParts = requireStableVersion(right).split('.').map(BigInt)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}

export function parseReleaseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--version') throw new Error(`unexpected argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error('--version requires a value')
    if (result.version !== undefined) throw new Error('--version may be provided only once')
    result.version = requireStableVersion(value)
    index += 1
  }
  if (!result.version) throw new Error('--version is required')
  return result
}

export async function assertReleaseVersionAdvances(repositoryRoot, requested) {
  requireStableVersion(requested)
  const manifest = await readJson(path.join(
    repositoryRoot,
    'plugins/zen-agent/.codex-plugin/plugin.json',
  ))
  const current = requireStableVersion(manifest.version)
  if (compareStableSemver(requested, current) <= 0) {
    throw new Error(`release version must advance beyond ${current}`)
  }
}

export async function synchronizeVersions(repositoryRoot, version) {
  requireStableVersion(version)
  for (const relative of VERSION_FILES) {
    const file = path.join(repositoryRoot, relative)
    const value = await readJson(file)
    value.version = version
    await writeJson(file, value)
  }
  const lockPath = path.join(repositoryRoot, LOCK_FILE)
  const lock = await readJson(lockPath)
  if (!lock.packages || !lock.packages['']) {
    throw new Error('server package lock is missing the root package')
  }
  lock.version = version
  lock.packages[''].version = version
  await writeJson(lockPath, lock)
}

export async function synchronizedVersions(repositoryRoot) {
  const versions = []
  for (const relative of VERSION_FILES) {
    const value = await readJson(path.join(repositoryRoot, relative))
    versions.push(requireStableVersion(value.version))
  }
  const lock = await readJson(path.join(repositoryRoot, LOCK_FILE))
  versions.push(requireStableVersion(lock.version))
  versions.push(requireStableVersion(lock.packages?.['']?.version))
  if (new Set(versions).size !== 1) {
    throw new Error(`metadata versions are not synchronized: ${versions.join(', ')}`)
  }
  return versions[0]
}

async function runGit(repositoryRoot, args, options = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  })
  return stdout.trim()
}

export async function assertReleasePreflight(
  repositoryRoot,
  requested,
  { validateGit = true, validateRemoteTag = true, runGitCommand = runGit } = {},
) {
  requireStableVersion(requested)
  const current = await synchronizedVersions(repositoryRoot)
  if (compareStableSemver(requested, current) <= 0) {
    throw new Error(`release version must advance beyond ${current}`)
  }
  if (!validateGit) return

  const actualRoot = await runGitCommand(repositoryRoot, ['rev-parse', '--show-toplevel'])
  if (path.resolve(actualRoot) !== path.resolve(repositoryRoot)) {
    throw new Error('release must run from the repository root')
  }
  const remote = await runGitCommand(repositoryRoot, ['remote', 'get-url', 'origin'])
  if (![
    'git@github.com:0xshawn/zen-plugins.git',
    'https://github.com/0xshawn/zen-plugins.git',
    'https://github.com/0xshawn/zen-plugins',
  ].includes(remote)) {
    throw new Error('origin must be the public zen-plugins repository')
  }
  if (await runGitCommand(repositoryRoot, ['branch', '--show-current']) !== 'main') {
    throw new Error('release branch must be main')
  }
  if (await runGitCommand(repositoryRoot, ['status', '--porcelain'])) {
    throw new Error('release repository must be clean')
  }
  const tag = `zen-agent-v${requested}`
  let localTagExists = false
  try {
    await runGitCommand(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])
    localTagExists = true
  } catch (error) {
    if (error?.code !== 1) throw error
  }
  if (localTagExists) throw new Error(`release tag already exists: ${tag}`)
  if (!validateRemoteTag) return
  try {
    const remoteTag = await runGitCommand(
      repositoryRoot,
      ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`],
    )
    if (remoteTag) throw new Error(`release tag already exists on origin: ${tag}`)
  } catch (error) {
    if (error?.code === 2) return
    throw error
  }
}

async function indexedEntries(repositoryRoot) {
  const output = await runGit(repositoryRoot, ['ls-files', '-s', '-z'])
  return output.split('\0').filter(Boolean).map(record => {
    const separator = record.indexOf('\t')
    if (separator === -1) throw new Error('malformed git index entry')
    const [mode, object, stage] = record.slice(0, separator).split(' ')
    return { mode, object, stage, relative: record.slice(separator + 1) }
  })
}

async function readIndexBlob(repositoryRoot, object) {
  const { stdout } = await execFileAsync('git', ['cat-file', 'blob', object], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    maxBuffer: 20 * 1024 * 1024,
  })
  return Buffer.from(stdout)
}

function checkPath(relative) {
  const normalized = relative.split(path.sep).join('/')
  const segments = normalized.split('/')
  const basename = segments.at(-1) ?? ''
  const lowerBasename = basename.toLowerCase()

  if (basename === '.env' || basename.startsWith('.env.')) {
    throw new Error(`environment file is forbidden: ${normalized}`)
  }
  if (segments.includes('node_modules')) throw new Error(`node_modules is forbidden: ${normalized}`)
  if (lowerBasename.endsWith('.map')) throw new Error(`source map is forbidden: ${normalized}`)
  if (
    lowerBasename === 'dockerfile'
    || lowerBasename.startsWith('dockerfile.')
    || /^docker-compose(?:\..+)?\.ya?ml$/.test(lowerBasename)
    || /^compose(?:\..+)?\.ya?ml$/.test(lowerBasename)
    || lowerBasename.endsWith('.tf')
  ) {
    throw new Error(`deployment configuration is forbidden: ${normalized}`)
  }
  if (
    lowerBasename === 'zen-agent.config.toml'
    || lowerBasename === 'hooks.json'
    || segments.some(segment => segment.toLowerCase() === 'runner-config')
  ) {
    throw new Error(`runner configuration is forbidden: ${normalized}`)
  }
  for (const [label, matches] of PATH_SEGMENT_RULES) {
    if (matches(segments)) throw new Error(`${label} is forbidden: ${normalized}`)
  }
}

function scanContent(relative, content) {
  if (content.includes('\uFFFD')) {
    throw new Error(`invalid UTF-8 content found in ${relative}`)
  }
  for (const [label, pattern] of contentRules()) {
    if (pattern.test(content)) {
      throw new Error(`forbidden content (${label}) found in ${relative}`)
    }
  }
}

export async function scanRepository(repositoryRoot, { files } = {}) {
  if (files) {
    for (const relative of files) {
      checkPath(relative)
      const file = resolveRepositoryPath(repositoryRoot, relative)
      const status = await lstat(file)
      if (status.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${relative}`)
      if (!status.isFile()) throw new Error(`tracked entry must be a regular file: ${relative}`)
      scanContent(relative, await readFile(file, 'utf8'))
    }
    return files
  }

  const entries = await indexedEntries(repositoryRoot)
  for (const entry of entries) {
    const { mode, stage, object, relative } = entry
    checkPath(relative)
    if (stage !== '0' || !['100644', '100755'].includes(mode)) {
      throw new Error(`index entry must be a regular file: ${relative}`)
    }
    scanContent(relative, (await readIndexBlob(repositoryRoot, object)).toString('utf8'))

    const file = resolveRepositoryPath(repositoryRoot, relative)
    const status = await lstat(file).catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (!status || status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`tracked worktree entry must be a regular file: ${relative}`)
    }
    scanContent(relative, await readFile(file, 'utf8'))
  }
  return entries
}

async function defaultRunCommand(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  })
}

export function defaultValidatorPath() {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  return path.join(codexHome, 'skills/.system/plugin-creator/scripts/validate_plugin.py')
}

const MUTABLE_RELEASE_FILES = [
  ...VERSION_FILES,
  LOCK_FILE,
  'plugins/zen-agent/server/dist/index.js',
  'plugins/zen-agent/THIRD_PARTY_NOTICES.md',
]

async function snapshotFiles(repositoryRoot) {
  const snapshot = []
  for (const relative of MUTABLE_RELEASE_FILES) {
    const file = resolveRepositoryPath(repositoryRoot, relative)
    const status = await lstat(file)
    if (!status.isFile()) throw new Error(`release artifact must be a regular file: ${relative}`)
    snapshot.push({ relative, mode: status.mode, contents: await readFile(file) })
  }
  return snapshot
}

async function restoreFiles(repositoryRoot, snapshot) {
  for (const { relative, mode, contents } of snapshot) {
    const file = resolveRepositoryPath(repositoryRoot, relative)
    await writeFile(file, contents)
    await chmod(file, mode & 0o7777)
  }
}

export async function runRelease({
  repositoryRoot,
  version,
  runCommand = defaultRunCommand,
  scan = scanRepository,
  validatorPath = defaultValidatorPath(),
  preflight = assertReleasePreflight,
}) {
  await preflight(repositoryRoot, version)
  const snapshot = await snapshotFiles(repositoryRoot)
  try {
    await synchronizeVersions(repositoryRoot, version)

    const pluginRoot = path.join(repositoryRoot, 'plugins/zen-agent')
    const serverRoot = path.join(pluginRoot, 'server')
    const commands = [
      ['npm', ['test'], serverRoot],
      ['npm', ['run', 'build'], serverRoot],
      ['npm', ['run', 'notices:check'], serverRoot],
      [
        'git',
        [
          'diff',
          '--exit-code',
          '--',
          'plugins/zen-agent/server/dist/index.js',
          'plugins/zen-agent/THIRD_PARTY_NOTICES.md',
        ],
        repositoryRoot,
      ],
      ['npm', ['run', 'test:release'], serverRoot],
      ['python3', [validatorPath, pluginRoot], repositoryRoot],
      ['claude', ['plugin', 'validate', '--strict', pluginRoot], repositoryRoot],
      ['claude', ['plugin', 'validate', '--strict', repositoryRoot], repositoryRoot],
      ['git', ['diff', '--check'], repositoryRoot],
    ]
    for (const [command, args, cwd] of commands) {
      await runCommand(command, args, cwd)
    }
    await scan(repositoryRoot)
  } catch (error) {
    try {
      await restoreFiles(repositoryRoot, snapshot)
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'release failed and mutable artifact restoration was incomplete',
      )
    }
    throw error
  }
}
