import express from 'express';
import cors from 'cors';
import dns from 'node:dns';
import { appConfig } from './config';
import { getDefaultModelId, startCatalogRefresh, startConnectivityWatchdog } from './catalog';
import { chatRouter } from './routes/chat';
import { modelsRouter } from './routes/models';
import { adminRouter } from './routes/admin';
import { aliasesRouter } from './routes/aliases';
import { gpuRouter } from './routes/gpu';
import { androidRouter } from './routes/android';
import { servicesRouter } from './routes/services';
import { jobsRouter } from './routes/jobs';
import { schedulerRouter } from './routes/scheduler';
import { audioRouter } from './routes/audio';
import { loadRegistry } from './jobs/registry';
import { startScheduler } from './jobs/scheduler';
import { handleMcpRequest } from './mcp/server';
import path from 'path';
import { configureAndroidBridge } from './services/android-bridge';
import { ensureReqLogDir, rotateReqLogs } from './services/request-dump-logger';
import { startZombieReaper } from './services/concurrency-queue';

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/v1', chatRouter);
app.use('/v1', modelsRouter);
app.use('/v1', adminRouter);
app.use('/v1', aliasesRouter);
app.use('/v1', gpuRouter);
app.use('/v1', androidRouter);
app.use('/v1', servicesRouter);
app.use('/v1', jobsRouter);
app.use('/v1', schedulerRouter);
app.use('/v1', audioRouter);

app.post('/mcp', (req, res) => {
  void handleMcpRequest(req, res);
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());

const webDir = path.join(appConfig.services.proxyRoot, 'dist', 'web');
app.use('/ui', express.static(webDir));
app.get('/ui/*', (_req, res) => {
  res.sendFile(path.join(webDir, 'index.html'));
});

// Configure Android bridge from env
configureAndroidBridge({
  adbPath: appConfig.android.adbPath,
  tcpipPort: appConfig.android.tcpipPort,
  targetVid: appConfig.android.targetVid,
  targetPid: appConfig.android.targetPid,
});

// Per-provider mount: /deepseek/v1/chat/completions, /cerebras/v1/models, etc.
// Bypasses catalog lookup — forces all requests through the named provider.
import { perProviderRouter } from './routes/chat';
app.use('/:provider(\\w+)/v1', perProviderRouter);

rotateReqLogs()
  .then(() => ensureReqLogDir())
  .then(() => {
    // Prefer IPv4 — reduces flaky getaddrinfo / VPN DNS races on Linux.
    dns.setDefaultResultOrder('ipv4first');

    loadRegistry();
    startScheduler();

    app.listen(appConfig.port, appConfig.host, () => {
      startZombieReaper();
      console.log(
        `Hermes LLM proxy listening on http://${appConfig.host}:${appConfig.port}`,
      );
      console.log(`Default model (Hermes): ${getDefaultModelId()}`);
      console.log('Routing: per-request model id → provider');
    });

    // Each provider loads models independently; catalog grows as they complete.
    startCatalogRefresh('startup');
    startConnectivityWatchdog();
  })
  .catch((err) => {
    console.error('Failed to start proxy:', err);
    process.exit(1);
  });