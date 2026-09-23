import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { appConfig } from '../config';
import type { JobRow, JobStatus, PriorityClass } from './types';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(appConfig.services.dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(appConfig.services.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      status TEXT NOT NULL,
      priority_class TEXT NOT NULL,
      principal TEXT NOT NULL DEFAULT 'anonymous',
      input_json TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      estimate_sec REAL NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      progress REAL,
      stage TEXT,
      message TEXT,
      wait_reason TEXT,
      result_json TEXT,
      error TEXT,
      outputs_dir TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS job_stats (
      job_id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      duration_sec REAL NOT NULL,
      peak_vram_mb INTEGER,
      peak_ram_mb INTEGER,
      finished_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function newJobId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `j_${stamp}_${rand}`;
}

export function insertJob(row: Omit<JobRow, 'started_at' | 'finished_at' | 'progress' | 'stage' | 'message' | 'wait_reason' | 'result_json' | 'error'> & {
  started_at?: number | null;
  finished_at?: number | null;
  progress?: number | null;
  stage?: string | null;
  message?: string | null;
  wait_reason?: string | null;
  result_json?: string | null;
  error?: string | null;
}): JobRow {
  const d = getDb();
  d.prepare(`
    INSERT INTO jobs (
      id, service_id, status, priority_class, principal, input_json, resources_json,
      estimate_sec, created_at, started_at, finished_at, progress, stage, message,
      wait_reason, result_json, error, outputs_dir
    ) VALUES (
      @id, @service_id, @status, @priority_class, @principal, @input_json, @resources_json,
      @estimate_sec, @created_at, @started_at, @finished_at, @progress, @stage, @message,
      @wait_reason, @result_json, @error, @outputs_dir
    )
  `).run({
    ...row,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    progress: row.progress ?? null,
    stage: row.stage ?? null,
    message: row.message ?? null,
    wait_reason: row.wait_reason ?? null,
    result_json: row.result_json ?? null,
    error: row.error ?? null,
  });
  return getJob(row.id)!;
}

export function updateJob(id: string, patch: Partial<JobRow>): JobRow | undefined {
  const current = getJob(id);
  if (!current) return undefined;
  const merged = { ...current, ...patch, id };
  const d = getDb();
  d.prepare(`
    UPDATE jobs SET
      status = @status,
      priority_class = @priority_class,
      principal = @principal,
      input_json = @input_json,
      resources_json = @resources_json,
      estimate_sec = @estimate_sec,
      created_at = @created_at,
      started_at = @started_at,
      finished_at = @finished_at,
      progress = @progress,
      stage = @stage,
      message = @message,
      wait_reason = @wait_reason,
      result_json = @result_json,
      error = @error,
      outputs_dir = @outputs_dir
    WHERE id = @id
  `).run(merged);
  return getJob(id);
}

export function getJob(id: string): JobRow | undefined {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

export function listJobs(opts?: {
  status?: JobStatus;
  service?: string;
  limit?: number;
}): JobRow[] {
  const limit = opts?.limit ?? 50;
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const params: unknown[] = [];
  if (opts?.status) {
    sql += ' AND status = ?';
    params.push(opts.status);
  }
  if (opts?.service) {
    sql += ' AND service_id = ?';
    params.push(opts.service);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return getDb().prepare(sql).all(...params) as JobRow[];
}

export function recoverOnStartup(): JobRow[] {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'failed', error = 'proxy restarted', finished_at = ? WHERE status IN ('preparing', 'running')`,
    )
    .run(now);
  return getDb()
    .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC`)
    .all() as JobRow[];
}

export function insertStat(opts: {
  job_id: string;
  service_id: string;
  duration_sec: number;
  peak_vram_mb?: number;
  peak_ram_mb?: number;
  finished_at: number;
}): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO job_stats (job_id, service_id, duration_sec, peak_vram_mb, peak_ram_mb, finished_at)
       VALUES (@job_id, @service_id, @duration_sec, @peak_vram_mb, @peak_ram_mb, @finished_at)`,
    )
    .run({
      peak_vram_mb: opts.peak_vram_mb ?? null,
      peak_ram_mb: opts.peak_ram_mb ?? null,
      ...opts,
    });
}

export function medianDuration(serviceId: string, lastN = 20): number | null {
  const rows = getDb()
    .prepare(
      `SELECT duration_sec FROM job_stats WHERE service_id = ? ORDER BY finished_at DESC LIMIT ?`,
    )
    .all(serviceId, lastN) as { duration_sec: number }[];
  if (rows.length === 0) return null;
  const sorted = rows.map((r) => r.duration_sec).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
