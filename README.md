# Zen Plugins

Public plugins for Zen. This repository contains the installable Zen Agent
plugin, its TypeScript client source, tests, build tooling, and release/security
checks. Zen backend and hosted runner implementation remain outside this
repository.

## Zen Agent

Zen Agent delegates bounded tasks to a Zen-hosted Codex agent while keeping
repository access and context authorization local.

### Requirements

- Node.js 20 or newer
- A current Codex or Claude Code installation
- Network access to `https://zen.0xii.com`

### Development

Build and verify the public client from source:

```bash
cd plugins/zen-agent/server
npm ci
npm test
npm run build
npm run notices:check
npm run test:release
```

Prepare a later stable release from the repository root with:

```bash
node plugins/zen-agent/scripts/release.mjs --version X.Y.Z
```

The release command synchronizes public metadata and runs the complete local
test, build, validator, and security gate. See [AGENTS.md](AGENTS.md) for the
development and release contract.

### Install in Codex

```bash
codex plugin marketplace add 0xshawn/zen-plugins
codex plugin add zen-agent@zen
```

Fully quit and restart the ChatGPT/Codex desktop application, then start a new
chat.

### Update in Codex

```bash
codex plugin marketplace upgrade zen
codex plugin remove zen-agent@zen
codex plugin add zen-agent@zen
```

Fully quit and restart the ChatGPT/Codex desktop application, then start a new
chat.

If Codex still shows an older plugin version, verify the marketplace upgrade
and reinstall completed, then fully quit the desktop process. Opening only a
new chat is not sufficient.

### Install in Claude Code

```bash
claude plugin marketplace add 0xshawn/zen-plugins
claude plugin install zen-agent@zen
```

Restart Claude Code or run `/reload-plugins`.

### Update in Claude Code

```bash
claude plugin marketplace update zen
claude plugin uninstall zen-agent@zen
claude plugin install zen-agent@zen
```

Restart Claude Code or run `/reload-plugins`.

## Usage

Zen Agent is for bounded review, analysis, and patch-drafting tasks. Ask Codex or
Claude Code to delegate a narrow task and include only the context needed to
answer it.

### Typical workflow

1. Zen Agent checks the existing `zen login` session with `auth_status`.
2. It starts a remote job with `start_agent` and keeps the returned job ID.
3. It polls `agent_status` until the job is done or requests specific context.
4. When context is requested, the local agent reviews the reason and sends only
   the smallest approved excerpt with `provide_context`.
5. The local agent retrieves findings or an optional unified diff with
   `agent_result`, reviews the result, and applies any accepted change locally.
6. Stop unnecessary work with `cancel_agent`; use `list_agents` to inspect the
   current user's jobs.

### Available operations

- `auth_status` — check the current Zen session and quota.
- `start_agent` — start a context-only remote job.
- `agent_status` — poll a job and inspect context requests.
- `provide_context` — send locally reviewed text for an approved request.
- `agent_result` — retrieve structured findings and an optional unified diff.
- `cancel_agent` — cancel a job and release capacity.
- `list_agents` — list the current user's jobs.

The remote agent never receives automatic filesystem or Git access. Repository
content stays local unless the local agent explicitly approves a specific,
minimal context excerpt. Treat returned findings and patches as review input;
inspect and test all accepted changes locally.

## Login and privacy

Ask the agent to run `zen login`. Zen Agent returns a secure browser link in the
chat. Copy the link into a browser and approve login there; the agent monitors
the request and completes login automatically. Do not paste passwords, device
codes, or session tokens into chat.

Zen Agent sends no repository content unless the local agent explicitly
approves context for a specific remote task.

## Support and security

Open normal support requests at
https://github.com/0xshawn/zen-plugins/issues. Report vulnerabilities privately
through GitHub Security Advisories at
https://github.com/0xshawn/zen-plugins/security/advisories/new.

## License

Zen Agent is licensed under the MIT License. Bundled third-party software
notices are in
[plugins/zen-agent/THIRD_PARTY_NOTICES.md](plugins/zen-agent/THIRD_PARTY_NOTICES.md).
