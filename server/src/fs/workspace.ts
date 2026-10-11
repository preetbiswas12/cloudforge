import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { badRequest, conflict, forbidden, notFound, tooLarge } from '../errors.js';
import { assertValidName, basename, isIgnoredPath, parentOf, resolveInRoot, toRel } from './safePath.js';

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

/** Map a file extension to a Monaco language id. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.vue': 'html',
  '.svelte': 'html',
  '.svg': 'xml',
  '.xml': 'xml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'plaintext',
  '.env': 'ini',
  '.gitignore': 'plaintext',
  '.dockerfile': 'dockerfile',
  '.lua': 'lua',
  '.dart': 'dart',
  '.r': 'r',
  '.pl': 'perl',
};

export function detectLanguage(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name.startsWith('.env')) return 'ini';
  const ext = path.extname(name);
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

function assertWritable(relPath: string): void {
  if (isIgnoredPath(relPath)) {
    throw badRequest('That path is excluded from the editor');
  }
}

/**
 * All filesystem access for the editor funnels through here.
 * Every method re-resolves and re-validates its inputs against the workspace root.
 */
export class WorkspaceService {
  constructor(readonly root: string) {}

  private abs(input: unknown): { absolute: string; rel: string } {
    const absolute = resolveInRoot(this.root, input);
    return { absolute, rel: toRel(this.root, absolute) };
  }

  async list(input: unknown): Promise<Listing> {
    const { absolute, rel } = this.abs(input);

    let stats;
    try {
      stats = await fs.stat(absolute);
    } catch {
      throw notFound(`"${rel || '/'}" does not exist`);
    }
    if (!stats.isDirectory()) throw badRequest('Not a directory');

    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    const entries: FsEntry[] = [];

    for (const dirent of dirents) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (isIgnoredPath(childRel)) continue;

      const childAbs = path.join(absolute, dirent.name);

      // Use lstat semantics so a broken symlink never crashes the listing.
      let childStats: { size: number; mtimeMs: number } | null = null;
      if (dirent.isFile()) {
        try {
          childStats = await fs.stat(childAbs);
        } catch {
          continue;
        }
      }

      entries.push({
        name: dirent.name,
        path: childRel,
        type: dirent.isDirectory() ? 'dir' : 'file',
        size: childStats?.size ?? 0,
        modifiedAt: childStats?.mtimeMs ?? 0,
      });
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return { path: rel, parent: rel ? parentOf(rel) : null, entries };
  }

  async read(input: unknown): Promise<FileContent> {
    const { absolute, rel } = this.abs(input);
    if (!rel) throw badRequest('Cannot read the workspace root');

    let stats;
    try {
      stats = await fs.stat(absolute);
    } catch {
      throw notFound(`"${rel}" does not exist`);
    }
    if (stats.isDirectory()) throw badRequest('That path is a directory');

    if (stats.size > env.maxFileBytes) {
      throw tooLarge(`"${rel}" is ${formatBytes(stats.size)} — the limit is ${formatBytes(env.maxFileBytes)}`);
    }

    const buffer = await fs.readFile(absolute);
    const binary = looksBinary(buffer);

    return {
      path: rel,
      content: binary ? '' : buffer.toString('utf8'),
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      binary,
      language: detectLanguage(rel),
    };
  }

  async write(input: unknown, content: unknown): Promise<{ path: string; size: number; modifiedAt: number }> {
    const { absolute, rel } = this.abs(input);
    if (!rel) throw badRequest('Cannot write to the workspace root');
    if (typeof content !== 'string') throw badRequest('Content must be a string');

    assertWritable(rel);

    const size = Buffer.byteLength(content, 'utf8');
    if (size > env.maxFileBytes) {
      throw tooLarge(`That file would be ${formatBytes(size)} — the limit is ${formatBytes(env.maxFileBytes)}`);
    }

    let existing: Stats | null = null;
    try {
      existing = await fs.stat(absolute);
    } catch {
      existing = null;
    }
    if (existing?.isDirectory()) throw conflict('A folder already exists at that path');

    await fs.mkdir(path.dirname(absolute), { recursive: true });

    // Write to a sibling temp file then rename, so a crash mid-save can never
    // leave the user with a half-written file.
    const temporary = path.join(
      path.dirname(absolute),
      `.cf-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, absolute);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    const stats = await fs.stat(absolute);
    return { path: rel, size: stats.size, modifiedAt: stats.mtimeMs };
  }

  async createFile(input: unknown): Promise<{ path: string }> {
    const { absolute, rel } = this.abs(input);
    if (!rel) throw badRequest('Missing file name');
    assertWritable(rel);

    if (await exists(absolute)) throw conflict('That path already exists');

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, '', { flag: 'wx' });
    return { path: rel };
  }

  async createFolder(input: unknown): Promise<{ path: string }> {
    const { absolute, rel } = this.abs(input);
    if (!rel) throw badRequest('Missing folder name');
    assertWritable(rel);

    if (await exists(absolute)) throw conflict('That path already exists');

    await fs.mkdir(absolute, { recursive: true });
    return { path: rel };
  }

  async rename(fromInput: unknown, toInput: unknown): Promise<{ from: string; to: string }> {
    const from = this.abs(fromInput);
    const to = this.abs(toInput);
    if (!from.rel || !to.rel) throw badRequest('Cannot rename the workspace root');

    assertWritable(from.rel);
    assertWritable(to.rel);

    if (from.rel === to.rel) return { from: from.rel, to: to.rel };
    if (isIgnoredPath(to.rel)) throw forbidden('That destination is not editable');

    if (!(await exists(from.absolute))) throw notFound(`"${from.rel}" does not exist`);
    if (await exists(to.absolute)) throw conflict(`"${to.rel}" already exists`);

    await fs.mkdir(path.dirname(to.absolute), { recursive: true });
    await fs.rename(from.absolute, to.absolute);

    return { from: from.rel, to: to.rel };
  }

  async remove(input: unknown): Promise<{ path: string }> {
    const { absolute, rel } = this.abs(input);
    if (!rel) throw forbidden('Cannot delete the workspace root');
    assertWritable(rel);

    if (!(await exists(absolute))) throw notFound(`"${rel}" does not exist`);

    const stats = await fs.lstat(absolute);
    if (stats.isDirectory()) {
      await fs.rm(absolute, { recursive: true, force: false });
    } else {
      await fs.unlink(absolute);
    }

    return { path: rel };
  }

  /** Recursively list every file (used to build the .gitignore and to report stats). */
  async walk(limit = 20_000): Promise<string[]> {
    const found: string[] = [];

    const walk = async (absolute: string): Promise<void> => {
      if (found.length >= limit) return;
      const dirents = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (found.length >= limit) return;
        const childAbs = path.join(absolute, dirent.name);
        const childRel = toRel(this.root, childAbs);
        if (isIgnoredPath(childRel)) continue;

        if (dirent.isDirectory()) await walk(childAbs);
        else if (dirent.isFile()) found.push(childRel);
      }
    };

    await walk(this.root);
    return found;
  }
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await fs.lstat(absolute);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}