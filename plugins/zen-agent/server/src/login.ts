import { randomUUID } from 'node:crypto';

import { ZenDeviceClient } from './api.js';
import { apiBase, readZenConfig, writeZenConfig, type ZenConfig } from './config.js';
import type { DeviceStartResponse, DeviceTokenResponse } from './contracts.js';

export const LOGIN_WAIT_MAX_MS = 45_000;
export const LOGIN_ID_SOURCE =
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const LOGIN_ID_PATTERN = new RegExp(LOGIN_ID_SOURCE);
const LOGIN_CANCELLED = 'Zen login was cancelled.';
const LOGIN_EXPIRED = 'Device login expired. Start `zen login` again in this chat.';
const LOGIN_NOT_FOUND = 'Zen login is missing or expired. Start `zen login` again in this chat.';
const LOGIN_ALREADY_WAITING = 'Zen login is already being monitored.';

type DeviceClient = Pick<ZenDeviceClient, 'startDeviceLogin' | 'pollDeviceLogin'>;
export type DeviceClientFactory = (baseUrl: string) => DeviceClient;

export interface PendingLoginResult {
  authenticated: false;
  pending: true;
  login_id: string;
  verification_url: string;
  expires_in: number;
}

export type ZenLoginResult =
  | PendingLoginResult
  | { authenticated: true; email: string };

interface PendingLogin {
  config: ZenConfig;
  device: DeviceClient;
  grant: DeviceStartResponse;
  expiresAt: number;
  waiting: boolean;
}

type PollOutcome =
  | { kind: 'response'; response: DeviceTokenResponse }
  | { kind: 'error'; error: unknown }
  | { kind: 'aborted' };

