# Zen Agent

Zen Agent lets Codex and Claude Code delegate bounded tasks to a
Zen-hosted Codex agent while keeping the customer repository local.

The remote agent receives only the task and context items explicitly approved
by the local agent. It does not receive automatic filesystem or Git access.

## Login

Ask the agent to run `zen login`. Zen Agent returns a secure browser link in the
chat. Copy the link into a browser and approve login there; the agent monitors
the request and completes login automatically.

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
