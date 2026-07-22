---
name: zen-login
description: Use when the user asks to log in to Zen or Agent Bridge reports a missing or expired Zen session.
---

# Zen login

Authenticate through Agent Bridge's secure MCP URL elicitation. The device code,
session token, email, and password must never become model-visible MCP arguments.

## Workflow

1. Call Agent Bridge `zen_login` with no arguments.
2. Let the MCP client present the URL elicitation and let the user complete login in
   the browser. Do not ask the user to copy a device code or session token into chat.
3. When `zen_login` reports authentication succeeded, call Agent Bridge `auth_status`
   to validate the stored session and report quota usage.
4. If Agent Bridge reports that MCP URL elicitation is unsupported, use the integrated
   terminal fallback. Check whether `zen` is installed and, if needed, tell the user to
   install it:

   ```bash
   npm install -g zen-ai
   ```

   Then ask the user to run `zen login` in the integrated terminal and call
   `auth_status` after it completes.
5. Never ask the user for an email or password in chat or MCP arguments. Never use a
   password fallback through MCP, chat, or form elicitation. Never put credentials on
   the `zen login` command line, echo them, capture them into context, or copy terminal
   input into a report.
6. If `auth_status` returns 401, explain that the session is missing or expired and
   repeat this workflow. Do not attempt a password-based MCP call.

The CLI stores the session at `$XDG_CONFIG_HOME/zen/config.json`, or
`~/.config/zen/config.json` when `XDG_CONFIG_HOME` is unset. Agent Bridge reads that
same file. Both the CLI and `zen_login` use this shared session; there is no separate
plugin credential store or provider API key.