export class ZenLoginCoordinator {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly deviceFactory: DeviceClientFactory = baseUrl => new ZenDeviceClient(baseUrl),
    private readonly waitWindowMs = LOGIN_WAIT_MAX_MS,
  ) {}

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [loginId, login] of this.pending) {
      if (login.expiresAt <= now) this.pending.delete(loginId);
    }
  }

  private pendingResult(loginId: string, login: PendingLogin): PendingLoginResult {
    return {
      authenticated: false,
      pending: true,
      login_id: loginId,
      verification_url: login.grant.verification_uri_complete,
      expires_in: Math.max(0, Math.ceil((login.expiresAt - Date.now()) / 1000)),
    };
  }

  async start(requestSignal?: AbortSignal): Promise<PendingLoginResult> {
    assertRequestActive(requestSignal);
    this.cleanupExpired();
    const config = await readZenConfig();
    const device = this.deviceFactory(apiBase(config));
    let grant: DeviceStartResponse;
    try {
      grant = await device.startDeviceLogin(requestSignal);
    } catch (error) {
      assertRequestActive(requestSignal);
      throw error;
    }
    assertRequestActive(requestSignal);

    const loginId = randomUUID();
    const login: PendingLogin = {
      config,
      device,
      grant,
      expiresAt: Date.now() + grant.expires_in * 1000,
      waiting: false,
    };
    this.pending.set(loginId, login);
    return this.pendingResult(loginId, login);
  }

  async wait(loginId: string, requestSignal?: AbortSignal): Promise<ZenLoginResult> {
    assertRequestActive(requestSignal);
    this.cleanupExpired();
    if (!LOGIN_ID_PATTERN.test(loginId)) throw new Error(LOGIN_NOT_FOUND);
    const login = this.pending.get(loginId);
    if (!login) throw new Error(LOGIN_NOT_FOUND);
    if (login.waiting) throw new Error(LOGIN_ALREADY_WAITING);
    if (Date.now() >= login.expiresAt) {
      this.pending.delete(loginId);
      throw new Error(LOGIN_EXPIRED);
    }

    login.waiting = true;
    const operationController = new AbortController();
    const abortOperation = () => operationController.abort();
    requestSignal?.addEventListener('abort', abortOperation, { once: true });
    const windowEndsAt = Math.min(login.expiresAt, Date.now() + this.waitWindowMs);
    const deadline = setTimeout(abortOperation, Math.max(0, windowEndsAt - Date.now()));
    let commitAuthorized = false;

    try {
      while (Date.now() < windowEndsAt) {
        const waitMs = Math.min(
          login.grant.interval * 1000,
          windowEndsAt - Date.now(),
        );
        try {
          await delay(waitMs, operationController.signal);
        } catch {
          assertRequestActive(requestSignal);
          if (Date.now() >= login.expiresAt) {
            this.pending.delete(loginId);
            throw new Error(LOGIN_EXPIRED);
          }
          if (Date.now() >= windowEndsAt) return this.pendingResult(loginId, login);
          throw new Error(LOGIN_CANCELLED);
        }

        assertRequestActive(requestSignal);
        if (Date.now() >= login.expiresAt) {
          this.pending.delete(loginId);
          throw new Error(LOGIN_EXPIRED);
        }
        if (Date.now() >= windowEndsAt) return this.pendingResult(loginId, login);

        const pollOutcome = await observePoll(
          login.device.pollDeviceLogin(
            login.grant.device_code,
            operationController.signal,
          ),
          operationController.signal,
        );
        if (pollOutcome.kind === 'aborted') {
          assertRequestActive(requestSignal);
          if (Date.now() >= login.expiresAt) {
            this.pending.delete(loginId);
            throw new Error(LOGIN_EXPIRED);
          }
          if (Date.now() >= windowEndsAt) return this.pendingResult(loginId, login);
          throw new Error(LOGIN_CANCELLED);
        }
        if (pollOutcome.kind === 'error') {
          if (isTerminalDeviceError(pollOutcome.error)) this.pending.delete(loginId);
          assertRequestActive(requestSignal);
          if (Date.now() >= login.expiresAt) {
            this.pending.delete(loginId);
            throw new Error(LOGIN_EXPIRED);
          }
          if (Date.now() >= windowEndsAt) return this.pendingResult(loginId, login);
          throw pollOutcome.error;
        }

        assertRequestActive(requestSignal);
        if (Date.now() >= login.expiresAt) {
          this.pending.delete(loginId);
          throw new Error(LOGIN_EXPIRED);
        }
        if (Date.now() >= windowEndsAt) return this.pendingResult(loginId, login);
        const response = pollOutcome.response;
        if ('status' in response) continue;

        // The 45-second window bounds network polling only. Once a token is observed
        // inside it, finish the atomic write so the one-time token is not discarded.
        await writeZenConfig(
          { ...login.config, token: response.token, email: response.email },
          () => {
            assertRequestActive(requestSignal);
            if (Date.now() >= login.expiresAt) throw new Error(LOGIN_EXPIRED);
            commitAuthorized = true;
          },
        );
        this.pending.delete(loginId);
        return { authenticated: true, email: response.email };
      }

      if (Date.now() >= login.expiresAt) {
        this.pending.delete(loginId);
        throw new Error(LOGIN_EXPIRED);
      }
      return this.pendingResult(loginId, login);
    } catch (error) {
      if (!commitAuthorized) assertRequestActive(requestSignal);
      if (error instanceof Error && error.message === LOGIN_EXPIRED) {
        this.pending.delete(loginId);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      requestSignal?.removeEventListener('abort', abortOperation);
      if (this.pending.get(loginId) === login) login.waiting = false;
    }
  }
}

function assertRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(LOGIN_CANCELLED);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(LOGIN_CANCELLED));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error(LOGIN_CANCELLED));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function observePoll(poll: Promise<DeviceTokenResponse>, signal: AbortSignal): Promise<PollOutcome> {
  return new Promise(resolve => {
    const onAbort = () => {
      // Let an abort-triggered poll rejection settle first so terminal errors
      // can remove their flow before the wait returns pending.
      queueMicrotask(() => resolve({ kind: 'aborted' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void poll.then(
      response => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'response', response });
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'error', error });
      },
    );
  });
}

function isTerminalDeviceError(error: unknown): boolean {
  return error instanceof Error && [
    'Device login expired. Start Zen login again.',
    'Device login was not found. Start Zen login again.',
    'Device login was already completed. Start Zen login again.',
  ].includes(error.message);
}
