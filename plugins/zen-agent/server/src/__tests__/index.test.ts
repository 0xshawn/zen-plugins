import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_WAIT_DEADLINE_MS,
  AGENT_WAIT_POLL_INTERVAL_MS,
  handleAgentResult,
  handleAgentStatus,
  handleAuthStatus,
  handleAgentWait,
  handleCancelAgent,
  handleListAgents,
  handleProvideContext,
  handleStartAgent,
  handleZenLogin,
  serializeToolResponse,
  SERVER_NAME,
  toolDefinitions,
} from '../index.js';
import { ZenAgentClient } from '../api.js';
import { LOGIN_ID_SOURCE, type ZenLoginCoordinator } from '../login.js';

const apiMocks = vi.hoisted(() => ({
  authStatus: vi.fn(),
  startAgent: vi.fn(),
  agentStatus: vi.fn(),
  provideContext: vi.fn(),
  agentResult: vi.fn(),
  cancelAgent: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadZenSession: vi.fn(async () => ({ token: 'session', baseUrl: 'http://zen', email: 'u@example.com' })),
  readZenConfig: vi.fn(async () => ({ baseUrl: 'http://zen' })),
  writeZenConfig: vi.fn(async (_config: unknown, beforeCommit?: () => void) => beforeCommit?.()),
  apiBase: vi.fn((config: { baseUrl?: string }) => config.baseUrl ?? 'https://zen.0xii.com'),
}));

