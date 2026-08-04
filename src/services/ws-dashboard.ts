/**
 * WebSocket Dashboard Adapter
 *
 * Responsibilities:
 * - WebSocket.Server (from 'ws')
 * - registerEmitter() → подключает в request-logger
 * - handleUpgrade() — HTTP → WS
 * - broadcast(event) — рассылка всем клиентам
 * - heartbeat / ping-pong cleanup
 * - connectedClients counter (для health)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { LogEvent } from '../types';

const WS_PATH = '/ws/dashboard';
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
let connectedClients = 0;

// ─────────────────────────────────────────────────────────────
// Emitter registration (called by request-logger)
// ─────────────────────────────────────────────────────────────

type WsEmitter = (event: LogEvent) => void;
let _emitter: WsEmitter | null = null;

/**
 * Register the WebSocket emitter.
 * Called once from index.ts after the WS server is initialised.
 */
export function registerEmitter(fn: WsEmitter): void {
  _emitter = fn;
}

/** Emit an event to all connected dashboard clients. */
export function emitWs(event: LogEvent): void {
  if (!_emitter) return;
  try {
    _emitter(event);
  } catch (err) {
    console.error('[ws-dashboard] emit failed:', (err as Error)?.message ?? String(err));
  }
}

// ─────────────────────────────────────────────────────────────
// Internal broadcast
// ─────────────────────────────────────────────────────────────

function broadcast(event: LogEvent): void {
  if (clients.size === 0) return;

  const payload = JSON.stringify(event);
  let deadClients = 0;

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        console.warn('[ws-dashboard] failed to send to client:', (err as Error)?.message);
        deadClients++;
      }
    } else {
      // Non-OPEN states (CLOSING, CLOSED) are cleaned up in the close handler.
      deadClients++;
    }
  }

  if (deadClients > 0) {
    pruneDeadClients();
  }
}

/** Remove clients that are no longer OPEN. */
function pruneDeadClients(): void {
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) {
      clients.delete(client);
    }
  }
  connectedClients = clients.size;
}

// ─────────────────────────────────────────────────────────────
// Client lifecycle
// ─────────────────────────────────────────────────────────────

function setupClient(ws: WebSocket): void {
  clients.add(ws);
  connectedClients = clients.size;

  let pongReceived = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Heartbeat: ping every HEARTBEAT_INTERVAL_MS, expect pong within HEARTBEAT_TIMEOUT_MS
  const startHeartbeat = (): void => {
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        if (!pongReceived) {
          // No pong since last ping → dead connection
          console.warn('[ws-dashboard] client missed pong, terminating');
          ws.terminate();
          return;
        }
        pongReceived = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  ws.on('pong', () => {
    pongReceived = true;
  });

  ws.on('close', () => {
    stopHeartbeat();
    clients.delete(ws);
    connectedClients = clients.size;
    console.log(`[ws-dashboard] client disconnected. active=${connectedClients}`);
  });

  ws.on('error', (err) => {
    console.warn('[ws-dashboard] client error:', (err as Error)?.message ?? String(err));
  });

  ws.on('message', (data) => {
    // For now we don't accept inbound messages from clients.
    // Reserved for future commands (e.g. cancel request, filter events).
    console.debug('[ws-dashboard] unexpected message from client:', data.toString().slice(0, 100));
  });

  // Start heartbeat and send welcome
  startHeartbeat();
  try {
    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  } catch {
    // ignore
  }

  console.log(`[ws-dashboard] client connected. active=${connectedClients}`);
}

// ─────────────────────────────────────────────────────────────
// Server lifecycle
// ─────────────────────────────────────────────────────────────

/**
 * Start the WebSocket server attached to the given HTTP server.
 * Handles upgrades on the path defined by WS_PATH.
 *
 * Returns the WebSocketServer instance.
 */
export function startWsServer(httpServer: Server): WebSocketServer {
  if (wss) {
    console.warn('[ws-dashboard] already started');
    return wss;
  }

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== WS_PATH) return;

    // Reject the upgrade if there's no registered emitter (WS not fully configured yet)
  if (!_emitter) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket as import('net').Socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', setupClient);

  wss.on('error', (err) => {
    console.error('[ws-dashboard] server error:', (err as Error)?.message ?? String(err));
  });

  // Wire the broadcast emitter so it goes through the public registerEmitter() path.
  registerEmitter(broadcast);

  console.log(`[ws-dashboard] listening on ${WS_PATH}`);
  return wss;
}

/** Return the number of currently connected WebSocket clients. */
export function getConnectedClients(): number {
  return connectedClients;
}

/** Stop the WebSocket server gracefully. */
export function stopWsServer(): void {
  if (!wss) return;

  for (const client of clients) {
    client.terminate();
  }
  clients.clear();
  connectedClients = 0;

  wss.close((err) => {
    if (err) {
      console.error('[ws-dashboard] close error:', (err as Error)?.message ?? String(err));
    } else {
      console.log('[ws-dashboard] server stopped');
    }
  });

  wss = null;
}
