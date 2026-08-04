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
import { configureAndroidBridge } from './services/android-bridge';
import { ensureReqLogDir, rotateReqLogs } from './services/request-dump-logger';

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

    app.listen(appConfig.port, appConfig.host, () => {
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