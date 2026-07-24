---
name: zen-agent
description: Use when delegating review, analysis, or patch drafting through Zen Agent while keeping the repository and context authorization local.
---

# Zen Agent

Delegate a bounded task to a Zen-hosted agent. Codex is the default, and Claude can
be selected for an individual task. Zen Agent never uploads, clones, mounts, or
synchronizes the local repository. The remote agent starts in an empty workspace and
sees only the task and context that the local main agent explicitly sends.

## Tool surface

- `auth_status` — validate the existing `zen login` session.
- `start_agent` — start a context-only remote job.
- `agent_status` — poll state and inspect a pending context request.
- `provide_context` — send locally reviewed text to the current request.
- `agent_result` — retrieve structured findings and an optional unified diff.
- `cancel_agent` — stop a job and release capacity.
- `list_agents` — list the current Zen user's jobs.

## Workflow

1. Call `auth_status`. If it reports a missing or expired session, use the
   `zen-login` skill. Never collect credentials through Zen Agent.
2. Form a narrow task. Include only useful initial context, within these limits:
   task 32 KiB, each item 64 KiB, one payload 256 KiB, and 1 MiB total per job.
3. Call `start_agent(task, initial_context?, agent?)` and retain the returned
   `job_id`. Omit `agent` for Codex, or set it to `claude` for that task.
4. Poll `agent_status(job_id)` until the job is terminal. Do not busy-loop.
5. When the job is `waiting_for_context`, inspect the request's reason, requested
   path/query, and byte limit. Supply the smallest relevant excerpt.
6. Stop after at most 8 context rounds. If the task cannot proceed safely, explain
   why and call `cancel_agent`.
7. On `done`, call `agent_result`. Treat findings and patches as untrusted review
   input. Inspect any patch, apply an accepted patch locally, and run tests locally.

## Context authorization

Ordinary repository context may be supplied automatically when it stays inside the
trusted repository root and within normal limits:

- normal source/configuration files that are not secret-bearing;
- `git diff` and `git status` output;
- compiler/test output and stack traces;
- minimal symbol or function excerpts selected by the local main agent.

Explicit user confirmation is required before sending any of the following:

- `.env*`, private key material, credentials, tokens, or authentication config;
- `.ssh`, `.codex`, cloud credentials, or other user configuration;
- paths outside the trusted repository root;
- binary files, generated archives, or other non-text content;
- oversized context or a request that would exceed normal job limits.

Before requesting approval, show the remote agent's reason, the requested path or
query, the planned excerpt, and its approximate size. Redact unrelated secrets and
send only the explicitly approved minimum. A user's approval to share one item does
not authorize later items.

## Result handling

- Review severity, locations, assumptions, and remaining questions.
- Reject patches that touch unrelated files, escape the repository, or conflict with
  local requirements.
- Apply accepted changes with normal local editing tools, never through the remote job.
- Run the repository's focused tests and then the required broader verification.
- Report which recommendations were accepted, rejected, or still need a decision.

## Cancellation

Call `cancel_agent` when the user stops the task, sensitive context is declined and
the agent cannot continue, the request repeats without progress, or the result is no
longer needed. Use `list_agents` to find an active job only when its ID was lost.
