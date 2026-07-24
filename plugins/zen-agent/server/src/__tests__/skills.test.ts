import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));

function skill(name: string): string {
  return readFileSync(`${pluginRoot}/skills/${name}/SKILL.md`, 'utf8');
}

describe('Zen Agent skills', () => {
  it('keeps Zen login in chat without exposing credentials', () => {
    const content = skill('zen-login');
    const forbiddenFallback = new RegExp([
      'integrated' + String.raw`\s+terminal`,
      'npm install -g' + String.raw`\s+zen-ai`,
      'URL' + String.raw`\s+elicitation`,
      'shell',
      'PTY',
    ].join('|'), 'i');
    for (const required of [
      'zen_login',
      'verification_url',
      'login_id',
      'Markdown link',
      'pending',
      'auth_status',
    ]) expect(content).toContain(required);
    expect(content).toMatch(/repeat.*zen_login.*pending/is);
    expect(content).toMatch(/never.*email.*password|never.*password.*email/is);
    expect(content).not.toMatch(forbiddenFallback);
  });

  it('documents the context-only remote agent workflow', () => {
    const content = skill('zen-agent');
    for (const tool of [
      'auth_status',
      'start_agent',
      'agent_wait',
      'agent_status',
      'provide_context',
      'agent_result',
      'cancel_agent',
      'list_agents',
    ]) {
      expect(content).toContain(tool);
    }
    expect(content).toMatch(/never (uploads|upload|mounts|mount|clones|clone)/i);
    expect(content).toMatch(/ordinary.*repository.*automatic|automatically.*ordinary.*repository/is);
    expect(content).toMatch(/reason.*path.*before.*approval/is);
    for (const sensitive of ['.env', 'private key', 'credential', '.ssh', '.codex', 'outside', 'binary', 'archive', 'oversized']) {
      expect(content.toLowerCase()).toContain(sensitive);
    }
    expect(content).toMatch(/8 context rounds/i);
    expect(content).toMatch(/apply.*patch.*local|patch.*appl.*local/is);
    expect(content).toMatch(/run.*test.*local|local.*test/is);
    expect(content).toMatch(/cancel_agent/);
    expect(content).toMatch(/one (?:`?agent_wait`? )?call per context round/i);
    expect(content).toMatch(/must not run [`']?\/tmp\/\*\.mjs[`']? wrappers?/i);
    expect(content).toMatch(/must not narrate each poll/i);
    expect(content).toMatch(/must not print raw status JSON/i);
    expect(content).toMatch(/subagent.*default|default.*subagent/is);
    expect(content).toMatch(/host supports subagents|host subagent support/i);
    expect(content).toMatch(/Codex\s+subagent in Codex/i);
    expect(content).toMatch(/Claude Code subagent in Claude Code/i);
    expect(content).toMatch(/Default host subagent orchestration/i);
    expect(content).not.toMatch(/Default Codex subagent orchestration/i);
    expect(content).toMatch(/fallback.*workflow|workflow.*fallback/is);
    expect(content).toMatch(/subagents? (?:are|is) (?:an orchestration preference|optional)/i);
    expect(content).toMatch(/concise parent summary/i);
  });
});