vi.mock('../api.js', () => ({
  ZenAgentClient: vi.fn(() => apiMocks),
  ZenDeviceClient: vi.fn(),
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Zen Agent MCP handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.authStatus.mockResolvedValue({ used_tokens: 1, quota_tokens: 100 });
    apiMocks.startAgent.mockResolvedValue({ job_id: 'job-1', state: 'queued' });
    apiMocks.agentStatus.mockResolvedValue({ job_id: 'job-1', agent: 'claude', state: 'running' });
    apiMocks.provideContext.mockResolvedValue(undefined);
    apiMocks.agentResult.mockResolvedValue({
      summary: 'done', findings: [], tests: [], assumptions: [], remaining_questions: [],
    });
    apiMocks.cancelAgent.mockResolvedValue(undefined);
    apiMocks.listAgents.mockResolvedValue([{ job_id: 'job-1', agent: 'codex', state: 'running' }]);
  });

  it('uses the canonical MCP server name', () => {
    expect(SERVER_NAME).toBe('zen-agent');
  });

  it('advertises exactly the nine Zen agent tools', () => {
    expect(toolDefinitions.map(tool => tool.name)).toEqual([
      'zen_login',
      'auth_status',
      'start_agent',
      'agent_status',
      'provide_context',
      'agent_result',
      'agent_wait',
      'cancel_agent',
      'list_agents',
    ]);
  });

  it('exposes agent_wait with only a required job id', () => {
    const wait = toolDefinitions.find(tool => tool.name === 'agent_wait')!;
    expect(wait.inputSchema).toEqual({
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    });
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

  it('exposes a closed Codex or Claude agent selection', () => {
    const start = toolDefinitions.find(tool => tool.name === 'start_agent')!;
    expect(start.inputSchema.properties).toMatchObject({
      agent: { type: 'string', enum: ['codex', 'claude'] },
    });
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
    await expect(handleStartAgent({ task: 'review this' })).resolves.toEqual({
      job_id: 'job-1', state: 'queued', agent: 'codex',
    });
    expect(apiMocks.startAgent).toHaveBeenCalledWith({
      task: 'review this', initial_context: [], agent: 'codex',
    });
    await expect(handleAgentStatus({ job_id: 'job-1' })).resolves.toMatchObject({ agent: 'claude', state: 'running' });
    await expect(handleProvideContext({
      job_id: 'job-1',
      request_id: 'ctx-1',
      items: [{ label: 'diff', source: 'git_diff', content: 'x', truncated: false }],
    })).resolves.toEqual({ ok: true });
    await expect(handleAgentResult({ job_id: 'job-1' })).resolves.toMatchObject({ summary: 'done' });
    await expect(handleCancelAgent({ job_id: 'job-1' })).resolves.toEqual({ ok: true });
    await expect(handleListAgents()).resolves.toEqual([{ job_id: 'job-1', agent: 'codex', state: 'running' }]);
    expect(ZenAgentClient).toHaveBeenCalledWith('http://zen', 'session');
  });

  it('waits through queued and running states, then fetches one terminal result', async () => {
    vi.useFakeTimers();
    try {
      const signal = new AbortController().signal;
      const done = { job_id: 'job-1', agent: 'codex' as const, state: 'done' as const, elapsed_ms: 12 };
      apiMocks.agentStatus
        .mockResolvedValueOnce({ job_id: 'job-1', state: 'queued' as const })
        .mockResolvedValueOnce({ job_id: 'job-1', state: 'running' as const })
        .mockResolvedValueOnce(done);
      apiMocks.agentResult.mockResolvedValueOnce({
        summary: 'finished', findings: [], tests: [], assumptions: [], remaining_questions: [],
      });

      const pending = handleAgentWait({ job_id: 'job-1' }, signal);
      await flushMicrotasks();
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(AGENT_WAIT_POLL_INTERVAL_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(AGENT_WAIT_POLL_INTERVAL_MS);

      await expect(pending).resolves.toEqual({
        ...done,
        result: {
          summary: 'finished', findings: [], tests: [], assumptions: [], remaining_questions: [],
        },
      });
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(3);
      expect(ZenAgentClient).toHaveBeenCalledTimes(1);
      const waitSignal = apiMocks.agentStatus.mock.calls[0]?.[1];
      expect(waitSignal).toBeInstanceOf(AbortSignal);
      expect(waitSignal).not.toBe(signal);
      expect(apiMocks.agentStatus.mock.calls[1]?.[1]).toBe(waitSignal);
      expect(apiMocks.agentStatus.mock.calls[2]?.[1]).toBe(waitSignal);
      expect(apiMocks.agentResult).toHaveBeenCalledTimes(1);
      expect(apiMocks.agentResult.mock.calls[0]?.[1]).toBe(waitSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns waiting_for_context without fetching a result', async () => {
    apiMocks.agentStatus.mockResolvedValueOnce({
      job_id: 'job-1', state: 'waiting_for_context' as const,
      context_request: { request_id: 'ctx-1', reason: 'need diff', requests: [] },
    });

    await expect(handleAgentWait({ job_id: 'job-1' })).resolves.toEqual({
      job_id: 'job-1', state: 'waiting_for_context',
      context_request: { request_id: 'ctx-1', reason: 'need diff', requests: [] },
    });
    expect(apiMocks.agentResult).not.toHaveBeenCalled();
    expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'cancelled', 'expired'] as const)(
    'returns %s without fetching a result', async state => {
      apiMocks.agentStatus.mockResolvedValueOnce({ job_id: 'job-1', state });

      await expect(handleAgentWait({ job_id: 'job-1' })).resolves.toEqual({ job_id: 'job-1', state });
      expect(apiMocks.agentResult).not.toHaveBeenCalled();
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);
    },
  );

  it('waits between running polls and rejects at the bounded deadline', async () => {
    vi.useFakeTimers();
    try {
      apiMocks.agentStatus.mockResolvedValue({ job_id: 'job-1', state: 'running' as const });
      const pending = handleAgentWait({ job_id: 'job-1' });
      const rejected = expect(pending).rejects.toThrow(/timed out.*job remains active/i);
      await flushMicrotasks();
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(AGENT_WAIT_POLL_INTERVAL_MS);
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(AGENT_WAIT_DEADLINE_MS - AGENT_WAIT_POLL_INTERVAL_MS);

      await rejected;
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(AGENT_WAIT_DEADLINE_MS / AGENT_WAIT_POLL_INTERVAL_MS);
      expect(apiMocks.cancelAgent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an aborted wait during the poll delay without another status request', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      apiMocks.agentStatus.mockResolvedValueOnce({ job_id: 'job-1', state: 'running' as const });
      const pending = handleAgentWait({ job_id: 'job-1' }, controller.signal);
      await flushMicrotasks();
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);

      controller.abort();
      await expect(pending).rejects.toThrow(/abort/i);
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a stalled initial status request without cancelling the remote job', async () => {
    vi.useFakeTimers();
    try {
      apiMocks.agentStatus.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = handleAgentWait({ job_id: 'job-1' });
      const rejected = expect(pending).rejects.toThrow(/timed out.*job remains active/i);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(AGENT_WAIT_DEADLINE_MS);
      await rejected;
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);
      expect(apiMocks.cancelAgent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a stalled terminal result request without cancelling the remote job', async () => {
    vi.useFakeTimers();
    try {
      apiMocks.agentStatus.mockResolvedValueOnce({ job_id: 'job-1', state: 'done' as const });
      apiMocks.agentResult.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = handleAgentWait({ job_id: 'job-1' });
      const rejected = expect(pending).rejects.toThrow(/timed out.*job remains active/i);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(AGENT_WAIT_DEADLINE_MS);
      await rejected;
      expect(apiMocks.agentStatus).toHaveBeenCalledTimes(1);
      expect(apiMocks.agentResult).toHaveBeenCalledTimes(1);
      expect(apiMocks.cancelAgent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes tool output compactly and handles non-JSON values', () => {
    expect(serializeToolResponse({ state: 'done', result: { summary: 'ok' } }))
      .toBe(JSON.stringify({ state: 'done', result: { summary: 'ok' } }));
    expect(serializeToolResponse({ token_count: 2n })).toBe('{"token_count":"2"}');
  });

  it('returns a compact fallback when tool output cannot be serialized', () => {
    const value = {
      toJSON: () => { throw new Error('cannot serialize'); },
      toString: () => { throw new Error('cannot stringify'); },
    };
    expect(() => serializeToolResponse(value)).not.toThrow();
    expect(serializeToolResponse(value)).toBe('{"error":"Unable to serialize tool response."}');
  });

  it('sends an explicit Claude selection and preserves the response agent', async () => {
    apiMocks.startAgent.mockResolvedValueOnce({ job_id: 'job-2', state: 'queued', agent: 'claude' });

    await expect(handleStartAgent({ task: 'review', agent: 'claude' })).resolves.toEqual({
      job_id: 'job-2', state: 'queued', agent: 'claude',
    });
    expect(apiMocks.startAgent).toHaveBeenCalledWith({
      task: 'review', initial_context: [], agent: 'claude',
    });
  });

  it.each(['', 'openai', 'Claude', null, 1])('rejects invalid agent value %j', async agent => {
    await expect(handleStartAgent({ task: 'review', agent })).rejects.toThrow(/agent.*codex.*claude/i);
    expect(apiMocks.startAgent).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { job_id: 'job-2', state: 'queued' }, false],
    ['mismatched', { job_id: 'job-2', state: 'queued', agent: 'codex' }, true],
  ])('rejects a Claude response with a %s agent and cancels the job', async (_case, created, cancelFails) => {
    apiMocks.startAgent.mockResolvedValueOnce(created);
    if (cancelFails) apiMocks.cancelAgent.mockRejectedValueOnce(new Error('cancel failed'));

    await expect(handleStartAgent({ task: 'review', agent: 'claude' }))
      .rejects.toThrow('Zen server does not support Claude jobs yet.');
    expect(apiMocks.cancelAgent).toHaveBeenCalledWith('job-2');
  });

  it('rejects empty and oversized tasks before creating a client request', async () => {
    await expect(handleStartAgent({ task: '' })).rejects.toThrow(/task/i);
    await expect(handleStartAgent({ task: 'x'.repeat(32 * 1024 + 1) })).rejects.toThrow(/32 KiB/i);
  });

  it('rejects undeclared MCP arguments instead of silently ignoring them', async () => {
    await expect(handleZenLogin({ email: 'u@example.com' })).rejects.toThrow(/unexpected.*email/i);
    await expect(handleStartAgent({ task: 'review', provider: 'codex' } as never)).rejects.toThrow(/unexpected.*provider/i);
    await expect(handleAgentStatus({ job_id: 'job-1', email: 'u@example.com' } as never)).rejects.toThrow(/unexpected.*email/i);
    await expect(handleAgentWait({ job_id: 'job-1', mode: 'full' } as never)).rejects.toThrow(/unexpected.*mode/i);
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
