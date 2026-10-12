export interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: number;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  binary: boolean;
  language: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  date: number;
}

export interface GitStatus {
  enabled: boolean;
  available: boolean;
  branch: string | null;
  remote: string | null;
  lastCommit: GitCommit | null;
  pendingChanges: number;
}

export interface WorkspaceStatus {
  root: string;
  entries: number;
  git: GitStatus;
  peers: number;
}

export interface ServerConfig {
  requiresToken: boolean;
  maxFileBytes: number;
}

export interface ServerEvent {
  type: 'hello' | 'peers' | 'fs:changed' | 'toast' | 'pong' | 'terminal:output' | 'terminal:exit';
  clientId?: string;
  peers?: number;
  path?: string;
  kind?: 'file' | 'dir';
  change?: string;
  level?: 'info' | 'error';
  message?: string;
  sessionId?: string;
  data?: string;
  code?: number | null;
}

/** Terminal capability, as reported by the server. */
export interface TerminalConfig {
  enabled: boolean;
  reason: string | null;
}