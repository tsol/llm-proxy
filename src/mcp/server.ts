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
      description: 'Get job status by id',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
    {
      name: 'job_result',
      description: 'Get job result; optionally wait up to wait_sec',
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
    if (!svc.mcp?.expose) continue;
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
    const desc = `${svc.title}. ${svc.description}`;
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
    if (!svc.mcp?.expose) continue;
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
  const wait = Number(wait_sec ?? 0);
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
        content: [{ type: 'text', text: JSON.stringify(listServices().map((s) => s.id)) }],
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
      const wait = Number(args.wait_sec ?? 0);
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
