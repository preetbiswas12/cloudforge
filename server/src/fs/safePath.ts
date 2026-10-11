import path from 'node:path';
import { badRequest, forbidden } from '../errors.js';

/**
 * Directories that are never exposed through the file API and never watched.
 * Keeps `node_modules`, VCS metadata and build caches out of the editor and
 * out of git snapshots.
 */
export const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.turbo',
  '.next',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  'venv',
  '.DS_Store',
  'Thumbs.db',
]);

/**
 * Convert a client-supplied path into a clean, relative POSIX path.
 * Throws if the input is malformed or tries to be absolute.
 */
export function normalizeRel(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('Path must be a string');
  if (input.includes('\0')) throw badRequest('Path contains a null byte');

  const unified = input.replace(/\\/g, '/').trim();
  if (unified.length === 0) return '';

  // Reject Windows drive letters and UNC paths before they get resolved.
  if (/^[a-zA-Z]:/.test(unified)) throw forbidden('Absolute paths are not allowed');
  if (unified.startsWith('//')) throw forbidden('UNC paths are not allowed');

  // Strip leading slashes so "///etc/passwd" becomes "etc/passwd" and is then
  // resolved *inside* the workspace rather than at the filesystem root.
  const relative = unified.replace(/^\/+/, '');

  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw forbidden('Path escapes the workspace');
  }

  return normalized;
}

/**
 * Resolve a client path against the workspace root and prove the result is
 * still inside it. This is the single choke point that prevents
 * `../../etc/passwd` and `..\\..\\Windows\\System32` style traversal.
 */
export function resolveInRoot(root: string, input: unknown): string {
  const absoluteRoot = path.resolve(root);
  const relative = normalizeRel(input);
  const absolute = path.resolve(absoluteRoot, relative);

  if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + path.sep)) {
    throw forbidden('Path escapes the workspace');
  }

  return absolute;
}

/** Convert an absolute path inside the root back to a client-facing relative path. */
export function toRel(root: string, absolute: string): string {
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..')) return '';
  return relative.split(path.sep).join('/');
}

/** Should this path be hidden from the file tree, the watcher, and git snapshots? */
export function isIgnoredPath(candidate: string): boolean {
  return candidate
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some((segment) => IGNORED_NAMES.has(segment));
}

/** Parent directory of a relative path, or '' for a top-level entry. */
export function parentOf(relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

/** Final segment of a relative path. */
export function basename(relative: string): string {
  const normalized = relative.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

const INVALID_NAME = /[<>:"|?*\x00-\x1F]/;

/** Validate a single path segment for create/rename operations. */
export function assertValidName(name: unknown): string {
  if (typeof name !== 'string') throw badRequest('Name must be a string');
  const trimmed = name.trim();

  if (trimmed.length === 0) throw badRequest('Name cannot be empty');
  if (trimmed.length > 255) throw badRequest('Name is too long');
  if (INVALID_NAME.test(trimmed)) throw badRequest('Name contains invalid characters');
  if (trimmed === '.' || trimmed === '..') throw badRequest('Name cannot be "." or ".."');
  if (IGNORED_NAMES.has(trimmed)) throw forbidden(`"${trimmed}" is a reserved name`);

  return trimmed;
}