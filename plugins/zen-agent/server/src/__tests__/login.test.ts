import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ZenDeviceClient } from '../api.js';
import { readZenConfig, writeZenConfig } from '../config.js';
import { LOGIN_ID_SOURCE, LOGIN_WAIT_MAX_MS, ZenLoginCoordinator } from '../login.js';

const deviceClient = vi.hoisted(() => ({
  startDeviceLogin: vi.fn(),
  pollDeviceLogin: vi.fn(),
}));

vi.mock('../config.js', () => ({
  readZenConfig: vi.fn(async () => ({ baseUrl: 'http://zen' })),
  writeZenConfig: vi.fn(async (_config: unknown, beforeCommit?: () => void) => beforeCommit?.()),
  apiBase: vi.fn((config: { baseUrl?: string }) => config.baseUrl ?? 'https://zen.0xii.com'),
}));

vi.mock('../api.js', () => ({
  ZenDeviceClient: vi.fn(() => deviceClient),
}));

const grant = {
  device_code: 'a'.repeat(64),
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://zen.test/device',
  verification_uri_complete: 'https://zen.test/device?code=ABCD-EFGH',
  expires_in: 600,
  interval: 2,
};

const UUID_V4_PATTERN = new RegExp(LOGIN_ID_SOURCE);

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => '',
    error => error instanceof Error ? error.message : String(error),
  );
}

