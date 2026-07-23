import { describe, expect, it, vi } from 'vitest';

import { ZenAgentClient, ZenDeviceClient } from '../api.js';

const DEVICE_CODE = 'a'.repeat(64);
const DEVICE_GRANT = {
  device_code: DEVICE_CODE,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://zen.test/device',
  verification_uri_complete: 'https://zen.test/device?code=ABCD-EFGH',
  expires_in: 600,
  interval: 2,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ZenAgentClient', () => {
  it('sends the Zen Bearer token and correct methods and paths', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/result')) {
        return jsonResponse(200, { summary: 'done', findings: [], tests: [], assumptions: [], remaining_questions: [] });
      }
      if (path === '/api/agent/jobs' && init?.method !== 'POST') return jsonResponse(200, []);
      if (path === '/api/user/usage') return jsonResponse(200, { used_tokens: 1, quota_tokens: 2 });
      return jsonResponse(200, { job_id: 'job-1', state: init?.method === 'DELETE' ? 'cancelled' : 'running' });
    });
    const client = new ZenAgentClient('http://zen/', 'session-token', fetcher as typeof fetch);

    await client.authStatus();
    await client.startAgent({ task: 'review', initial_context: [] });
    await client.agentStatus('job-1');
    await client.provideContext('job-1', { request_id: 'ctx-1', items: [] });
    await client.agentResult('job-1');
    await client.cancelAgent('job-1');
    await client.listAgents();

    expect(fetcher).toHaveBeenCalledTimes(7);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-token');
    }
    expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method ?? 'GET'])).toEqual([
      ['/api/user/usage', 'GET'],
      ['/api/agent/jobs', 'POST'],
      ['/api/agent/jobs/job-1', 'GET'],
      ['/api/agent/jobs/job-1/context', 'POST'],
      ['/api/agent/jobs/job-1/result', 'GET'],
      ['/api/agent/jobs/job-1', 'DELETE'],
      ['/api/agent/jobs', 'GET'],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ task: 'review', initial_context: [] });
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual({ request_id: 'ctx-1', items: [] });
  });

  it.each([
    [401, 'unauthorized', /run `zen login` in this chat/i],
    [402, 'quota exceeded', /quota/i],
    [404, 'not found', /not found/i],
    [409, 'stale context request', /stale context request/i],
    [413, 'payload too large', /too large/i],
    [429, 'too many requests', /too many/i],
    [502, 'bad gateway', /unavailable/i],
    [503, 'service unavailable', /unavailable/i],
  ])('maps HTTP %i to actionable errors', async (status, body, expected) => {
    const client = new ZenAgentClient(
      'http://zen',
      'session',
      vi.fn(async () => jsonResponse(status, { error: body })) as typeof fetch,
    );
    await expect(client.agentStatus('job-1')).rejects.toThrow(expected);
  });

  it('falls back to the HTTP status when an error body is not JSON', async () => {
    const client = new ZenAgentClient(
      'http://zen',
      'session',
      vi.fn(async () => new Response('nope', { status: 500 })) as typeof fetch,
    );
    await expect(client.agentStatus('job-1')).rejects.toThrow(/HTTP 500/i);
  });

  it('accepts empty 204 responses for context and cancellation', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/context') || path.includes('/api/agent/jobs/job-1')) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(200, { job_id: 'job-1', state: 'running' });
    });
    const client = new ZenAgentClient('http://zen', 'session', fetcher as typeof fetch);

    await expect(client.provideContext('job-1', { request_id: 'ctx-1', items: [] })).resolves.toBeUndefined();
    await expect(client.cancelAgent('job-1')).resolves.toBeUndefined();
  });
});

