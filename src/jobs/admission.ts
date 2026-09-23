import type { ResourceVector } from './types';
import type { ResidentState } from './residents';
import { residentKeyMatches } from './residents';

export interface RunningItem {
  key: string;
  resources: ResourceVector;
  holds: string[];
  shared: boolean;
  gpu: boolean;
  etaAt: number;
}

export interface AdmissionJob {
  resources: ResourceVector;
  requires: string[];
  evicts: string[];
  shared: boolean;
}

export interface AdmissionInput {
  capacity: ResourceVector;
  running: RunningItem[];
  residents: ResidentState[];
  job: AdmissionJob;
}

export type AdmissionDecision =
  | { ok: true; evict: string[]; absorbed: boolean }
  | { ok: false; reason: string };

function sumVec(items: ResourceVector[]): ResourceVector {
  return items.reduce(
    (a, b) => ({
      vram_mb: a.vram_mb + b.vram_mb,
      ram_mb: a.ram_mb + b.ram_mb,
      cpu: a.cpu + b.cpu,
    }),
    { vram_mb: 0, ram_mb: 0, cpu: 0 },
  );
}

function residentRequired(required: string, resident: ResidentState): boolean {
  return residentKeyMatches(required, resident.key);
}

function jobNeedsResident(job: AdmissionJob, residentKey: string): boolean {
  return job.requires.some((r) => residentKeyMatches(r, residentKey));
}

function canEvict(job: AdmissionJob, residentKey: string, family: string): boolean {
  if (job.evicts.includes('*')) return true;
  if (job.evicts.includes(residentKey)) return true;
  if (job.evicts.includes(family)) return true;
  return false;
}

function fits(
  capacity: ResourceVector,
  used: ResourceVector,
  job: ResourceVector,
  keptResidents: ResidentState[],
): boolean {
  const kept = sumVec(
    keptResidents.map((r) => ({
      vram_mb: r.idle_vram_mb,
      ram_mb: r.idle_ram_mb,
      cpu: 0,
    })),
  );
  const need = {
    vram_mb: used.vram_mb + job.vram_mb + kept.vram_mb,
    ram_mb: used.ram_mb + job.ram_mb + kept.ram_mb,
    cpu: used.cpu + job.cpu,
  };
  return (
    need.vram_mb <= capacity.vram_mb &&
    need.ram_mb <= capacity.ram_mb &&
    need.cpu <= capacity.cpu
  );
}

export function admit(input: AdmissionInput): AdmissionDecision {
  const { capacity, running, residents, job } = input;

  if (job.shared && job.requires.length > 0) {
    const allHeld = job.requires.every((req) =>
      running.some(
        (r) =>
          r.shared &&
          r.holds.some((h) => residentKeyMatches(req, h)),
      ),
    );
    if (allHeld) {
      return { ok: true, evict: [], absorbed: true };
    }
  }

  const lmRequired = job.requires.filter((r) => r.startsWith('lmstudio:'));
  for (const req of lmRequired) {
    for (const r of running) {
      for (const h of r.holds) {
        if (h.startsWith('lmstudio:') && !residentKeyMatches(req, h)) {
          return { ok: false, reason: 'lmstudio busy with another model' };
        }
      }
    }
  }

  const used = sumVec(running.map((r) => r.resources));
  const busyKeys = new Set(running.flatMap((r) => r.holds));
  const idleOthers = residents.filter(
    (res) => res.up && !busyKeys.has(res.key) && !jobNeedsResident(job, res.key),
  );

  const forcedEvict: string[] = [];
  if (lmRequired.length > 0) {
    for (const res of idleOthers) {
      if (res.family === 'lmstudio' && !lmRequired.some((req) => residentKeyMatches(req, res.key))) {
        forcedEvict.push(res.key);
      }
    }
  }
  const forcedSet = new Set(forcedEvict);
  let kept = idleOthers.filter((r) => !forcedSet.has(r.key));

  if (fits(capacity, used, job.resources, kept)) {
    return { ok: true, evict: [...forcedEvict], absorbed: false };
  }

  const evictable = kept
    .filter((r) => canEvict(job, r.key, r.family))
    .sort((a, b) => a.last_used_at - b.last_used_at);
  const evicted: string[] = [...forcedEvict];
  const evictedSet = new Set(evicted);

  for (const res of evictable) {
    if (evictedSet.has(res.key)) continue;
    evicted.push(res.key);
    evictedSet.add(res.key);
    kept = kept.filter((k) => !evictedSet.has(k.key));
    if (fits(capacity, used, job.resources, kept)) {
      return { ok: true, evict: evicted, absorbed: false };
    }
  }

  const freeVram = capacity.vram_mb - used.vram_mb;
  const freeRam = capacity.ram_mb - used.ram_mb;
  return {
    ok: false,
    reason: `need vram ${job.resources.vram_mb}/ram ${job.resources.ram_mb}, free vram ${freeVram}/ram ${freeRam}`,
  };
}
