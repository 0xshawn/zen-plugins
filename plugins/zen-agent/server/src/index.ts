import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ZenAgentClient } from './api.js';
import { loadZenSession } from './config.js';
import {
  CONTEXT_SOURCES,
  type AgentKind,
  type ContextItem,
  type CreateJobRequest,
} from './contracts.js';
import { LOGIN_ID_SOURCE, ZenLoginCoordinator } from './login.js';

export const SERVER_NAME = 'zen-agent';

const TASK_MAX_BYTES = 32 * 1024;
const CONTEXT_ITEM_MAX_BYTES = 64 * 1024;
const CONTEXT_PAYLOAD_MAX_BYTES = 256 * 1024;
const zenLoginCoordinator = new ZenLoginCoordinator();

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requiredAgentKind(value: unknown): AgentKind {
  if (value !== 'codex' && value !== 'claude') throw new Error('agent must be codex or claude');
  return value;
}

function assertAllowedKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(args).find(key => !allowed.includes(key));
  if (unexpected) throw new Error(`unexpected argument: ${unexpected}`);
}

function validateContextItems(value: unknown, required = false): ContextItem[] {
  if (value === undefined) {
    if (required) throw new Error('items are required');
    return [];
  }
  if (!Array.isArray(value)) throw new Error('context items must be an array');

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`context item ${index} must be an object`);
    const input = item as Record<string, unknown>;
    const label = requiredString(input.label, `context item ${index} label`);
    const content = typeof input.content === 'string' ? input.content : undefined;
    if (content === undefined) throw new Error(`context item ${index} content must be a string`);
    if (typeof input.source !== 'string' || !CONTEXT_SOURCES.includes(input.source as typeof CONTEXT_SOURCES[number])) {
      throw new Error(`context item ${index} has an invalid source`);
    }
    if (typeof input.truncated !== 'boolean') throw new Error(`context item ${index} truncated must be boolean`);
    const normalized = { label, source: input.source as ContextItem['source'], content, truncated: input.truncated };
    if (byteLength(JSON.stringify(normalized)) > CONTEXT_ITEM_MAX_BYTES) {
      throw new Error(`context item ${index} exceeds 64 KiB`);
    }
    return normalized;
  });
}

function validatePayload(body: unknown): void {
  if (byteLength(JSON.stringify(body)) > CONTEXT_PAYLOAD_MAX_BYTES) {
    throw new Error('context payload exceeds 256 KiB');
  }
}

async function client(): Promise<{ api: ZenAgentClient; email?: string }> {
  const session = await loadZenSession();
  return { api: new ZenAgentClient(session.baseUrl, session.token), email: session.email };
}

export async function handleZenLogin(
  args: Record<string, unknown> = {},
  requestSignal?: AbortSignal,
  coordinator: ZenLoginCoordinator = zenLoginCoordinator,
) {
  assertAllowedKeys(args, ['login_id']);
  if (args.login_id === undefined) return coordinator.start(requestSignal);
  return coordinator.wait(requiredString(args.login_id, 'login_id'), requestSignal);
}

export async function handleAuthStatus(args: Record<string, unknown> = {}) {
  assertAllowedKeys(args, []);
  const { api, email } = await client();
  const usage = await api.authStatus();
  return { authenticated: true, email, ...usage };
}

export async function handleStartAgent(args: Record<string, unknown>) {
  assertAllowedKeys(args, ['task', 'initial_context', 'agent']);
  const task = requiredString(args.task, 'task');
  if (byteLength(task) > TASK_MAX_BYTES) throw new Error('task exceeds 32 KiB');
  const initialContext = validateContextItems(args.initial_context);
  const agent = args.agent === undefined ? 'codex' : requiredAgentKind(args.agent);
  const body: CreateJobRequest = { task, initial_context: initialContext, agent };
  validatePayload(body);
  const { api } = await client();
  const created = await api.startAgent(body);
  if (agent === 'claude' && created.agent !== 'claude') {
    await api.cancelAgent(created.job_id).catch(() => undefined);
    throw new Error('Zen server does not support Claude jobs yet.');
  }
  return { ...created, agent: created.agent ?? 'codex' };
}

