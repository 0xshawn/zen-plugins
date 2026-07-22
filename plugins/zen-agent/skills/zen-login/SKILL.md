---
name: zen-login
description: Use when the user asks to log in to Zen or Zen Agent reports a missing or expired Zen session.
---

# Zen login

Authenticate through Zen Agent's two-stage MCP workflow. The public verification
link and authenticated email may be shown in chat, but the secret device code,
session token, password, and config contents must never become model-visible.

## Workflow

1. Call Zen Agent `zen_login` with no arguments.
2. Render `verification_url` as a Markdown link and tell the user to copy it into a
   browser and approve login there. Keep the workflow in chat and never ask for a
   pasted code.
3. Call `zen_login` again with the returned `login_id`.
4. Repeat `zen_login` with the same `login_id` while the result contains
   `pending: true`. Each call is bounded; wait for it to finish, do not busy-loop,
   and do not create a new login.
5. After `authenticated: true`, call `auth_status` and report the authenticated
   email and numeric used and quota values.

Never ask the user for an email or password. Never request a device code, session
token, browser credential, or config contents in chat or MCP arguments. If the
session is missing or expired, restart at step 1 instead of attempting password or
form-based authentication.

Zen Agent stores the session at `$XDG_CONFIG_HOME/zen/config.json`, or
`~/.config/zen/config.json` when `XDG_CONFIG_HOME` is unset, and reads that same
shared config for later tools. There is no separate plugin credential store or
provider API key.
