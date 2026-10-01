import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import Ajv from 'ajv';
import type { PriorityClass, ServiceManifest } from './types';

const ID_RE = /^[a-z][a-z0-9_]{2,63}$/;

export function loadServiceManifest(dir: string): ServiceManifest {
  const folderName = path.basename(dir);
  const yamlPath = path.join(dir, 'service.yaml');
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`${yamlPath}: missing service.yaml`);
  }
  const raw = yaml.parse(fs.readFileSync(yamlPath, 'utf8')) as Record<string, unknown>;
  const id = String(raw.id ?? '').trim();
  if (!ID_RE.test(id)) {
    throw new Error(`${yamlPath}: invalid id "${id}"`);
  }
  if (id !== folderName) {
    throw new Error(`${yamlPath}: id "${id}" must match folder "${folderName}"`);
  }
  const kind = String(raw.kind ?? 'exec');
  if (kind !== 'exec' && kind !== 'external') {
    throw new Error(`${yamlPath}: kind must be exec or external`);
  }
  const entry = raw.entry;
  if (kind === 'exec' && (!Array.isArray(entry) || entry.length === 0 || !entry.every((e) => typeof e === 'string'))) {
    throw new Error(`${yamlPath}: entry must be a non-empty string array`);
  }
  const residents = raw.residents as { requires?: unknown; evicts?: unknown };
  const resources = raw.resources as ServiceManifest['resources'];
  const estimate = raw.estimate as { duration_sec?: number };
  const priority_default = String(raw.priority_default ?? 'normal') as PriorityClass;
  const input_schema = (raw.input_schema && typeof raw.input_schema === 'object')
    ? raw.input_schema
    : { type: 'object', properties: {} };
  if (kind === 'exec') {
    const ajv = new Ajv({ useDefaults: true, coerceTypes: true, allErrors: true });
    if (!ajv.validateSchema(input_schema as object)) {
      throw new Error(`${yamlPath}: invalid input_schema`);
    }
  }

  let settingsSchema: object | null = null;
  const settingsPath = path.join(dir, 'settings.schema.json');
  if (fs.existsSync(settingsPath)) {
    settingsSchema = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as object;
  }
  const hasCustomUi = fs.existsSync(path.join(dir, 'ui', 'Settings.vue'));

  return {
    id,
    title: String(raw.title ?? id),
    description: String(raw.description ?? ''),
    version: String(raw.version ?? '0.0.0'),
    kind: kind as ServiceManifest['kind'],
    entry: Array.isArray(entry) ? (entry as string[]) : [],
    external: kind === 'external'
      ? {
          mcp_url: raw.mcp_url ? String(raw.mcp_url) : undefined,
          ui_url: raw.ui_url ? String(raw.ui_url) : undefined,
          health: raw.health ? String(raw.health) : undefined,
        }
      : undefined,
    timeout_sec: Number(raw.timeout_sec ?? 3600),
    residents: {
      requires: Array.isArray(residents?.requires)
        ? (residents.requires as string[]).map(String)
        : [],
      evicts: Array.isArray(residents?.evicts)
        ? (residents.evicts as string[]).map(String)
        : [],
    },
    resources: {
      vram_mb: Number(resources?.vram_mb ?? 0),
      ram_mb: Number(resources?.ram_mb ?? 0),
      cpu: Number(resources?.cpu ?? 1),
      min_free_vram_mb: resources?.min_free_vram_mb !== undefined
        ? Number(resources.min_free_vram_mb)
        : undefined,
    },
    estimate: { duration_sec: Number(estimate?.duration_sec ?? 60) },
    priority_default,
    input_schema: input_schema as object,
    mcp: raw.mcp as ServiceManifest['mcp'],
    dir,
    settingsSchema,
    hasCustomUi,
  };
}
