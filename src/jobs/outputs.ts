import fs from 'fs';
import path from 'path';
import { appConfig } from '../config';

export function jobDir(serviceId: string, jobId: string): string {
  const dir = path.join(appConfig.services.outputsRoot, serviceId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function toContainerPath(hostPath: string): string {
  const root = path.resolve(appConfig.services.outputsRoot);
  const resolved = path.resolve(hostPath);
  if (!resolved.startsWith(root)) {
    return hostPath;
  }
  const rel = resolved.slice(root.length).replace(/^\//, '');
  const containerRoot = appConfig.services.outputsContainerRoot.replace(/\/$/, '');
  return rel ? `${containerRoot}/${rel}` : containerRoot;
}

export function resolveArtifact(outputsDir: string, relPath: string): string {
  const base = path.resolve(outputsDir);
  const full = path.resolve(base, relPath);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Invalid artifact path');
  }
  if (!fs.existsSync(full)) {
    throw new Error('Artifact not found');
  }
  return full;
}
