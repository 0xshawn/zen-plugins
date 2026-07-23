# Zen Plugins Repository Guide

This repository is the sole buildable source and release repository for the
public Zen Agent client. It contains the installable bundle, TypeScript source,
tests, build tooling, skills, manifests, documentation, and release checks.

Respond in Chinese or English only. Code comments and commit messages must be
English.

## Repository boundary

Only public plugin client material belongs here. Never copy or recreate:

- `services/backend` implementation or configuration;
- `services/agent-runner` implementation or configuration;
- Docker, deployment, runner bootstrap, or infrastructure files;
- `.env*`, credentials, authentication state, private keys, or real tokens;
- absolute developer-machine paths or links to the private Zen repository.

Public client API routes, request/response contracts, and clearly synthetic
test fixtures are expected. Keep repository access local: the plugin may send
only context explicitly approved for a bounded remote task.

## Layout

- `plugins/zen-agent/server/src/` — MCP client TypeScript source and tests.
- `plugins/zen-agent/server/dist/index.js` — tracked self-contained runtime.
- `plugins/zen-agent/server/scripts/` — build and third-party notice generation.
- `plugins/zen-agent/scripts/` — same-repository release and security tooling.
- `plugins/zen-agent/skills/` — Codex and Claude Code workflow guidance.
- `.agents/` and `.claude-plugin/` — public marketplace catalogs.

## Development

Run client commands from `plugins/zen-agent/server`:

```bash
npm ci
npm test
npm run build
npm run notices:check
npm run test:release
```

`npm run test:release` runs release unit tests and scans every tracked or staged
public file. The scanner rejects secret-shaped content, private paths,
server-side material, deployment configuration, source maps, dependency trees,
symlinks, and non-regular entries.

After building, verify that the tracked bundle is current:

```bash
git diff --exit-code -- plugins/zen-agent/server/dist/index.js
git diff --check
```

## Version and release workflow

All five version fields use one stable SemVer without private build
metadata: both plugin manifests, `server/package.json`, and the two root version
fields in `server/package-lock.json`.

Choose a version strictly greater than the current public manifest, then run
from the repository root:

```bash
node plugins/zen-agent/scripts/release.mjs --version X.Y.Z
```

The command synchronizes versions and runs tests, build verification, notice
verification, release/security tests, both plugin validators, and
`git diff --check`. Review every resulting change and obtain an independent
review before publishing.

Use public commit `release(zen-agent): vX.Y.Z` and annotated tag
`zen-agent-vX.Y.Z` with annotation `Zen Agent vX.Y.Z`. Never move or replace an
existing release tag. Push the reviewed commit and tag atomically, then verify
the remote branch, tag object, and peeled tag commit before reinstalling the
plugin.

## Security and privacy

- Never print or record passwords, session tokens, device secrets, real browser
  login links, credentials, or local config contents.
- Use synthetic values in tests and reports.
- Do not weaken a scanner rule to accommodate production-shaped test data;
  construct clearly synthetic fixtures instead.
- Do not add symlinks. All tracked entries must be regular files.
- Installation must continue to use the bundled runtime without running
  `npm install` in an installed plugin.
