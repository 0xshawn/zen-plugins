import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  assertReleasePreflight,
  assertReleaseVersionAdvances,
  compareStableSemver,
  parseReleaseArgs,
  requireStableVersion,
  runRelease,
  scanRepository,
  synchronizeVersions,
} from './release-lib.mjs'

const execFileAsync = promisify(execFile)
const pluginRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = path.resolve(pluginRoot, '../..')

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function createVersionFixture(t, version = '0.1.3') {
  const root = await temporaryDirectory(t, 'zen-release-versions-')
  const plugin = path.join(root, 'plugins/zen-agent')
  const server = path.join(plugin, 'server')
  await writeJson(path.join(plugin, '.codex-plugin/plugin.json'), { name: 'zen-agent', version })
  await writeJson(path.join(plugin, '.claude-plugin/plugin.json'), { name: 'zen-agent', version })
  await writeJson(path.join(server, 'package.json'), { name: 'zen-agent-server', version })
  await writeJson(path.join(server, 'package-lock.json'), {
    name: 'zen-agent-server',
    version,
    packages: { '': { name: 'zen-agent-server', version } },
  })
  await mkdir(path.join(server, 'dist'), { recursive: true })
  await writeFile(path.join(server, 'dist/index.js'), 'bundle\n')
  await writeFile(path.join(plugin, 'THIRD_PARTY_NOTICES.md'), 'notices\n')
  return root
}

async function readVersions(root) {
  const readJson = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'))
  const codex = await readJson('plugins/zen-agent/.codex-plugin/plugin.json')
  const claude = await readJson('plugins/zen-agent/.claude-plugin/plugin.json')
  const pkg = await readJson('plugins/zen-agent/server/package.json')
  const lock = await readJson('plugins/zen-agent/server/package-lock.json')
  return [codex.version, claude.version, pkg.version, lock.version, lock.packages[''].version]
}

function synthetic(parts) {
  return parts.join('')
}

test('release CLI accepts one stable version and no target repository', () => {
  assert.deepEqual(parseReleaseArgs(['--version', '1.2.3']), { version: '1.2.3' })
  assert.throws(() => parseReleaseArgs([]), /--version is required/)
  assert.throws(
    () => parseReleaseArgs(['--version', '1.2.3', '--target', '/tmp/other']),
    /unexpected argument: --target/,
  )
})

test('release versions must be stable SemVer', () => {
  assert.equal(requireStableVersion('0.1.4'), '0.1.4')
  for (const invalid of ['1.2', 'v1.2.3', '1.2.3-beta.1', '1.2.3+codex.20260723093908']) {
    assert.throws(() => requireStableVersion(invalid), /stable SemVer/)
  }
  assert.equal(compareStableSemver('1.10.0', '1.9.9'), 1)
  assert.equal(compareStableSemver('1.2.3', '1.2.3'), 0)
  assert.equal(compareStableSemver('0.9.9', '1.0.0'), -1)
})

test('release version must strictly advance beyond the public manifest', async t => {
  const root = await createVersionFixture(t)
  await assert.doesNotReject(assertReleaseVersionAdvances(root, '0.1.4'))
  await assert.rejects(assertReleaseVersionAdvances(root, '0.1.3'), /advance beyond 0\.1\.3/)
  await assert.rejects(assertReleaseVersionAdvances(root, '0.1.2'), /advance beyond 0\.1\.3/)
})

test('version synchronization updates both manifests, package, and both lock roots', async t => {
  const root = await createVersionFixture(t)
  await synchronizeVersions(root, '0.1.4')
  assert.deepEqual(await readVersions(root), Array(5).fill('0.1.4'))
})

