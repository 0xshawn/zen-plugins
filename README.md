# Zen Plugins

Public plugins for Zen. The Zen product source repository remains private;
this repository contains only installable plugin artifacts.

## Zen Agent

Zen Agent delegates bounded tasks to a Zen-hosted Codex agent while keeping
repository access and context authorization local.

### Requirements

- Node.js 20 or newer
- A current Codex or Claude Code installation
- Network access to `https://zen.0xii.com`

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

### Optional legacy migration

If you previously installed `agent-bridge@zen`, remove it once after installing
Zen Agent:

```bash
codex plugin remove agent-bridge@zen
claude plugin uninstall agent-bridge@zen
```

Do not enable `agent-bridge@zen` and `zen-agent@zen` together.

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