export async function handleAgentStatus(args: Record<string, unknown>) {
  assertAllowedKeys(args, ['job_id']);
  const jobId = requiredString(args.job_id, 'job_id');
  const { api } = await client();
  return api.agentStatus(jobId);
}

export async function handleProvideContext(args: Record<string, unknown>) {
  assertAllowedKeys(args, ['job_id', 'request_id', 'items']);
  const jobId = requiredString(args.job_id, 'job_id');
  const requestId = requiredString(args.request_id, 'request_id');
  const items = validateContextItems(args.items, true);
  const body = { request_id: requestId, items };
  validatePayload(body);
  const { api } = await client();
  await api.provideContext(jobId, body);
  return { ok: true };
}

export async function handleAgentResult(args: Record<string, unknown>) {
  assertAllowedKeys(args, ['job_id']);
  const jobId = requiredString(args.job_id, 'job_id');
  const { api } = await client();
  return api.agentResult(jobId);
}

export async function handleCancelAgent(args: Record<string, unknown>) {
  assertAllowedKeys(args, ['job_id']);
  const jobId = requiredString(args.job_id, 'job_id');
  const { api } = await client();
  await api.cancelAgent(jobId);
  return { ok: true };
}

export async function handleListAgents(args: Record<string, unknown> = {}) {
  assertAllowedKeys(args, []);
  const { api } = await client();
  return api.listAgents();
}

const contextItemSchema = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    source: { type: 'string', enum: [...CONTEXT_SOURCES] },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['label', 'source', 'content', 'truncated'],
  additionalProperties: false,
} as const;

export const toolDefinitions = [
  {
    name: 'zen_login',
    description: 'Return a secure Zen browser login link and monitor approval.',
    inputSchema: {
      type: 'object',
      properties: {
        login_id: { type: 'string', pattern: LOGIN_ID_SOURCE },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'auth_status',
    description: 'Validate the existing Zen session and report quota usage.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_agent',
    description: 'Start a Zen-hosted agent job with only explicitly supplied context.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Agent task, maximum 32 KiB.' },
        initial_context: { type: 'array', items: contextItemSchema },
        agent: { type: 'string', enum: ['codex', 'claude'] },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'agent_status',
    description: 'Poll a Zen agent job and inspect any pending context request.',
    inputSchema: {
      type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false,
    },
  },
  {
    name: 'provide_context',
    description: 'Supply locally reviewed context for the current pending request.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        request_id: { type: 'string' },
        items: { type: 'array', items: contextItemSchema },
      },
      required: ['job_id', 'request_id', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'agent_result',
    description: 'Fetch the structured result for a completed Zen agent job.',
    inputSchema: {
      type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false,
    },
  },
  {
    name: 'cancel_agent',
    description: 'Cancel a Zen agent job and release its capacity.',
    inputSchema: {
      type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false,
    },
  },
  {
    name: 'list_agents',
    description: 'List agent jobs owned by the current Zen user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

export async function main(): Promise<void> {
  const packageMetadata = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const server = new Server(
    { name: SERVER_NAME, version: packageMetadata.version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...toolDefinitions] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    try {
      let result: unknown;
      switch (request.params.name) {
        case 'zen_login': result = await handleZenLogin(args, extra.signal); break;
        case 'auth_status': result = await handleAuthStatus(args); break;
        case 'start_agent': result = await handleStartAgent(args); break;
        case 'agent_status': result = await handleAgentStatus(args); break;
        case 'provide_context': result = await handleProvideContext(args); break;
        case 'agent_result': result = await handleAgentResult(args); break;
        case 'cancel_agent': result = await handleCancelAgent(args); break;
        case 'list_agents': result = await handleListAgents(args); break;
        default: result = { error: `Unknown tool: ${request.params.name}` };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