test('release orchestration synchronizes before running the complete local gate', async t => {
  const root = await createVersionFixture(t)
  const commands = []
  const runCommand = async (command, args, cwd) => {
    commands.push({ command, args, cwd })
    assert.deepEqual(await readVersions(root), Array(5).fill('0.1.4'))
  }
  let scans = 0
  let preflights = 0

  await runRelease({
    repositoryRoot: root,
    version: '0.1.4',
    runCommand,
    scan: async scannedRoot => {
      assert.equal(scannedRoot, root)
      scans += 1
    },
    preflight: async (checkedRoot, checkedVersion) => {
      assert.equal(checkedRoot, root)
      assert.equal(checkedVersion, '0.1.4')
      assert.deepEqual(await readVersions(root), Array(5).fill('0.1.3'))
      preflights += 1
    },
    validatorPath: '/tmp/validate_plugin.py',
  })

  const server = path.join(root, 'plugins/zen-agent/server')
  const plugin = path.join(root, 'plugins/zen-agent')
  assert.deepEqual(commands, [
    { command: 'npm', args: ['test'], cwd: server },
    { command: 'npm', args: ['run', 'build'], cwd: server },
    { command: 'npm', args: ['run', 'notices:check'], cwd: server },
    {
      command: 'git',
      args: [
        'diff',
        '--exit-code',
        '--',
        'plugins/zen-agent/server/dist/index.js',
        'plugins/zen-agent/THIRD_PARTY_NOTICES.md',
      ],
      cwd: root,
    },
    { command: 'npm', args: ['run', 'test:release'], cwd: server },
    { command: 'python3', args: ['/tmp/validate_plugin.py', plugin], cwd: root },
    { command: 'claude', args: ['plugin', 'validate', '--strict', plugin], cwd: root },
    { command: 'claude', args: ['plugin', 'validate', '--strict', root], cwd: root },
    { command: 'git', args: ['diff', '--check'], cwd: root },
  ])
  assert.equal(preflights, 1)
  assert.equal(scans, 1)
})

test('release orchestration restores every mutable artifact after a partial failure', async t => {
  const root = await createVersionFixture(t)
  const bundle = path.join(root, 'plugins/zen-agent/server/dist/index.js')
  const notices = path.join(root, 'plugins/zen-agent/THIRD_PARTY_NOTICES.md')

  await assert.rejects(
    runRelease({
      repositoryRoot: root,
      version: '0.1.4',
      preflight: async () => {},
      runCommand: async (command, args) => {
        if (command === 'npm' && args[0] === 'run' && args[1] === 'build') {
          await writeFile(bundle, 'changed bundle\n')
          await writeFile(notices, 'changed notices\n')
          throw new Error('build failed')
        }
      },
      scan: async () => {},
      validatorPath: '/tmp/validate_plugin.py',
    }),
    /build failed/,
  )

  assert.deepEqual(await readVersions(root), Array(5).fill('0.1.3'))
  assert.equal(await readFile(bundle, 'utf8'), 'bundle\n')
  assert.equal(await readFile(notices, 'utf8'), 'notices\n')
})

test('release preflight requires canonical root, remote, main, clean state, and absent tag', async t => {
  const root = await createVersionFixture(t)
  await writeFile(path.join(root, 'README.md'), 'fixture\n')
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
  await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:0xshawn/zen-plugins.git'], { cwd: root })
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync(
    'git',
    ['-c', 'user.name=Zen Test', '-c', 'user.email=zen-test@example.com', 'commit', '-m', 'fixture'],
    { cwd: root },
  )

  await assert.doesNotReject(assertReleasePreflight(root, '0.1.4', { validateRemoteTag: false }))

  await writeFile(path.join(root, 'README.md'), 'dirty\n')
  await assert.rejects(
    assertReleasePreflight(root, '0.1.4', { validateRemoteTag: false }),
    /clean/,
  )
  await execFileAsync('git', ['restore', 'README.md'], { cwd: root })

  await execFileAsync('git', ['switch', '-c', 'feature'], { cwd: root })
  await assert.rejects(
    assertReleasePreflight(root, '0.1.4', { validateRemoteTag: false }),
    /branch must be main/,
  )
  await execFileAsync('git', ['switch', 'main'], { cwd: root })

  await execFileAsync('git', ['tag', 'zen-agent-v0.1.4'], { cwd: root })
  await assert.rejects(
    assertReleasePreflight(root, '0.1.4', { validateRemoteTag: false }),
    /tag already exists/,
  )
})

