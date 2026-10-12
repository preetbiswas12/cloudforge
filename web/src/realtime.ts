import { authToken } from './api';
import type { ServerEvent } from './types';
import type { LogLine } from './run/runner';

export type { LogLine };

type Status = 'connecting' | 'open' | 'closed';

interface RealtimeOptions {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: Status) => void;
}

const MAX_BACKOFF_MS = 15_000;

/**
 * Auto-reconnecting WebSocket to the server's event stream.
 * Every change written by any browser comes back through here.
 */
export class Realtime {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private disposed = false;

  constructor(private readonly options: RealtimeOptions) {}

  connect(): void {
    this.disposed = false;
    this.open();
  }

  private open(): void {
    if (this.disposed) return;
    this.options.onStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = authToken();
    const url = new URL(`${protocol}//${window.location.host}/ws`);
    if (token) url.searchParams.set('token', token);

    try {
      this.socket = new WebSocket(url.toString());
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener('open', () => {
      this.attempt = 0;
      this.options.onStatus('open');
    });

    this.socket.addEventListener('message', (message) => {
      try {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        this.options.onEvent(event);
      } catch {
        // Ignore malformed frames rather than tearing down the connection.
      }
    });

    this.socket.addEventListener('close', () => {
      this.options.onStatus('closed');
      this.scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      this.socket?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);

    // Exponential backoff so a server restart does not produce a reconnect storm.
    const delay = Math.min(500 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt += 1;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}