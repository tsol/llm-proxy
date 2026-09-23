import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { appConfig } from '../config';
import type { ServiceManifest } from './types';

function settingsPath(serviceId: string): string {
  fs.mkdirSync(appConfig.services.settingsDir, { recursive: true });
  return path.join(appConfig.services.settingsDir, `${serviceId}.json`);
}

function defaultsFromSchema(schema: object | null): Record<string, unknown> {
  if (!schema) return {};
  const ajv = new Ajv({ useDefaults: true, coerceTypes: true });
  const validate = ajv.compile(schema);
  const data: Record<string, unknown> = {};
  validate(data);
  return data;
}

export function getSettings(svc: ServiceManifest): Record<string, unknown> {
  const defaults = defaultsFromSchema(svc.settingsSchema);
  const p = settingsPath(svc.id);
  if (!fs.existsSync(p)) return defaults;
  try {
    const saved = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export function putSettings(
  svc: ServiceManifest,
  values: Record<string, unknown>,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  if (!svc.settingsSchema) {
    return { ok: false, error: 'Service has no settings schema' };
  }
  const ajv = new Ajv({ useDefaults: true, coerceTypes: true, allErrors: true });
  const validate = ajv.compile(svc.settingsSchema);
  if (!validate(values)) {
    return { ok: false, error: ajv.errorsText(validate.errors) };
  }
  const p = settingsPath(svc.id);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2));
  fs.renameSync(tmp, p);
  return { ok: true, values };
}
