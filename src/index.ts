import express from 'express';
import cors from 'cors';
import dns from 'node:dns';
import { appConfig } from './config';
import { getDefaultModelId, startCatalogRefresh, startConnectivityWatchdog } from './catalog';
import { chatRouter } from './routes/chat';
import { modelsRouter } from './routes/models';
import { adminRouter } from './routes/admin';
import { gpuRouter } from './routes/gpu';
import { ensureReqLogDir } from './services/request-dump-logger';

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/v1', chatRouter);
app.use('/v1', modelsRouter);
app.use('/v1', adminRouter);
app.use('/v1', gpuRouter);

ensureReqLogDir()
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
