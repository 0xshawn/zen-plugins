# Zen Plugins

Public plugins for Zen. The Zen product source repository remains private;
this repository contains only installable plugin artifacts.

## Agent Bridge

Agent Bridge delegates bounded tasks to a Zen-hosted Codex agent while keeping
repository access and context authorization local.

### Requirements

- Node.js 20 or newer
- A current Codex or Claude Code installation
- Network access to `https://zen.0xii.com`

### Install in Codex

```bash
codex plugin marketplace add 0xshawn/zen-plugins
codex plugin add agent-bridge@zen
```

Fully quit and restart the ChatGPT/Codex desktop application, then start a new
chat.

### Update in Codex

```bash
codex plugin marketplace upgrade zen
codex plugin remove agent-bridge@zen
codex plugin add agent-bridge@zen
```

Fully quit and restart the ChatGPT/Codex desktop application, then start a new
chat.

If Codex still shows an older plugin version, verify the marketplace upgrade
and reinstall completed, then fully quit the desktop process. Opening only a
new chat is not sufficient.

### Install in Claude Code

```text
/plugin marketplace add 0xshawn/zen-plugins
/plugin install agent-bridge@zen
/reload-plugins
```

### Update in Claude Code

```text
/plugin marketplace update zen
/plugin update agent-bridge@zen
/reload-plugins
```

Do not enable `agent-bridge@personal` and `agent-bridge@zen` together.

## Login and privacy

Ask the agent to run `zen login`. Complete authentication only in the Zen
browser page. Do not paste passwords, device codes, or session tokens into chat.

Agent Bridge sends no repository content unless the local agent explicitly
approves context for a specific remote task.

## Support and security

Open normal support requests at
https://github.com/0xshawn/zen-plugins/issues. Report vulnerabilities privately
through GitHub Security Advisories at
https://github.com/0xshawn/zen-plugins/security/advisories/new.

## License

Agent Bridge is licensed under the MIT License. Bundled third-party software
notices are in
[plugins/agent-bridge/THIRD_PARTY_NOTICES.md](plugins/agent-bridge/THIRD_PARTY_NOTICES.md).
