import type { FileContent, Listing, ServerConfig, TerminalConfig, WorkspaceStatus } from './types';

const TOKEN_STORAGE_KEY = 'cloudforge.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/**
 * The editor token lives in the URL once (?token=...), is stored locally, and
 * is sent on every request. Optional — only used when EDITOR_TOKEN is set.
 */
export function readStoredToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    // Clean the URL so the secret is not left in history or shared screenshots.
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return fromUrl;
  }
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function storeToken(token: string): void {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function authToken(): string | null {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = authToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('x-editor-token', token);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, { ...init, headers });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      if (body.code) code = body.code;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(response.status, message, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const query = (path: string) => `?path=${encodeURIComponent(path)}`;

export const api = {
  config: () => request<ServerConfig>('/api/config'),

  list: (path = '') => request<Listing>(`/api/files${query(path)}`),

  /** Flat list of every file path, for the Ctrl+P palette. */
  listAll: () => request<{ paths: string[] }>('/api/files/all'),

  read: (path: string) => request<FileContent>(`/api/file${query(path)}`),

  write: (path: string, content: string) =>
    request<{ path: string; size: number; modifiedAt: number }>('/api/file', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),

  createFile: (path: string) =>
    request<{ path: string }>('/api/file', { method: 'POST', body: JSON.stringify({ path }) }),

  createFolder: (path: string) =>
    request<{ path: string }>('/api/folder', { method: 'POST', body: JSON.stringify({ path }) }),

  rename: (from: string, to: string) =>
    request<{ from: string; to: string }>('/api/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),

  remove: (path: string) => request<{ path: string }>(`/api/file${query(path)}`, { method: 'DELETE' }),

  status: () => request<WorkspaceStatus>('/api/status'),

  /**
   * Whether a real server shell is available. Never throws — an unreachable
   * server simply means no terminal.
   */
  terminal: () => request<TerminalConfig>('/api/terminal').catch(() => ({ enabled: false, reason: null })),

  snapshot: () =>
    request<{ committed: boolean; pushed: boolean }>('/api/snapshot', { method: 'POST' }),
};