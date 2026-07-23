import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface ZenConfig {
  token?: string;
  email?: string;
  baseUrl?: string;
}

export interface ZenSession {
  token: string;
  baseUrl: string;
  email?: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'zen', 'config.json');
}

export async function readZenConfig(): Promise<ZenConfig> {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8')) as ZenConfig;
  } catch {
    return {};
  }
}

export async function writeZenConfig(config: ZenConfig, beforeCommit?: () => void): Promise<void> {
  const file = configPath();
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    beforeCommit?.();
    await fs.rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function apiBase(config: ZenConfig): string {
  return process.env.ZEN_API_BASE_URL ?? config.baseUrl ?? 'https://zen.0xii.com';
}

export async function loadZenSession(): Promise<ZenSession> {
  const config = await readZenConfig();
  if (!config.token) {
    throw new Error('Zen login required. Run `zen login` in this chat.');
  }
  return {
    token: config.token,
    baseUrl: apiBase(config),
    email: config.email,
  };
}