test('release preflight rejects a tag already present on origin', async t => {
  const root = await createVersionFixture(t)
  const calls = []
  const runGitCommand = async (_root, args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return root
    if (args[0] === 'remote') return 'git@github.com:0xshawn/zen-plugins.git'
    if (args[0] === 'branch') return 'main'
    if (args[0] === 'status') return ''
    if (args[0] === 'show-ref') {
      const error = new Error('missing local tag')
      error.code = 1
      throw error
    }
    if (args[0] === 'ls-remote') return 'deadbeef\trefs/tags/zen-agent-v0.1.4'
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  }
  await assert.rejects(
    assertReleasePreflight(root, '0.1.4', { runGitCommand }),
    /tag already exists on origin/,
  )
  assert.equal(calls.at(-1)[0], 'ls-remote')
})

test('release preflight rejects split current metadata before mutation', async t => {
  const root = await createVersionFixture(t)
  const claude = path.join(root, 'plugins/zen-agent/.claude-plugin/plugin.json')
  await writeJson(claude, { name: 'zen-agent', version: '0.1.2' })
  await assert.rejects(
    assertReleasePreflight(root, '0.1.4', { validateGit: false }),
    /metadata versions are not synchronized/,
  )
})

test('scanner accepts the canonical source tree', async () => {
  await assert.doesNotReject(scanRepository(repositoryRoot))
})

test('scanner rejects forbidden public paths', async t => {
  const cases = [
    ['.env', 'PUBLIC=true\n', /environment file/],
    ['plugin/.env.example', 'PUBLIC=true\n', /environment file/],
    ['plugins/zen-agent/server/node_modules/pkg/index.js', 'export {}\n', /node_modules/],
    ['plugins/zen-agent/server/dist/index.js.map', '{}\n', /source map/],
    ['services/backend/src/main.rs', 'fn main() {}\n', /backend or runner/],
    ['services/agent-runner/src/index.ts', 'export {}\n', /backend or runner/],
    ['plugins/zen-agent/Dockerfile', 'FROM node:20\n', /deployment/],
    ['deploy/zen-agent.yaml', 'kind: Deployment\n', /deployment/],
    ['plugins/zen-agent/server/config/zen-agent.config.toml', 'model = "x"\n', /runner configuration/],
  ]

  for (const [relative, contents, expected] of cases) {
    const root = await temporaryDirectory(t, 'zen-scan-path-')
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents)
    await assert.rejects(scanRepository(root, { files: [relative] }), expected)
  }
})

test('scanner rejects symbolic links and non-regular entries', async t => {
  const root = await temporaryDirectory(t, 'zen-scan-links-')
  await writeFile(path.join(root, 'AGENTS.md'), '# Guide\n')
  await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'))
  await assert.rejects(scanRepository(root, { files: ['CLAUDE.md'] }), /symbolic link/)

  await mkdir(path.join(root, 'directory-entry'))
  await assert.rejects(
    scanRepository(root, { files: ['directory-entry'] }),
    /regular file/,
  )
})

test('scanner rejects credential and private-repository content without blocking synthetic fixtures', async t => {
  const github = synthetic(['gh', 'p_', 'A'.repeat(24)])
  const githubFine = synthetic(['github', '_pat_', 'A'.repeat(32)])
  const openai = synthetic(['sk', '-proj-', 'A'.repeat(24)])
  const aws = synthetic(['AK', 'IA', 'A'.repeat(16)])
  const privateKey = synthetic(['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'])
  const masterKey = synthetic(['ZEN_', 'MASTER_', 'KEY=', 'production-secret'])
  const privateRepository = synthetic(['https://github.com/0xshawn/', 'zen', '/tree/main'])
  const homePath = synthetic(['/home/', 'private-user/', 'zen/file.ts'])
  const cases = [github, githubFine, openai, aws, privateKey, masterKey, privateRepository, homePath]

  for (const [index, contents] of cases.entries()) {
    const root = await temporaryDirectory(t, 'zen-scan-content-')
    const relative = `fixture-${index}.txt`
    await writeFile(path.join(root, relative), `${contents}\n`)
    await assert.rejects(scanRepository(root, { files: [relative] }), /forbidden content/)
  }

  const root = await temporaryDirectory(t, 'zen-scan-synthetic-')
  const relative = 'synthetic-fixtures.txt'
  await writeFile(path.join(root, relative), [
    'token=synthetic-test-token',
    'sk-example',
    'https://github.com/0xshawn/zen-plugins',
    '/api/agent/jobs/example',
  ].join('\n'))
  await assert.doesNotReject(scanRepository(root, { files: [relative] }))
})

