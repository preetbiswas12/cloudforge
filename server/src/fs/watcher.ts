import chokidar, { type FSWatcher } from 'chokidar';
import { logger } from '../logger.js';
import { isIgnoredPath, toRel } from './safePath.js';
import type { Hub } from '../realtime/hub.js';

export interface FsChange {
  path: string;
  kind: 'file' | 'dir';
  change: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
}

/**
 * Watches the workspace and pushes changes to connected browsers.
 *
 * This is what makes two people editing the same file at once behave sanely:
 * whichever process touched the disk, every other tab finds out immediately.
 */
export class Watcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly root: string,
    private readonly hub: Hub,
    private readonly debounceMs = 120,
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      depth: 12,
      ignored: (candidate: string) => isIgnoredPath(toRel(this.root, candidate)),
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50,
      },
    });

    const forward = (change: FsChange['change'], kind: FsChange['kind']) => (absolute: string) => {
      const relative = toRel(this.root, absolute);
      if (!relative || isIgnoredPath(relative)) return;
      this.schedule({ path: relative, kind, change });
    };

    this.watcher
      .on('add', forward('add', 'file'))
      .on('change', forward('change', 'file'))
      .on('unlink', forward('unlink', 'file'))
      .on('addDir', forward('addDir', 'dir'))
      .on('unlinkDir', forward('unlinkDir', 'dir'))
      .on('error', (error) => logger.error({ err: error }, 'File watcher error'));

    logger.info({ root: this.root }, 'Watching workspace for changes');
  }

  /** Collapse bursts of writes (e.g. a formatters) into a single event. */
  private schedule(change: FsChange): void {
    const existing = this.timers.get(change.path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(change.path);
      this.hub.broadcast({ type: 'fs:changed', path: change.path, kind: change.kind, change: change.change });
    }, this.debounceMs);

    timer.unref?.();
    this.timers.set(change.path, timer);
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
    logger.debug('File watcher closed');
  }
}