describe('ZenDeviceClient', () => {
  it('starts a device login without authentication', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse(201, DEVICE_GRANT));
    const client = new ZenDeviceClient('http://zen/', fetcher as typeof fetch);
    const signal = new AbortController().signal;

    await expect(client.startDeviceLogin(signal)).resolves.toEqual(DEVICE_GRANT);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/api/auth/device/start');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('polls with only the secret device code and handles pending and success', async () => {
    const responses = [
      jsonResponse(202, { status: 'pending' }),
      jsonResponse(200, { token: 'session-token', email: 'user@example.com' }),
    ];
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => responses.shift()!);
    const client = new ZenDeviceClient('http://zen', fetcher as typeof fetch);
    const signal = new AbortController().signal;

    await expect(client.pollDeviceLogin(DEVICE_CODE, signal)).resolves.toEqual({ status: 'pending' });
    await expect(client.pollDeviceLogin(DEVICE_CODE, signal)).resolves.toEqual({
      token: 'session-token',
      email: 'user@example.com',
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).pathname).toBe('/api/auth/device/token');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBe(signal);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ device_code: DEVICE_CODE });
    }
  });

  it.each([
    ['uppercase device code', { device_code: 'A'.repeat(64) }],
    ['invalid user code', { user_code: 'ABCI-0000' }],
    ['wrong expiry', { expires_in: 599 }],
    ['wrong interval', { interval: 3 }],
    ['invalid verification URL', { verification_uri: 'file:///tmp/device' }],
    ['invalid complete URL', { verification_uri_complete: 'file:///tmp/device?code=ABCD-EFGH' }],
    ['mismatched complete origin', { verification_uri_complete: 'https://other.test/device?code=ABCD-EFGH' }],
    ['mismatched complete path', { verification_uri_complete: 'https://zen.test/other?code=ABCD-EFGH' }],
    ['verification URL userinfo', { verification_uri: 'https://user:pass@zen.test/device' }],
    ['complete URL userinfo', { verification_uri_complete: 'https://user:pass@zen.test/device?code=ABCD-EFGH' }],
    ['verification URL hash', { verification_uri: 'https://zen.test/device#fragment' }],
    ['complete URL hash', { verification_uri_complete: 'https://zen.test/device?code=ABCD-EFGH#fragment' }],
    ['verification URL query', { verification_uri: 'https://zen.test/device?source=plugin' }],
    ['extra complete query', { verification_uri_complete: 'https://zen.test/device?code=ABCD-EFGH&source=plugin' }],
    ['wrong public code', { verification_uri_complete: 'https://zen.test/device?code=WXYZ-2345' }],
    ['device secret in URL', { verification_uri_complete: `https://zen.test/device?code=ABCD-EFGH&secret=${DEVICE_CODE}` }],
  ])('rejects %s in a device start response', async (_name, patch) => {
    const client = new ZenDeviceClient(
      'http://zen',
      vi.fn(async () => jsonResponse(201, { ...DEVICE_GRANT, ...patch })) as typeof fetch,
    );

    const message = await rejectionMessage(client.startDeviceLogin());

    expect(message).toMatch(/invalid device login response/i);
    expect(message).not.toContain(DEVICE_CODE);
  });

  it('sanitizes malformed device start responses', async () => {
    const secretCode = DEVICE_CODE;
    const client = new ZenDeviceClient(
      'http://zen',
      vi.fn(async () => new Response(secretCode, { status: 201 })) as typeof fetch,
    );

    const message = await rejectionMessage(client.startDeviceLogin());

    expect(message).toMatch(/invalid device login response/i);
    expect(message).not.toContain(secretCode);
  });

  it('sanitizes malformed device token responses', async () => {
    const secretCode = DEVICE_CODE;
    const secretToken = 'secret-session-token';
    const client = new ZenDeviceClient(
      'http://zen',
      vi.fn(async () => jsonResponse(200, { device_code: secretCode, token: secretToken })) as typeof fetch,
    );

    const message = await rejectionMessage(client.pollDeviceLogin(secretCode));

    expect(message).toMatch(/invalid device login response/i);
    expect(message).not.toContain(secretCode);
    expect(message).not.toContain(secretToken);
  });

  it.each([
    [400, /expired/i],
    [404, /not found/i],
    [409, /already completed/i],
  ])('returns a credential-free message for HTTP %i', async (status, expected) => {
    const secretCode = DEVICE_CODE;
    const secretToken = 'secret-session-token';
    const client = new ZenDeviceClient(
      'http://zen',
      vi.fn(async () => jsonResponse(status, { error: `${secretCode} ${secretToken}` })) as typeof fetch,
    );

    const message = await rejectionMessage(client.pollDeviceLogin(secretCode));

    expect(message).toMatch(expected);
    expect(message).not.toContain(secretCode);
    expect(message).not.toContain(secretToken);
  });

  it('sanitizes network errors without exposing request secrets', async () => {
    const secretCode = DEVICE_CODE;
    const secretToken = 'secret-session-token';
    const client = new ZenDeviceClient(
      'http://zen',
      vi.fn(async () => {
        throw new Error(`network failed for ${secretCode} with ${secretToken}`);
      }) as typeof fetch,
    );

    const message = await rejectionMessage(client.pollDeviceLogin(secretCode));

    expect(message).toMatch(/unable to reach zen/i);
    expect(message).not.toContain(secretCode);
    expect(message).not.toContain(secretToken);
  });
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected promise to reject');
}