test('scanner defaults to Git tracked and staged files', async t => {
  const root = await temporaryDirectory(t, 'zen-scan-git-')
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
  await writeFile(path.join(root, 'safe.txt'), 'safe\n')
  await writeFile(path.join(root, '.env.local'), 'PUBLIC=true\n')
  await execFileAsync('git', ['add', 'safe.txt'], { cwd: root })
  await assert.doesNotReject(scanRepository(root))
  await execFileAsync('git', ['add', '-f', '.env.local'], { cwd: root })
  await assert.rejects(scanRepository(root), /environment file/)
})

test('scanner reads staged blobs and modes instead of trusting worktree bytes', async t => {
  const root = await temporaryDirectory(t, 'zen-scan-index-')
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
  const file = path.join(root, 'client.txt')
  await writeFile(file, 'safe\n')
  await execFileAsync('git', ['add', 'client.txt'], { cwd: root })
  await execFileAsync(
    'git',
    ['-c', 'user.name=Zen Test', '-c', 'user.email=zen-test@example.com', 'commit', '-m', 'safe'],
    { cwd: root },
  )

  const stagedCredential = synthetic(['gh', 'p_', 'A'.repeat(24)])
  await writeFile(file, `${stagedCredential}\n`)
  await execFileAsync('git', ['add', 'client.txt'], { cwd: root })
  await writeFile(file, 'safe worktree\n')
  await assert.rejects(scanRepository(root), /GitHub credential/)

  await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: root })
  await rm(file)
  await symlink('safe-target', file)
  await execFileAsync('git', ['add', 'client.txt'], { cwd: root })
  await rm(file)
  await writeFile(file, 'safe worktree\n')
  await assert.rejects(scanRepository(root), /index entry must be a regular file/)
})

test('scanner also rejects unstaged tracked worktree secrets', async t => {
  const root = await temporaryDirectory(t, 'zen-scan-worktree-')
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
  const file = path.join(root, 'client.txt')
  await writeFile(file, 'safe\n')
  await execFileAsync('git', ['add', 'client.txt'], { cwd: root })
  await execFileAsync(
    'git',
    ['-c', 'user.name=Zen Test', '-c', 'user.email=zen-test@example.com', 'commit', '-m', 'safe'],
    { cwd: root },
  )
  await writeFile(file, `${synthetic(['AK', 'IA', 'A'.repeat(16)])}\n`)
  await assert.rejects(scanRepository(root), /AWS credential/)
})

test('scanner rejects tracked content that is not valid UTF-8', async t => {
  const root = await temporaryDirectory(t, 'zen-scan-utf8-')
  const relative = 'binary.bin'
  await writeFile(path.join(root, relative), Buffer.from([0xff, 0xfe, 0xfd]))
  await assert.rejects(scanRepository(root, { files: [relative] }), /invalid UTF-8/)
})

test('public metadata remains synchronized at stable SemVer', async () => {
  const versions = await readVersions(repositoryRoot)
  assert.deepEqual(versions, Array(5).fill(versions[0]))
  assert.equal(requireStableVersion(versions[0]), versions[0])
})

test('release entrypoint is executable JavaScript with an English usage contract', async () => {
  const release = await readFile(path.join(pluginRoot, 'scripts/release.mjs'), 'utf8')
  assert.match(release, /--version X\.Y\.Z/)
  assert.doesNotMatch(release, /--target/)
  const mode = (await lstat(path.join(pluginRoot, 'scripts/release.mjs'))).mode & 0o777
  assert.notEqual(mode & 0o100, 0)
})
