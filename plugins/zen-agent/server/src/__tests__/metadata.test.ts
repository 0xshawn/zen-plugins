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
    expect(agents).not.toContain('+codex.');
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
});
