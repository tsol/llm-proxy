import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listServices } from '../jobs/registry';
import { submitJob, waitForJob, cancelJob, snapshot } from '../jobs/scheduler';
import { getJob } from '../jobs/db';
import { serializeJob } from '../jobs/serialize';

/**
 * Hermes drops an MCP tool call at about 420s. A Wan render runs ~25 minutes.
 * Cap the wait and return the live job (queued/running included) instead of
 * holding the request until the client times out.
 */
const MCP_WAIT_CAP_SEC = 25;

function mcpWaitSec(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MCP_WAIT_CAP_SEC);
}

function buildTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    {
      name: 'list_services',
      description: 'List registered GPU services',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'job_status',
      description:
        'Immediate snapshot of one job: status, progress, stage, message, started_at, estimate_sec. Does not wait. While a render runs, message includes "alive pid=… elapsed=Ns/Ms" and progress moves with elapsed time. A running job whose elapsed value increases is healthy — do not cancel it and do not treat a progress below 1 as a hang. Poll this instead of blocking on job_result.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
    {
      name: 'job_result',
      description:
        'Snapshot of a job, including while it is still running. Returns status, progress, and stage without waiting for the render to finish. wait_sec is a short poll capped at 25s, not a wait for generation. Poll again with job_status or job_result. A running job is not a failure.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          wait_sec: { type: 'number' },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'job_cancel',
      description: 'Cancel a queued or running job',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
    {
      name: 'queue_snapshot',
      description: 'Scheduler queue and resource snapshot',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  for (const svc of listServices()) {
    if (svc.kind !== 'exec' || !svc.mcp?.expose) continue;
    const schema = {
      ...(svc.input_schema as Record<string, unknown>),
      type: 'object',
      properties: {
        ...((svc.input_schema as { properties?: Record<string, unknown> }).properties ?? {}),
        wait_sec: { type: 'number', default: svc.mcp.default_wait_sec },
        priority: { type: 'string', enum: ['interactive', 'normal', 'batch'] },
        principal: { type: 'string' },
      },
    };
    const desc = [svc.title, svc.description, svc.help].filter(Boolean).join('\n\n');
    tools.push({ name: svc.id, description: desc, inputSchema: schema });
    for (const legacy of svc.mcp.legacy_tool_names ?? []) {
      tools.push({
        name: legacy,
        description: `Deprecated alias of ${svc.id}. ${desc}`,
        inputSchema: schema,
      });
    }
  }
  return tools;
}

function serviceIdForTool(name: string): string | null {
  for (const svc of listServices()) {
    if (svc.kind !== 'exec' || !svc.mcp?.expose) continue;
    if (svc.id === name) return svc.id;
    if (svc.mcp.legacy_tool_names?.includes(name)) return svc.id;
  }
  return null;
}

async function callServiceTool(
  serviceId: string,
  args: Record<string, unknown>,
  legacyName?: string,
): Promise<{ text: string; isError: boolean }> {
  const { wait_sec, priority, principal, ...input } = args;
  const wait = mcpWaitSec(wait_sec);
  let row = submitJob(serviceId, {
    input: input as Record<string, unknown>,
    priority: priority as 'interactive' | 'normal' | 'batch' | undefined,
    principal: String(principal ?? 'hermes'),
  });
  if (wait > 0) {
    row = await waitForJob(row.id, wait);
  }
  const job = serializeJob(row);
  let prefix = '';
  if (legacyName === 'trigger_z_image_generation' && job.status === 'succeeded') {
    const paths = (job.outputs as Array<{ container_path?: string }>) ?? [];
    const hermes = paths.map((p) => p.container_path).filter(Boolean).join(', ');
    prefix = `Z-Image-Turbo finished. job_id=${job.id}. Hermes: ${hermes}\n`;
  }
  const text = prefix + JSON.stringify(job);
  return { text, isError: job.status === 'failed' };
}

function createMcpServer(): Server {
  const server = new Server(
    { name: 'hermes-proxy-services', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'list_services') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(listServices().map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
            help: s.help,
          }))),
        }],
      };
    }
    if (name === 'job_status') {
      const row = getJob(String(args.job_id ?? ''));
      return {
        content: [{ type: 'text', text: JSON.stringify(row ? serializeJob(row) : null) }],
      };
    }
    if (name === 'job_result') {
      const id = String(args.job_id ?? '');
      const wait = mcpWaitSec(args.wait_sec);
      let row = getJob(id);
      if (row && wait > 0) row = await waitForJob(id, wait);
      return {
        content: [{ type: 'text', text: JSON.stringify(row ? serializeJob(row) : null) }],
        isError: row?.status === 'failed',
      };
    }
    if (name === 'job_cancel') {
      const row = cancelJob(String(args.job_id ?? ''));
      return {
        content: [{ type: 'text', text: JSON.stringify(row ? serializeJob(row) : null) }],
      };
    }
    if (name === 'queue_snapshot') {
      return {
        content: [{ type: 'text', text: JSON.stringify(await snapshot()) }],
      };
    }

    const serviceId = serviceIdForTool(name);
    if (serviceId) {
      const legacy = name !== serviceId ? name : undefined;
      const { text, isError } = await callServiceTool(serviceId, args, legacy);
      return { content: [{ type: 'text', text }], isError };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
