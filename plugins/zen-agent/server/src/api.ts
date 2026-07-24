import type {
  AgentResult,
  CreateJobRequest,
  CreateJobResponse,
  DeviceStartResponse,
  DeviceTokenResponse,
  JobStatus,
  ProvideContextRequest,
  UsageResponse,
} from './contracts.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function responseError(response: Response): Promise<string> {
  let serverMessage: string | undefined;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string') serverMessage = body.error;
  } catch {
    // Use the status fallback below.
  }

  switch (response.status) {
    case 401:
      return 'Zen session missing or expired. Run `zen login` in this chat.';
    case 402:
      return 'Zen quota exceeded.';
    case 404:
      return 'Agent job not found.';
    case 409:
      return serverMessage ?? 'Agent job state conflict.';
    case 413:
      return serverMessage ?? 'Agent task or context is too large.';
    case 429:
      return serverMessage ?? 'Too many active agent jobs.';
    case 502:
    case 503:
      return 'Zen agent runner is unavailable. Try again later.';
    default:
      return serverMessage ?? `HTTP ${response.status}`;
  }
}

function deviceResponseError(status: number): string {
  switch (status) {
    case 400:
      return 'Device login expired. Start Zen login again.';
    case 404:
      return 'Device login was not found. Start Zen login again.';
    case 409:
      return 'Device login was already completed. Start Zen login again.';
    case 429:
      return 'Too many device login attempts. Try again later.';
    case 502:
    case 503:
      return 'Zen device login is unavailable. Try again later.';
    default:
      return `Zen device login failed (HTTP ${status}).`;
  }
}

const INVALID_DEVICE_RESPONSE = 'Zen returned an invalid device login response. Try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDeviceStartResponse(value: unknown): value is DeviceStartResponse {
  if (!isRecord(value)
    || typeof value.device_code !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.device_code)
    || typeof value.user_code !== 'string'
    || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(value.user_code)
    || typeof value.verification_uri !== 'string'
    || typeof value.verification_uri_complete !== 'string'
    || value.expires_in !== 600
    || value.interval !== 2) {
    return false;
  }

  const verificationUrl = httpUrl(value.verification_uri);
  const completeUrl = httpUrl(value.verification_uri_complete);
  if (!verificationUrl || !completeUrl) return false;
  if (hasUrlCredentialsOrHash(verificationUrl)
    || hasUrlCredentialsOrHash(completeUrl)
    || verificationUrl.search !== ''
    || completeUrl.origin !== verificationUrl.origin
    || completeUrl.pathname !== verificationUrl.pathname) {
    return false;
  }
  const completeQuery = [...completeUrl.searchParams.entries()];
  if (completeQuery.length !== 1
    || completeQuery[0]?.[0] !== 'code'
    || completeQuery[0]?.[1] !== value.user_code) {
    return false;
  }
  return !decodedUrlContains(value.verification_uri_complete, value.device_code);
}

function hasUrlCredentialsOrHash(url: URL): boolean {
  return url.username !== '' || url.password !== '' || url.hash !== '';
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function decodedUrlContains(value: string, secret: string): boolean {
  try {
    return decodeURIComponent(value).toLowerCase().includes(secret);
  } catch {
    return true;
  }
}

function isDeviceSessionResponse(value: unknown): value is Extract<DeviceTokenResponse, { token: string }> {
  return isRecord(value)
    && typeof value.token === 'string'
    && typeof value.email === 'string';
}

async function decodeDeviceResponse<T>(
  response: Response,
  validate: (value: unknown) => value is T,
): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(INVALID_DEVICE_RESPONSE);
  }
  if (!validate(value)) throw new Error(INVALID_DEVICE_RESPONSE);
  return value;
}

export class ZenAgentClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');

    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  authStatus(): Promise<UsageResponse> {
    return this.request('/api/user/usage');
  }

  startAgent(body: CreateJobRequest): Promise<CreateJobResponse> {
    const payload: CreateJobRequest = {
      task: body.task,
      initial_context: body.initial_context,
      agent: body.agent,
    };
    return this.request('/api/agent/jobs', { method: 'POST', body: JSON.stringify(payload) });
  }

  agentStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
    return this.request(`/api/agent/jobs/${encodeURIComponent(jobId)}`, { signal });
  }

  provideContext(jobId: string, body: ProvideContextRequest): Promise<void> {
    return this.request<void>(`/api/agent/jobs/${encodeURIComponent(jobId)}/context`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  agentResult(jobId: string, signal?: AbortSignal): Promise<AgentResult> {
    return this.request(`/api/agent/jobs/${encodeURIComponent(jobId)}/result`, { signal });
  }

  cancelAgent(jobId: string): Promise<void> {
    return this.request<void>(`/api/agent/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  listAgents(): Promise<JobStatus[]> {
    return this.request('/api/agent/jobs');
  }
}

export class ZenDeviceClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(`${this.baseUrl}${path}`, init);
    } catch {
      throw new Error('Unable to reach Zen. Check your connection and try again.');
    }
  }

  async startDeviceLogin(signal?: AbortSignal): Promise<DeviceStartResponse> {
    const response = await this.send('/api/auth/device/start', { method: 'POST', signal });
    if (!response.ok) throw new Error(deviceResponseError(response.status));
    return await decodeDeviceResponse(response, isDeviceStartResponse);
  }

  async pollDeviceLogin(deviceCode: string, signal?: AbortSignal): Promise<DeviceTokenResponse> {
    const response = await this.send('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
      signal,
    });
    if (response.status === 202) return { status: 'pending' };
    if (!response.ok) throw new Error(deviceResponseError(response.status));
    return await decodeDeviceResponse(response, isDeviceSessionResponse);
  }
}
