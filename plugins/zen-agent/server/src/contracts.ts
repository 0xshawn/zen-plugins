export type JobState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_for_context'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'expired';

export const CONTEXT_SOURCES = [
  'file',
  'git_diff',
  'git_status',
  'symbol',
  'test_output',
  'command_output',
  'other',
] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export interface ContextItem {
  label: string;
  source: ContextSource;
  content: string;
  truncated: boolean;
}

export interface ContextRequestItem {
  kind: 'file' | 'diff' | 'symbol' | 'test_output' | 'command_output';
  path?: string;
  query?: string;
  max_bytes: number;
}

export interface ContextRequest {
  request_id: string;
  reason: string;
  requests: ContextRequestItem[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface JobStatus {
  job_id: string;
  state: JobState;
  elapsed_ms?: number;
  last_action?: string;
  model?: string;
  usage?: Usage;
  context_request?: ContextRequest;
  error?: string;
}

export interface AgentResult {
  summary: string;
  findings: Array<{
    severity: 'critical' | 'important' | 'minor' | 'note';
    location?: string;
    message: string;
  }>;
  patch?: string;
  tests: string[];
  assumptions: string[];
  remaining_questions: string[];
}

export interface CreateJobRequest {
  task: string;
  initial_context: ContextItem[];
}

export interface CreateJobResponse {
  job_id: string;
  state: JobState;
}

export interface ProvideContextRequest {
  request_id: string;
  items: ContextItem[];
}

export interface UsageResponse {
  used_tokens: number;
  quota_tokens: number;
}

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type DeviceTokenResponse =
  | { status: 'pending' }
  | { token: string; email: string };
