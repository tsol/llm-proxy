import path from 'path';
import type { JobRow, JobResultPayload } from './types';
import { toContainerPath } from './outputs';

export function serializeJob(row: JobRow): Record<string, unknown> {
  const input = JSON.parse(row.input_json) as Record<string, unknown>;
  let outputs: Array<Record<string, string>> = [];
  let data: Record<string, unknown> = {};
  if (row.result_json) {
    try {
      const result = JSON.parse(row.result_json) as JobResultPayload;
      data = result.data ?? {};
      outputs = (result.outputs ?? []).map((o) => {
        const hostPath = path.join(row.outputs_dir, o.path);
        return {
          path: o.path,
          kind: o.kind,
          host_path: hostPath,
          container_path: toContainerPath(hostPath),
          url: `/v1/jobs/${row.id}/artifacts/${o.path}`,
        };
      });
    } catch {
      /* ignore */
    }
  }
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
  return {
    id: row.id,
    service_id: row.service_id,
    status: row.status,
    priority: row.priority_class,
    principal: row.principal,
    progress: row.progress,
    stage: row.stage,
    message: row.message,
    wait_reason: row.wait_reason,
    created_at: iso(row.created_at),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    estimate_sec: row.estimate_sec,
    input,
    error: row.error,
    outputs,
    data,
  };
}