describe('ZenLoginCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deviceClient.startDeviceLogin.mockReset().mockResolvedValue(grant);
    deviceClient.pollDeviceLogin.mockReset();
    vi.mocked(readZenConfig).mockResolvedValue({ baseUrl: 'http://zen' });
    vi.mocked(writeZenConfig).mockReset().mockImplementation(
      async (_config, beforeCommit) => beforeCommit?.(),
    );
  });

  afterEach(() => vi.useRealTimers());

  it('starts a model-safe login without polling', async () => {
    const coordinator = new ZenLoginCoordinator(() => deviceClient);

    const result = await coordinator.start();

    expect(result).toEqual({
      authenticated: false,
      pending: true,
      login_id: expect.stringMatching(UUID_V4_PATTERN),
      verification_url: grant.verification_uri_complete,
      expires_in: 600,
    });
    expect(JSON.stringify(result)).not.toContain(grant.device_code);
    expect(JSON.stringify(result)).not.toContain('token');
    expect(deviceClient.pollDeviceLogin).not.toHaveBeenCalled();
    expect(ZenDeviceClient).not.toHaveBeenCalled();
  });

  it('waits with the stored device code and persists success', async () => {
    vi.useFakeTimers();
    deviceClient.pollDeviceLogin
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ token: 'secret-session-token', email: 'u@example.com' });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();

    const outcome = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(grant.interval * 2 * 1000);

    await expect(outcome).resolves.toEqual({ authenticated: true, email: 'u@example.com' });
    expect(deviceClient.pollDeviceLogin).toHaveBeenLastCalledWith(
      grant.device_code,
      expect.any(AbortSignal),
    );
    expect(writeZenConfig).toHaveBeenCalledWith(
      { baseUrl: 'http://zen', token: 'secret-session-token', email: 'u@example.com' },
      expect.any(Function),
    );
    await expect(rejectionMessage(coordinator.wait(started.login_id))).resolves.toBe(
      'Zen login is missing or expired. Start `zen login` again in this chat.',
    );
  });

  it('returns pending after the bounded wait window without extending expiry', async () => {
    vi.useFakeTimers();
    let pollSignal: AbortSignal | undefined;
    let resolvePoll!: (value: { token: string; email: string }) => void;
    deviceClient.pollDeviceLogin.mockImplementation((_deviceCode: string, signal?: AbortSignal) => {
      pollSignal = signal;
      return new Promise(resolve => { resolvePoll = resolve; });
    });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();
    const observed: unknown[] = [];

    const outcome = coordinator.wait(started.login_id);
    void outcome.then(result => observed.push(result));
    await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MAX_MS - 1);

    expect(observed).toEqual([]);
    expect(pollSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(observed).toEqual([{ ...started, expires_in: 555 }]);
    expect(pollSignal?.aborted).toBe(true);
    expect(deviceClient.pollDeviceLogin).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    resolvePoll({ token: 'late-secret-token', email: 'late@example.com' });
    await vi.advanceTimersByTimeAsync(0);

    expect(writeZenConfig).not.toHaveBeenCalled();
    expect(observed).toEqual([{ ...started, expires_in: 555 }]);
  });

  it('aborts a stalled poll at the device grant deadline', async () => {
    vi.useFakeTimers();
    deviceClient.startDeviceLogin.mockResolvedValue({ ...grant, expires_in: 4, interval: 3 });
    let pollSignal: AbortSignal | undefined;
    deviceClient.pollDeviceLogin.mockImplementation((_deviceCode: string, signal?: AbortSignal) => {
      pollSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error(`aborted ${grant.verification_uri_complete} ${grant.device_code}`));
        }, { once: true });
      });
    });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();
    const outcome = rejectionMessage(coordinator.wait(started.login_id));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(deviceClient.pollDeviceLogin).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pollSignal?.aborted).toBe(true);
    const message = await outcome;
    expect(message).toBe('Device login expired. Start `zen login` again in this chat.');
    for (const secret of [grant.verification_uri_complete, grant.user_code, grant.device_code]) {
      expect(message).not.toContain(secret);
    }
    expect(writeZenConfig).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resumes the same login after a pending window', async () => {
    vi.useFakeTimers();
    deviceClient.pollDeviceLogin
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ token: 'secret-session-token', email: 'u@example.com' });
    const coordinator = new ZenLoginCoordinator(() => deviceClient, 2_500);
    const started = await coordinator.start();

    const firstWait = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(firstWait).resolves.toMatchObject({
      authenticated: false,
      pending: true,
      login_id: started.login_id,
    });

    const secondWait = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);

    await expect(secondWait).resolves.toEqual({ authenticated: true, email: 'u@example.com' });
    expect(deviceClient.pollDeviceLogin).toHaveBeenCalledTimes(2);
    expect(deviceClient.pollDeviceLogin.mock.calls.map(call => call[0])).toEqual([
      grant.device_code,
      grant.device_code,
    ]);
  });

  it('removes a terminal error observed at the wait boundary before returning pending', async () => {
    vi.useFakeTimers();
    const terminalMessage = 'Device login was already completed. Start Zen login again.';
    deviceClient.pollDeviceLogin.mockImplementation((_deviceCode: string, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error(terminalMessage)), { once: true });
      }));
    const coordinator = new ZenLoginCoordinator(() => deviceClient, 2_500);
    const started = await coordinator.start();

    const outcome = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(outcome).resolves.toMatchObject({
      authenticated: false,
      pending: true,
      login_id: started.login_id,
    });
    const retryController = new AbortController();
    const retryMessage = rejectionMessage(coordinator.wait(started.login_id, retryController.signal));
    await vi.advanceTimersByTimeAsync(0);
    retryController.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expect(retryMessage).resolves.toBe(
      'Zen login is missing or expired. Start `zen login` again in this chat.',
    );
  });

  it('retains a login after a transient poll error and later succeeds', async () => {
    vi.useFakeTimers();
    deviceClient.pollDeviceLogin
      .mockRejectedValueOnce(new Error('Unable to reach Zen. Check your connection and try again.'))
      .mockResolvedValueOnce({ token: 'secret-session-token', email: 'u@example.com' });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();

    const firstMessage = rejectionMessage(coordinator.wait(started.login_id));
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);
    await expect(firstMessage).resolves.toBe('Unable to reach Zen. Check your connection and try again.');

    const resumed = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);
    await expect(resumed).resolves.toEqual({ authenticated: true, email: 'u@example.com' });
  });

  it('rejects malformed unknown and expired login ids without secrets', async () => {
    vi.useFakeTimers();
    const expiringGrant = { ...grant, expires_in: 3, interval: 3 };
    deviceClient.startDeviceLogin.mockResolvedValue(expiringGrant);
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();
    const unknownId = '00000000-0000-4000-8000-000000000000';

    const malformedMessage = await rejectionMessage(coordinator.wait(grant.device_code));
    const unknownMessage = await rejectionMessage(coordinator.wait(unknownId));
    await vi.advanceTimersByTimeAsync(3_000);
    const expiredMessage = await rejectionMessage(coordinator.wait(started.login_id));

    for (const message of [malformedMessage, unknownMessage, expiredMessage]) {
      expect(message).toBe('Zen login is missing or expired. Start `zen login` again in this chat.');
      for (const secret of [grant.device_code, grant.user_code, grant.verification_uri_complete, unknownId]) {
        expect(message).not.toContain(secret);
      }
    }
    expect(deviceClient.pollDeviceLogin).not.toHaveBeenCalled();
  });

  it('retains an unexpired login after request cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();

    const firstWait = rejectionMessage(coordinator.wait(started.login_id, controller.signal));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(firstWait).resolves.toBe('Zen login was cancelled.');
    expect(vi.getTimerCount()).toBe(0);
    expect(deviceClient.pollDeviceLogin).not.toHaveBeenCalled();

    deviceClient.pollDeviceLogin.mockResolvedValue({
      token: 'secret-session-token',
      email: 'u@example.com',
    });
    const resumed = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);
    await expect(resumed).resolves.toEqual({ authenticated: true, email: 'u@example.com' });
  });

  it('does not persist a poll result that resolves after request cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let pollSignal: AbortSignal | undefined;
    let resolvePoll!: (value: { token: string; email: string }) => void;
    deviceClient.pollDeviceLogin.mockImplementation((_deviceCode: string, signal?: AbortSignal) => {
      pollSignal = signal;
      return new Promise(resolve => { resolvePoll = resolve; });
    });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();
    const outcome = rejectionMessage(coordinator.wait(started.login_id, controller.signal));

    await vi.advanceTimersByTimeAsync(grant.interval * 1000);
    expect(deviceClient.pollDeviceLogin).toHaveBeenCalledOnce();
    controller.abort();
    expect(pollSignal?.aborted).toBe(true);
    resolvePoll({ token: 'secret-session-token', email: 'u@example.com' });
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toBe('Zen login was cancelled.');
    expect(writeZenConfig).not.toHaveBeenCalled();

    deviceClient.pollDeviceLogin.mockReset().mockResolvedValue({
      token: 'replacement-token',
      email: 'u@example.com',
    });
    const resumed = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);
    await expect(resumed).resolves.toEqual({ authenticated: true, email: 'u@example.com' });
  });

  it('rejects a concurrent wait for the same login id', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();
    const firstWait = rejectionMessage(coordinator.wait(started.login_id, controller.signal));

    const concurrentMessage = await rejectionMessage(coordinator.wait(started.login_id));

    expect(concurrentMessage).toBe('Zen login is already being monitored.');
    expect(concurrentMessage).not.toContain(started.login_id);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expect(firstWait).resolves.toBe('Zen login was cancelled.');
  });

  it('keeps different login ids isolated', async () => {
    vi.useFakeTimers();
    const grantB = {
      ...grant,
      device_code: 'b'.repeat(64),
      user_code: 'JKLM-NPQR',
      verification_uri_complete: 'https://zen.test/device?code=JKLM-NPQR',
    };
    const clientA = {
      startDeviceLogin: vi.fn(async () => grant),
      pollDeviceLogin: vi.fn(async () => ({ token: 'token-a', email: 'a@example.com' })),
    };
    const clientB = {
      startDeviceLogin: vi.fn(async () => grantB),
      pollDeviceLogin: vi.fn(async () => ({ token: 'token-b', email: 'b@example.com' })),
    };
    const factory = vi.fn()
      .mockReturnValueOnce(clientA)
      .mockReturnValueOnce(clientB);
    const coordinator = new ZenLoginCoordinator(factory);
    const startedA = await coordinator.start();
    const startedB = await coordinator.start();

    const outcomeA = coordinator.wait(startedA.login_id);
    const outcomeB = coordinator.wait(startedB.login_id);
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);

    await expect(outcomeA).resolves.toEqual({ authenticated: true, email: 'a@example.com' });
    await expect(outcomeB).resolves.toEqual({ authenticated: true, email: 'b@example.com' });
    expect(clientA.pollDeviceLogin).toHaveBeenCalledWith(grant.device_code, expect.any(AbortSignal));
    expect(clientB.pollDeviceLogin).toHaveBeenCalledWith(grantB.device_code, expect.any(AbortSignal));
  });

  it('removes a login after a terminal device error', async () => {
    vi.useFakeTimers();
    const terminalMessages = [
      'Device login expired. Start Zen login again.',
      'Device login was not found. Start Zen login again.',
      'Device login was already completed. Start Zen login again.',
    ];
    const coordinator = new ZenLoginCoordinator(() => deviceClient);

    for (const terminalMessage of terminalMessages) {
      deviceClient.pollDeviceLogin.mockRejectedValueOnce(new Error(terminalMessage));
      const started = await coordinator.start();
      const outcome = rejectionMessage(coordinator.wait(started.login_id));
      await vi.advanceTimersByTimeAsync(grant.interval * 1000);

      await expect(outcome).resolves.toBe(terminalMessage);
      await expect(rejectionMessage(coordinator.wait(started.login_id))).resolves.toBe(
        'Zen login is missing or expired. Start `zen login` again in this chat.',
      );
    }
  });

  it('does not commit when cancellation reaches a deferred writer before beforeCommit', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    deviceClient.pollDeviceLogin.mockResolvedValue({
      token: 'secret-session-token',
      email: 'u@example.com',
    });
    let releaseWriter!: () => void;
    let committed = false;
    vi.mocked(writeZenConfig).mockImplementation(async (_config, beforeCommit) => {
      await new Promise<void>(resolve => { releaseWriter = resolve; });
      beforeCommit?.();
      committed = true;
    });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();
    const outcome = rejectionMessage(coordinator.wait(started.login_id, controller.signal));
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);

    controller.abort();
    releaseWriter();
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toBe('Zen login was cancelled.');
    expect(committed).toBe(false);
  });

  it('returns success when cancellation arrives after the commit linearization point', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    deviceClient.pollDeviceLogin.mockResolvedValue({
      token: 'secret-session-token',
      email: 'u@example.com',
    });
    let committed = false;
    vi.mocked(writeZenConfig).mockImplementation(async (_config, beforeCommit) => {
      beforeCommit?.();
      committed = true;
      controller.abort();
    });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();

    const outcome = coordinator.wait(started.login_id, controller.signal);
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);

    await expect(outcome).resolves.toEqual({ authenticated: true, email: 'u@example.com' });
    expect(committed).toBe(true);
  });

  it('allows an in-window token to finish atomic persistence after the wait window', async () => {
    vi.useFakeTimers();
    let pollSignal: AbortSignal | undefined;
    deviceClient.pollDeviceLogin.mockImplementation((_deviceCode: string, signal?: AbortSignal) => {
      pollSignal = signal;
      return Promise.resolve({ token: 'secret-session-token', email: 'u@example.com' });
    });
    let releaseWriter!: () => void;
    vi.mocked(writeZenConfig).mockImplementation(async (_config, beforeCommit) => {
      await new Promise<void>(resolve => { releaseWriter = resolve; });
      beforeCommit?.();
    });
    const coordinator = new ZenLoginCoordinator(() => deviceClient);
    const started = await coordinator.start();

    const outcome = coordinator.wait(started.login_id);
    await vi.advanceTimersByTimeAsync(grant.interval * 1000);
    expect(writeZenConfig).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MAX_MS - grant.interval * 1000 + 1);
    expect(pollSignal?.aborted).toBe(true);
    releaseWriter();
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toEqual({ authenticated: true, email: 'u@example.com' });
  });
});
