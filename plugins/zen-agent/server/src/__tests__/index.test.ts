import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleAgentResult,
  handleAgentStatus,
  handleAuthStatus,
  handleCancelAgent,
  handleListAgents,
  handleProvideContext,
  handleStartAgent,
  handleZenLogin,
  SERVER_NAME,
  toolDefinitions,
} from '../index.js';
import { ZenAgentClient } from '../api.js';
import { LOGIN_ID_SOURCE, type ZenLoginCoordinator } from '../login.js';

vi.mock('../config.js', () => ({
  loadZenSession: vi.fn(async () => ({ token: 'session', baseUrl: 'http://zen', email: 'u@example.com' })),
  readZenConfig: vi.fn(async () => ({ baseUrl: 'http://zen' })),
  writeZenConfig: vi.fn(async (_config: unknown, beforeCommit?: () => void) => beforeCommit?.()),
  apiBase: vi.fn((config: { baseUrl?: string }) => config.baseUrl ?? 'https://zen.0xii.com'),
}));

vi.mock('../api.js', () => ({
  ZenAgentClient: vi.fn(() => ({
    authStatus: vi.fn(async () => ({ used_tokens: 1, quota_tokens: 100 })),
    startAgent: vi.fn(async () => ({ job_id: 'job-1', state: 'queued' })),
    agentStatus: vi.fn(async () => ({ job_id: 'job-1', state: 'running' })),
    provideContext: vi.fn(async () => undefined),
    agentResult: vi.fn(async () => ({ summary: 'done', findings: [], tests: [], assumptions: [], remaining_questions: [] })),
    cancelAgent: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => [{ job_id: 'job-1', state: 'running' }]),
  })),
  ZenDeviceClient: vi.fn(),
}));

