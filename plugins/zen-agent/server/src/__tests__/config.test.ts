import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apiBase, configPath, loadZenSession, readZenConfig, writeZenConfig } from '../config.js';

describe('Zen session config', () => {
  let root: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'zen-agent-config-'));
    process.env = { ...originalEnv, XDG_CONFIG_HOME: root };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(root, { recursive: true, force: true });
  });

  it('uses the same XDG config path as the Zen CLI', () => {
    expect(configPath()).toBe(join(root, 'zen', 'config.json'));
  });

  it('reads the Zen CLI token and API base', async () => {
    await mkdir(join(root, 'zen'), { recursive: true });
    await writeFile(
      join(root, 'zen', 'config.json'),
      JSON.stringify({ token: 'session-token', email: 'user@example.com', baseUrl: 'http://config' }),
    );

    expect(await readZenConfig()).toEqual({
      token: 'session-token',
      email: 'user@example.com',
      baseUrl: 'http://config',
    });
    await expect(loadZenSession()).resolves.toEqual({
      token: 'session-token',
      baseUrl: 'http://config',
      email: 'user@example.com',
    });
  });

  it('returns an empty config when the file is missing or invalid', async () => {
    expect(await readZenConfig()).toEqual({});
    await mkdir(join(root, 'zen'), { recursive: true });
    await writeFile(join(root, 'zen', 'config.json'), '{invalid');
    expect(await readZenConfig()).toEqual({});
  });

  it('creates the config directory and round-trips the full config', async () => {
    const config = {
      token: 'session-token',
      email: 'user@example.com',
      baseUrl: 'http://config',
    };

    await writeZenConfig(config);

    expect(await readZenConfig()).toEqual(config);
  });

  it('restricts an existing config file to owner read and write', async () => {
    await mkdir(join(root, 'zen'), { recursive: true });
    const file = join(root, 'zen', 'config.json');
    await writeFile(file, JSON.stringify({ baseUrl: 'http://config' }));
    await chmod(file, 0o644);

    const oldInode = (await stat(file)).ino;
    const existing = await readZenConfig();
    await writeZenConfig({ ...existing, token: 'session-token', email: 'user@example.com' });

    const finalStat = await stat(file);
    expect(finalStat.ino).not.toBe(oldInode);
    expect(finalStat.mode & 0o777).toBe(0o600);
    expect(await readZenConfig()).toEqual({
      baseUrl: 'http://config',
      token: 'session-token',
      email: 'user@example.com',
    });
  });

  it('runs beforeCommit immediately before atomic replacement', async () => {
    const hook = vi.fn(() => undefined);

    await writeZenConfig({ token: 'session-token' }, hook);

    expect(hook).toHaveBeenCalledOnce();
    expect(await readZenConfig()).toEqual({ token: 'session-token' });
  });

  it('does not replace config when beforeCommit rejects the commit', async () => {
    await mkdir(join(root, 'zen'), { recursive: true });
    const file = join(root, 'zen', 'config.json');
    await writeFile(file, JSON.stringify({ baseUrl: 'http://config' }), { mode: 0o644 });

    await expect(writeZenConfig({ token: 'session-token' }, () => {
      throw new Error('cancelled');
    })).rejects.toThrow('cancelled');

    expect(await readZenConfig()).toEqual({ baseUrl: 'http://config' });
    expect(await readdir(join(root, 'zen'))).toEqual(['config.json']);
  });

  it('removes the temporary file when atomic replacement fails', async () => {
    const directory = join(root, 'zen');
    await mkdir(join(directory, 'config.json'), { recursive: true });

    await expect(writeZenConfig({ token: 'session-token' })).rejects.toThrow();

    expect(await readdir(directory)).toEqual(['config.json']);
  });

  it('uses API base precedence env then config then production', () => {
    delete process.env.ZEN_API_BASE_URL;
    expect(apiBase({ baseUrl: 'http://config' })).toBe('http://config');
    expect(apiBase({})).toBe('https://zen.0xii.com');
    process.env.ZEN_API_BASE_URL = 'http://env';
    expect(apiBase({ baseUrl: 'http://config' })).toBe('http://env');
  });

  it('instructs the user to run zen login when the token is missing', async () => {
    await expect(loadZenSession()).rejects.toThrow(
      'Zen login required. Run `zen login` in this chat.',
    );
  });
});
