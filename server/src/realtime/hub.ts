import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger.js';

export type ServerEvent =
  | { type: 'hello'; clientId: string; peers: number }
  | { type: 'peers'; peers: number }
  | { type: 'fs:changed'; path: string; kind: 'file' | 'dir'; change: string }
  | { type: 'toast'; level: 'info' | 'error'; message: string }
  | { type: 'terminal:output'; sessionId: string; data: string }
  | { type: 'terminal:exit'; sessionId: string; code?: number | null }
  | { type: 'pong' };

/** Messages a client may send up the socket. */
export interface ClientEvent {
  type: 'ping' | 'terminal:open' | 'terminal:input' | 'terminal:close';
  data?: string;
  sessionId?: string;
}

interface Client {
  id: string;
  socket: WebSocket;
  alive: boolean;
}

/**
 * Fan-out hub for live updates. Any change made by one browser is pushed to all
 * connected browsers, which keeps every visitor on the same files in sync.
 */
export class Hub {
  private readonly clients = new Map<string, Client>();
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** Optional hook for handling client->server messages (currently terminal). */
  private onMessage: ((clientId: string, message: ClientEvent) => void) | null = null;

  setMessageHandler(handler: (clientId: string, message: ClientEvent) => void): void {
    this.onMessage = handler;
  }

  /** Attach to an existing HTTP server on the given path (no separate port). */
  attach(server: Server, path: string, authorize: (req: IncomingMessage) => boolean): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith(path)) {
        socket.destroy();
        return;
      }
      if (!authorize(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.wss?.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (socket) => this.register(socket));

    // Drop sockets that stop answering pings (laptop closed, dropped network).
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          client.socket.terminate();
          this.clients.delete(client.id);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          this.clients.delete(client.id);
        }
      }
    }, 30_000);
    this.heartbeat.unref?.();

    logger.info({ path }, 'Realtime channel attached');
  }

  private register(socket: WebSocket): void {
    const id = crypto.randomBytes(8).toString('hex');
    const client: Client = { id, socket, alive: true };
    this.clients.set(id, client);

    this.send(id, { type: 'hello', clientId: id, peers: this.clients.size });
    this.broadcastPeers();

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw)) as ClientEvent;
        if (message?.type === 'ping') {
          this.send(id, { type: 'pong' });
          return;
        }
        this.onMessage?.(id, message);
      } catch {
        // Ignore malformed client frames.
      }
    });
    socket.on('close', () => {
      this.clients.delete(id);
      this.broadcastPeers();
    });
    socket.on('error', (error) => {
      logger.warn({ err: error, id }, 'WebSocket error');
      this.clients.delete(id);
    });
  }

  /** Send an event to one specific client (used to scope terminal output). */
  sendTo(clientId: string, event: ServerEvent): void {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(event));
    } catch {
      // Dead socket; the close handler cleans it up.
    }
  }

  get peerCount(): number {
    return this.clients.size;
  }

  broadcast(event: ServerEvent, exceptId?: string): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (client.id === exceptId) continue;
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      try {
        client.socket.send(payload);
      } catch {
        // Socket died mid-send; the close handler will clean it up.
      }
    }
  }

  broadcastPeers(): void {
    this.broadcast({ type: 'peers', peers: this.clients.size });
  }

  private send(id: string, event: ServerEvent): void {
    const client = this.clients.get(id);
    if (!client || client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(event));
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients.values()) client.socket.close(1001, 'Server shutting down');
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }
}