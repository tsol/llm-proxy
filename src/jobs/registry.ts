import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { appConfig } from '../config';
import { loadServiceManifest } from './manifest';
import type { ResidentManifest, ServiceManifest } from './types';

let services: Map<string, ServiceManifest> = new Map();
let residents: ResidentManifest[] = [];

export function loadRegistry(): void {
  const dir = appConfig.services.dir;
  const next = new Map<string, ServiceManifest>();
  if (!fs.existsSync(dir)) {
    services = next;
    loadResidents();
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('_')) continue;
    const svcDir = path.join(dir, name);
    if (!fs.statSync(svcDir).isDirectory()) continue;
    if (!fs.existsSync(path.join(svcDir, 'service.yaml'))) continue;
    try {
      const manifest = loadServiceManifest(svcDir);
      next.set(manifest.id, manifest);
    } catch (err) {
      console.error(
        `[registry] skip ${name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  services = next;
  loadResidents();
  console.log(`[registry] loaded ${services.size} service(s)`);
}

function loadResidents(): void {
  const base = path.join(appConfig.services.dir, '_residents');
  const list: ResidentManifest[] = [];
  if (!fs.existsSync(base)) {
    residents = list;
    return;
  }
  for (const name of fs.readdirSync(base)) {
    const p = path.join(base, name, 'resident.yaml');
    if (!fs.existsSync(p)) continue;
    try {
      const raw = yaml.parse(fs.readFileSync(p, 'utf8')) as ResidentManifest;
      list.push(raw);
    } catch (err) {
      console.error(`[registry] resident ${name}: ${err}`);
    }
  }
  residents = list;
}

export function reloadRegistry(): { count: number } {
  loadRegistry();
  return { count: services.size };
}

export function listServices(): ServiceManifest[] {
  return [...services.values()];
}

export function getService(id: string): ServiceManifest | undefined {
  return services.get(id);
}

export function listResidents(): ResidentManifest[] {
  return residents;
}
