const base = '';

export async function fetchScheduler(): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}/v1/scheduler`);
  return r.json();
}

export function streamScheduler(onData: (data: Record<string, unknown>) => void): () => void {
  const es = new EventSource(`${base}/v1/scheduler/stream`);
  es.addEventListener('snapshot', (ev) => {
    try {
      onData(JSON.parse((ev as MessageEvent).data));
    } catch {
      /* ignore */
    }
  });
  return () => es.close();
}

export interface ServiceInfo {
  id: string;
  kind?: string;
  title: string;
  mcp_url?: string | null;
  ui_url?: string | null;
  health?: string | null;
  description: string;
  version: string;
  resources: Record<string, unknown>;
  residents: Record<string, unknown>;
  estimate_sec: number;
  priority_default: string;
  input_schema: Record<string, unknown>;
  has_settings: boolean;
  has_custom_ui: boolean;
}

export async function fetchServices(): Promise<ServiceInfo[]> {
  const r = await fetch(`${base}/v1/services`);
  const j = await r.json();
  return j.data ?? [];
}

export async function fetchService(id: string): Promise<ServiceInfo> {
  const r = await fetch(`${base}/v1/services/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchServiceSettings(id: string): Promise<{
  schema: Record<string, unknown> | null;
  values: Record<string, unknown>;
}> {
  const r = await fetch(`${base}/v1/services/${encodeURIComponent(id)}/settings`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function putServiceSettings(
  id: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}/v1/services/${encodeURIComponent(id)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? 'Settings validation failed');
  return j.values;
}

export async function submitServiceJob(
  id: string,
  input: Record<string, unknown>,
  waitSec = 300,
): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}/v1/services/${encodeURIComponent(id)}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, wait_sec: waitSec }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? 'Job failed');
  return j.job ?? j;
}

export async function fetchJobHistory(serviceId: string, limit = 30): Promise<Record<string, unknown>[]> {
  const r = await fetch(
    `${base}/v1/jobs?service=${encodeURIComponent(serviceId)}&limit=${limit}`,
  );
  const j = await r.json();
  return j.data ?? [];
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`${base}/v1/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
