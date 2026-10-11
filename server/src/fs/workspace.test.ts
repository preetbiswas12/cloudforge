import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from './workspace.js';
import { normalizeRel, resolveInRoot, isIgnoredPath, basename, parentOf } from './safePath.js';
import { HttpError } from '../errors.js';

describe('normalizeRel', () => {
  it('normalises separators and redundant segments', () => {
    expect(normalizeRel('src\\app\\index.ts')).toBe('src/app/index.ts');
    expect(normalizeRel('./src//app/index.ts')).toBe('src/app/index.ts');
    expect(normalizeRel('src/app/../index.ts')).toBe('src/index.ts');
    expect(normalizeRel('')).toBe('');
  });

  it('rejects traversal attempts', () => {
    expect(() => normalizeRel('../secrets')).toThrow(HttpError);
    expect(() => normalizeRel('a/../../secrets')).toThrow(HttpError);
    expect(() => normalizeRel('..')).toThrow(HttpError);
  });

  it('rejects absolute paths and null bytes', () => {
    expect(() => normalizeRel('/etc/passwd')).not.toThrow(); // stripped to relative
    expect(normalizeRel('/etc/passwd')).toBe('etc/passwd');
    expect(() => normalizeRel('C:/Windows/system32')).toThrow(HttpError);
    expect(() => normalizeRel('//server/share')).toThrow(HttpError);
    expect(() => normalizeRel('a\0b')).toThrow(HttpError);
  });
});

describe('resolveInRoot', () => {
  const root = path.resolve(os.tmpdir(), 'cf-root');

  it('resolves paths inside the root', () => {
    expect(resolveInRoot(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
    expect(resolveInRoot(root, '')).toBe(root);
  });

  it('never escapes the root', () => {
    expect(() => resolveInRoot(root, '../../../../Windows/System32')).toThrow(HttpError);
    expect(() => resolveInRoot(root, 'src/../../..')).toThrow(HttpError);
  });

  it('is not fooled by sibling directories sharing a name prefix', () => {
    // /tmp/cf-root-evil must be rejected even though the string starts with the root.
    const sibling = `${root}-evil`;
    expect(sibling.startsWith(root)).toBe(true);
    expect(() => resolveInRoot(root, `../${path.basename(sibling)}/secret`)).toThrow(HttpError);
  });
});

describe('isIgnoredPath', () => {
  it('hides dependency and VCS directories', () => {
    expect(isIgnoredPath('node_modules/react/index.js')).toBe(true);
    expect(isIgnoredPath('src/node_modules')).toBe(true);
    expect(isIgnoredPath('.git/config')).toBe(true);
    expect(isIgnoredPath('src/index.js')).toBe(false);
  });
});

describe('path helpers', () => {
  it('splits basenames and parents', () => {
    expect(basename('a/b/c.txt')).toBe('c.txt');
    expect(basename('c.txt')).toBe('c.txt');
    expect(parentOf('a/b/c.txt')).toBe('a/b');
    expect(parentOf('c.txt')).toBe('');
  });
});

describe('WorkspaceService', () => {
  let root: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cf-test-'));
    service = new WorkspaceService(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates, reads and lists files', async () => {
    await service.write('notes/hello.txt', 'hello world');
    const file = await service.read('notes/hello.txt');

    expect(file.content).toBe('hello world');
    expect(file.binary).toBe(false);

    const listing = await service.list('');
    expect(listing.entries.map((entry) => entry.name)).toContain('notes');
  });

  it('sorts directories before files', async () => {
    await service.write('zeta.txt', 'z');
    await service.write('alpha.txt', 'a');
    await service.createFolder('middle');

    const listing = await service.list('');
    expect(listing.entries.map((entry) => entry.name)).toEqual(['middle', 'alpha.txt', 'zeta.txt']);
  });

  it('hides ignored directories from the listing', async () => {
    await service.write('src/index.js', 'x');
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'junk.js'), 'nope');

    const listing = await service.list('');
    expect(listing.entries.map((entry) => entry.name)).toEqual(['src']);
  });

  it('refuses to write into ignored directories', async () => {
    await expect(service.write('node_modules/evil.js', 'x')).rejects.toThrow(HttpError);
  });

  it('refuses to read or write outside the workspace', async () => {
    await expect(service.read('../../../etc/passwd')).rejects.toThrow(HttpError);
    await expect(service.write('../../escaped.txt', 'x')).rejects.toThrow(HttpError);
    await expect(service.list('../..')).rejects.toThrow(HttpError);
  });

  it('detects binary files instead of returning mangled text', async () => {
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const file = await service.read('blob.bin');

    expect(file.binary).toBe(true);
    expect(file.content).toBe('');
  });

  it('renames files and refuses to clobber', async () => {
    await service.write('a.txt', '1');
    await service.write('b.txt', '2');

    const result = await service.rename('a.txt', 'renamed.txt');
    expect(result).toEqual({ from: 'a.txt', to: 'renamed.txt' });
    expect((await service.read('renamed.txt')).content).toBe('1');

    await expect(service.rename('renamed.txt', 'b.txt')).rejects.toThrow(/already exists/);
  });

  it('deletes files and directories recursively', async () => {
    await service.write('dir/nested/file.txt', 'x');
    await service.remove('dir');

    await expect(service.read('dir/nested/file.txt')).rejects.toThrow(/does not exist/);
  });

  it('refuses to delete the workspace root', async () => {
    await expect(service.remove('')).rejects.toThrow(HttpError);
  });

  it('does not allow creating over an existing path', async () => {
    await service.createFile('dup.txt');
    await expect(service.createFile('dup.txt')).rejects.toThrow(/already exists/);
  });

  it('walks files while skipping ignored directories', async () => {
    await service.write('a/one.txt', '1');
    await service.write('b/two.txt', '2');
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'x.js'), 'x');

    const found = await service.walk();
    expect(found.sort()).toEqual(['a/one.txt', 'b/two.txt']);
  });
});