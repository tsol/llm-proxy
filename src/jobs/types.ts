export interface ResourceVector {
  vram_mb: number;
  ram_mb: number;
  cpu: number;
}

export type PriorityClass = 'interactive' | 'normal' | 'batch';

export type JobStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ServiceManifest {
  id: string;
  title: string;
  description: string;
  version: string;
  kind: 'exec';
  entry: string[];
  timeout_sec: number;
  residents: { requires: string[]; evicts: string[] };
  resources: ResourceVector & { min_free_vram_mb?: number };
  estimate: { duration_sec: number };
  priority_default: PriorityClass;
  input_schema: object;
  mcp?: {
    expose: boolean;
    default_wait_sec: number;
    legacy_tool_names?: string[];
  };
  dir: string;
  settingsSchema: object | null;
  hasCustomUi: boolean;
}

export interface ResidentManifest {
  id: 'comfyui' | 'lmstudio';
  title: string;
  idle_vram_mb: number;
  idle_ram_mb: number;
}

export interface JobRow {
  id: string;
  service_id: string;
  status: JobStatus;
  priority_class: PriorityClass;
  principal: string;
  input_json: string;
  resources_json: string;
  estimate_sec: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  progress: number | null;
  stage: string | null;
  message: string | null;
  wait_reason: string | null;
  result_json: string | null;
  error: string | null;
  outputs_dir: string;
}

export interface JobResultOutput {
  path: string;
  kind: string;
}

export interface JobResultPayload {
  outputs: JobResultOutput[];
  data?: Record<string, unknown>;
}
