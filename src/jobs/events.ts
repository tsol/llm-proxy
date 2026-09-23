import { EventEmitter } from 'events';
import type { JobRow } from './types';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

export function emitJobUpdate(row: JobRow): void {
  jobEvents.emit('job', row);
  jobEvents.emit('snapshot');
}
