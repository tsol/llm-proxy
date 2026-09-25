import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import { appConfig } from '../config';
import { submitJob, waitForJob } from '../jobs/scheduler';
import type { PriorityClass } from '../jobs/types';

const CYRILLIC = /[\u0400-\u04FF]/;
const WAIT_SEC = 180;

type VoiceModelsFile = {
  models: Record<string, { backend: string }>;
  backends: Record<
    string,
    {
      service_id: string;
      default_voice: string;
      voices: Record<string, string>;
    }
  >;
};

function configPath(): string {
  return path.join(appConfig.services.proxyRoot, 'store', 'voice-models.json');
}

function loadVoiceModels(): VoiceModelsFile {
  const raw = fs.readFileSync(configPath(), 'utf8');
  return JSON.parse(raw) as VoiceModelsFile;
}

function responseFormat(raw: unknown): { ext: 'ogg' | 'mp3' | 'wav'; mime: string } {
  const fmt = String(raw ?? '').trim().toLowerCase();
  if (fmt === 'mp3' || fmt === 'mpeg') return { ext: 'mp3', mime: 'audio/mpeg' };
  if (fmt === 'wav') return { ext: 'wav', mime: 'audio/wav' };
  return { ext: 'ogg', mime: 'audio/ogg' };
}

function openaiError(res: Response, status: number, message: string, type: string): void {
  res.status(status).json({ error: { message, type } });
}

export const audioRouter = Router();

audioRouter.post('/audio/speech', async (req: Request, res: Response) => {
  const model = String(req.body?.model ?? '').trim();
  const input = String(req.body?.input ?? '');
  const requestedVoice = String(req.body?.voice ?? '').trim();
  const { ext, mime } = responseFormat(req.body?.response_format);

  if (!model) {
    openaiError(res, 400, 'model is required', 'invalid_request_error');
    return;
  }
  if (!input.trim()) {
    openaiError(res, 400, 'input is required', 'invalid_request_error');
    return;
  }
  if (CYRILLIC.test(input)) {
    openaiError(res, 400, 'English only', 'invalid_request_error');
    return;
  }

  let cfg: VoiceModelsFile;
  try {
    cfg = loadVoiceModels();
  } catch (err) {
    openaiError(
      res,
      500,
      err instanceof Error ? err.message : 'voice-models.json unreadable',
      'proxy_error',
    );
    return;
  }

  const modelEntry = cfg.models[model];
  if (!modelEntry) {
    openaiError(res, 400, `Unknown model "${model}"`, 'invalid_request_error');
    return;
  }
  const backend = cfg.backends[modelEntry.backend];
  if (!backend) {
    openaiError(
      res,
      500,
      `Voice backend "${modelEntry.backend}" is not configured`,
      'proxy_error',
    );
    return;
  }

  const mapped =
    backend.voices[requestedVoice] ||
    backend.voices[requestedVoice.toLowerCase()] ||
    backend.default_voice;

  const principal =
    String(req.headers['x-principal'] ?? '').trim() || 'hermes';

  try {
    const submitted = submitJob(backend.service_id, {
      input: { text: input, voice: mapped, format: ext },
      priority: 'interactive' as PriorityClass,
      principal,
    });
    const row = await waitForJob(submitted.id, WAIT_SEC);
    if (!['succeeded', 'failed', 'cancelled'].includes(row.status)) {
      openaiError(res, 504, `TTS timed out (job ${row.id}, status ${row.status})`, 'proxy_error');
      return;
    }
    if (row.status !== 'succeeded') {
      openaiError(res, 502, row.error || `TTS job ${row.status}`, 'proxy_error');
      return;
    }

    const audioPath = path.join(row.outputs_dir, `speech.${ext}`);
    const fallback = path.join(row.outputs_dir, 'speech.ogg');
    const file = fs.existsSync(audioPath) ? audioPath : fallback;
    if (!fs.existsSync(file)) {
      openaiError(res, 502, `TTS produced no audio for job ${row.id}`, 'proxy_error');
      return;
    }
    const body = fs.readFileSync(file);
    const contentType = file.endsWith('.mp3')
      ? 'audio/mpeg'
      : file.endsWith('.wav')
        ? 'audio/wav'
        : mime;
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Job-Id', row.id);
    res.send(body);
  } catch (err) {
    openaiError(res, 502, err instanceof Error ? err.message : 'TTS failed', 'proxy_error');
  }
});
