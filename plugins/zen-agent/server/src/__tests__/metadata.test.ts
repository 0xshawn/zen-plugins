import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const readText = (relative: string) =>
  readFileSync(pluginRoot + '/' + relative, 'utf8');
const readJson = (relative: string) =>
  JSON.parse(readText(relative));

describe('Zen Agent metadata', () => {
  it('uses the canonical plugin identity', () => {
    const codex = readJson('.codex-plugin/plugin.json');
    const claude = readJson('.claude-plugin/plugin.json');
    const mcp = readJson('.mcp.json');
    const pkg = readJson('server/package.json');
    expect(codex.name).toBe('zen-agent');
    expect(claude.name).toBe('zen-agent');
    expect(codex.homepage).toContain('/plugins/zen-agent');
    expect(claude.homepage).toContain('/plugins/zen-agent');
    expect(codex.interface.displayName).toBe('Zen Agent');
    expect(codex.mcpServers['zen-agent']).toBeDefined();
    expect(mcp.mcpServers['zen-agent']).toBeDefined();
    expect(pkg.name).toBe('zen-agent-server');
    expect(pkg.private).toBe(true);
  });

  it('keeps stable public release metadata synchronized', () => {
    const codex = readJson('.codex-plugin/plugin.json');
    const claude = readJson('.claude-plugin/plugin.json');
    const pkg = readJson('server/package.json');
    const lock = readJson('server/package-lock.json');
    const versions = [
      codex.version,
      claude.version,
      pkg.version,
      lock.version,
      lock.packages[''].version,
    ];
    expect(new Set(versions)).toEqual(new Set([codex.version]));
    expect(codex.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('documents the public repository as the canonical client source', () => {
    const agents = readText('../../AGENTS.md');
    expect(agents).toContain('sole buildable source');
    expect(agents).toContain('node plugins/zen-agent/scripts/release.mjs --version X.Y.Z');
    expect(agents).toContain('services/backend');
    expect(agents).toContain('services/agent-runner');
    expect(agents).not.toContain(['+', 'codex', '.'].join(''));
    expect(agents).not.toContain('--target');
  });

  it('documents and continuously verifies public client development', () => {
    const readme = readText('../../README.md');
    const workflow = readText('../../.github/workflows/ci.yml');
    expect(readme).toContain('TypeScript client source');
    expect(readme).toContain('npm run test:release');
    expect(readme).toContain('scripts/release.mjs --version');
    expect(workflow).toContain('node-version: 20');
    for (const command of [
      'npm ci',
      'npm test',
      'npm run build',
      'npm run notices:check',
      'npm run test:release',
      'git diff --check',
    ]) {
      expect(workflow).toContain(command);
    }
  });

  it('documents the quiet agent_wait quickstart workflow', () => {
    const readme = readText('../../README.md');
    const pluginReadme = readText('README.md');
    expect(readme).toContain('`agent_wait`');
    expect(readme).toMatch(/calls `agent_wait` once per context round/i);
    expect(readme).toMatch(/wait completes with state `done`, its response already includes/i);
    expect(readme).not.toMatch(/wait completes with a terminal state, its response already includes/i);
    expect(readme).toMatch(/should not run shell wrappers or ad-hoc polling scripts/i);
    expect(readme).toMatch(/multi-agent support is available.*creates one subagent/is);
    expect(readme).toMatch(/subagents or inherited MCP tools are unavailable.*directly/is);
    expect(readme).not.toMatch(
      /polls `agent_status` until the job is done.*retrieves findings.*`agent_result`/is,
    );
    expect(pluginReadme).toMatch(/job that reaches state `done` includes its terminal result/i);
    expect(pluginReadme).toMatch(/defaults to delegating the whole\s+workflow to one host-native subagent/i);
    expect(pluginReadme).toMatch(/Codex subagent in Codex or a Claude Code\s+subagent in Claude Code/i);
    expect(pluginReadme).toMatch(/falls\s+back to the direct `agent_wait` workflow/i);
    expect(pluginReadme).not.toMatch(/completed job includes its terminal result/i);
    expect(readme).toMatch(/Claude Code loads the same Zen Agent skill and MCP server as Codex/i);
    expect(readme).toMatch(/creates one Claude Code subagent to run the\s+Zen Agent workflow/i);
    expect(readme).toMatch(/Claude Code falls back to the direct\s+`agent_wait` workflow/i);
  });
});