describe('Zen Agent MCP handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the canonical MCP server name', () => {
    expect(SERVER_NAME).toBe('zen-agent');
  });

  it('advertises exactly the eight Zen agent tools', () => {
    expect(toolDefinitions.map(tool => tool.name)).toEqual([
      'zen_login',
      'auth_status',
      'start_agent',
      'agent_status',
      'provide_context',
      'agent_result',
      'cancel_agent',
      'list_agents',
    ]);
  });

  it('describes auth_status as validating the existing Zen session', () => {
    expect(toolDefinitions.find(tool => tool.name === 'auth_status')?.description)
      .toBe('Validate the existing Zen session and report quota usage.');
  });

  it('exposes zen_login with only an optional public login id', () => {
    const login = toolDefinitions.find(tool => tool.name === 'zen_login')!;
    expect(login.inputSchema).toEqual({
      type: 'object',
      properties: {
        login_id: { type: 'string', pattern: LOGIN_ID_SOURCE },
      },
      additionalProperties: false,
    });
    for (const forbidden of ['email', 'password', 'device_code', 'token', 'user_code']) {
      expect(JSON.stringify(login.inputSchema)).not.toContain(`\"${forbidden}\"`);
    }
  });

  it('delegates zen_login start and wait through the coordinator', async () => {
    const pending = {
      authenticated: false as const,
      pending: true as const,
      login_id: '00000000-0000-4000-8000-000000000000',
      verification_url: 'https://zen.test/device?code=ABCD-EFGH',
      expires_in: 600,
    };
    const coordinator = {
      start: vi.fn(async () => pending),
      wait: vi.fn(async () => ({ authenticated: true as const, email: 'u@example.com' })),
    } as unknown as ZenLoginCoordinator;
    const controller = new AbortController();

    await expect(handleZenLogin({}, controller.signal, coordinator)).resolves.toEqual(pending);
    await expect(handleZenLogin(
      { login_id: pending.login_id },
      controller.signal,
      coordinator,
    )).resolves.toEqual({ authenticated: true, email: 'u@example.com' });

    expect(coordinator.start).toHaveBeenCalledWith(controller.signal);
    expect(coordinator.wait).toHaveBeenCalledWith(pending.login_id, controller.signal);
  });

  it('does not expose provider, model, workdir, mode, or credential inputs', () => {
    const start = toolDefinitions.find(tool => tool.name === 'start_agent')!;
    const schema = JSON.stringify(start.inputSchema);
    for (const forbidden of ['provider', 'model', 'workdir', 'mode', 'api_key', 'email', 'password']) {
      expect(schema).not.toContain(`"${forbidden}"`);
    }
  });

  it('validates authentication through Zen usage', async () => {
    await expect(handleAuthStatus()).resolves.toEqual({
      authenticated: true,
      email: 'u@example.com',
      used_tokens: 1,
      quota_tokens: 100,
    });
  });

  it('routes every job operation through the Zen API client', async () => {
    await expect(handleStartAgent({ task: 'review this' })).resolves.toMatchObject({ job_id: 'job-1' });
    await expect(handleAgentStatus({ job_id: 'job-1' })).resolves.toMatchObject({ state: 'running' });
    await expect(handleProvideContext({
      job_id: 'job-1',
      request_id: 'ctx-1',
      items: [{ label: 'diff', source: 'git_diff', content: 'x', truncated: false }],
    })).resolves.toEqual({ ok: true });
    await expect(handleAgentResult({ job_id: 'job-1' })).resolves.toMatchObject({ summary: 'done' });
    await expect(handleCancelAgent({ job_id: 'job-1' })).resolves.toEqual({ ok: true });
    await expect(handleListAgents()).resolves.toHaveLength(1);
    expect(ZenAgentClient).toHaveBeenCalledWith('http://zen', 'session');
  });

  it('rejects empty and oversized tasks before creating a client request', async () => {
    await expect(handleStartAgent({ task: '' })).rejects.toThrow(/task/i);
    await expect(handleStartAgent({ task: 'x'.repeat(32 * 1024 + 1) })).rejects.toThrow(/32 KiB/i);
  });

  it('rejects undeclared MCP arguments instead of silently ignoring them', async () => {
    await expect(handleZenLogin({ email: 'u@example.com' })).rejects.toThrow(/unexpected.*email/i);
    await expect(handleStartAgent({ task: 'review', provider: 'codex' } as never)).rejects.toThrow(/unexpected.*provider/i);
    await expect(handleAgentStatus({ job_id: 'job-1', email: 'u@example.com' } as never)).rejects.toThrow(/unexpected.*email/i);
    await expect(handleAuthStatus({ password: 'secret' } as never)).rejects.toThrow(/unexpected.*password/i);
    await expect(handleListAgents({ mode: 'full' } as never)).rejects.toThrow(/unexpected.*mode/i);
  });

  it('rejects oversized context items and payloads', async () => {
    await expect(handleStartAgent({
      task: 'review',
      initial_context: [{ label: 'file', source: 'file', content: 'x'.repeat(64 * 1024 + 1), truncated: false }],
    })).rejects.toThrow(/64 KiB/i);

    await expect(handleStartAgent({
      task: 'review',
      initial_context: [{ label: 'x'.repeat(64 * 1024), source: 'file', content: 'x', truncated: false }],
    })).rejects.toThrow(/64 KiB/i);

    await expect(handleProvideContext({
      job_id: 'job-1',
      request_id: 'ctx-1',
      items: Array.from({ length: 5 }, (_, index) => ({
        label: `item-${index}`,
        source: 'other' as const,
        content: 'x'.repeat(60 * 1024),
        truncated: false,
      })),
    })).rejects.toThrow(/256 KiB/i);

    await expect(handleProvideContext({
      job_id: 'job-1',
      request_id: 'x'.repeat(256 * 1024),
      items: [],
    })).rejects.toThrow(/256 KiB/i);
  });

  it('requires the provide_context items field', async () => {
    await expect(handleProvideContext({ job_id: 'job-1', request_id: 'ctx-1' })).rejects.toThrow(/items.*required/i);
  });
});
