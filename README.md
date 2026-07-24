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

### Quickstart in Codex

Run all `codex plugin` installation, update, and list commands below in a
terminal.

#### 1. Install the plugin

```bash
codex plugin marketplace add 0xshawn/zen-plugins
codex plugin add zen-agent@zen
```

Inspect the installation and version information with:

```bash
codex plugin list --marketplace zen --json
```

After installation, fully quit and reopen the ChatGPT/Codex desktop app, then
start a new chat.

#### 2. Log in

In the new chat, send:

```text
Log me in to Zen Agent.
```

Codex invokes the `zen_login` plugin tool. `zen_login` is not a shell command.
Open the secure browser link returned in chat and approve the request. Codex
monitors the approval and confirms when authentication is complete.
Do not paste passwords, device codes, or session tokens into chat.

#### 3. Delegate a bounded task

Ask Codex to delegate a narrow task and name the files it may supply as
context. For example:

```text
Use Zen Agent to review the installation and login documentation in README.md
and plugins/zen-agent/README.md. Supply context only from those two named files.
Report findings by severity and include a unified diff when a change is useful.
Do not edit any local files.
```

Codex starts the hosted job, handles specific context requests, and returns the
findings or proposed patch for local review. Inspect and test every accepted
change locally.

#### What Zen receives

- The delegated task text is sent to Zen. Do not put secrets in task text.
- Initial context and context supplied in response to later requests are sent
  only as selected text items.
- The local Codex agent may supply ordinary text from inside the repository when
  it is relevant to the task and stays within normal limits.
- Explicit user confirmation is required before sending secrets or authentication
  configuration, paths outside the repository, binary or other non-text
  content, or oversized context.

Zen Agent does not receive automatic filesystem or Git access.

#### Plugin tools Codex uses

`auth_status`, `start_agent`, `agent_wait`, `agent_status`, `provide_context`,
`agent_result`, `cancel_agent`, and `list_agents` are plugin tools that Codex
invokes, not terminal commands or chat commands users normally type.

The normal workflow is:

1. Codex checks the current session with `auth_status`.
2. It starts a remote job with `start_agent` and keeps the returned job ID.
3. It calls `agent_wait` once per context round. The wait pauses until the job
   requests specific context or reaches a terminal state.
4. When context is requested, Codex reviews the reason and sends only the
   smallest authorized excerpt with `provide_context`.
5. When the wait completes with state `done`, its response already includes the
   terminal result, so normal operation does not require a separate
   `agent_result` call.
6. It stops unnecessary work with `cancel_agent`; `list_agents` can inspect the
   current user's jobs. Keep `agent_status` and `agent_result` available as
   explicit/debug tools when a direct status or result fetch is needed.

Hosts should not run shell wrappers or ad-hoc polling scripts, narrate each poll,
or print raw status JSON. Return a concise final summary instead.

### Update in Codex

Run these commands in a terminal:

```bash
codex plugin marketplace upgrade zen
codex plugin remove zen-agent@zen
codex plugin add zen-agent@zen
```

Fully quit and reopen the ChatGPT/Codex desktop app, then start a new chat.

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

## Support and security

Open normal support requests at
https://github.com/0xshawn/zen-plugins/issues. Report vulnerabilities privately
through GitHub Security Advisories at
https://github.com/0xshawn/zen-plugins/security/advisories/new.

## License

Zen Agent is licensed under the MIT License. Bundled third-party software
notices are in
[plugins/zen-agent/THIRD_PARTY_NOTICES.md](plugins/zen-agent/THIRD_PARTY_NOTICES.md).
