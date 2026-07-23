# Zen Agent

Zen Agent lets Codex and Claude Code delegate bounded tasks to a
Zen-hosted agent while keeping the customer repository local. Codex is the
default remote agent, and Claude can be selected for an individual `start_agent`
task.

The remote agent receives the delegated task text and only context items
selected by the local agent. Sensitive or out-of-repository context requires
explicit user confirmation. It does not receive automatic filesystem or Git
access.

## Use with Codex

For the complete Codex guide, see
[Quickstart in Codex](../../README.md#quickstart-in-codex). It covers
installation, restart, login, delegation, context authorization, and updates.

## Login

Ask Codex in chat, for example:

```text
Log me in to Zen Agent.
```

Codex invokes the `zen_login` plugin tool; do not type `zen_login` in a
terminal. Open the secure browser link returned in chat and approve the request.
Codex monitors the approval and confirms when authentication is complete.

Never paste a password, device code, or session token into chat.

## Local configuration

Zen stores the session at `$XDG_CONFIG_HOME/zen/config.json`, or
`~/.config/zen/config.json` when `XDG_CONFIG_HOME` is unset. The file is written
with mode `0600`.

## Privacy

Customer repository context remains local unless the local agent explicitly
approves context for a specific Zen agent task.

## Requirements

- Node.js 20 or newer
- A current Codex or Claude Code installation
- Network access to `https://zen.0xii.com`

## Support

Open an issue at https://github.com/0xshawn/zen-plugins/issues.

## License

Zen Agent is licensed under the MIT License. Bundled third-party software
notices are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
