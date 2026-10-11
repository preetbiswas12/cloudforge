import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { env } from '../env.js';
import { logger } from '../logger.js';

export interface GitStatus {
  enabled: boolean;
  available: boolean;
  branch: string | null;
  remote: string | null;
  lastCommit: { hash: string; message: string; date: number } | null;
  pendingChanges: number;
}

export interface EnsureResult {
  /** True when this call created the repository (i.e. a brand new workspace). */
  created: boolean;
}

const AUTOSAVE_GITIGNORE = `# Written by CloudForge
node_modules/
dist/
build/
.env
.env.local
.DS_Store
*.log
`;

/**
 * Wraps a git repository rooted at the workspace directory.
 *
 * This exists for two reasons:
 *  1. Version history for the user's files.
 *  2. Off-host persistence. PaaS disks (Railway, Render, Fly) are ephemeral, so
 *     the workspace is committed and pushed to a remote, then pulled on boot.
 */
export class GitRepo {
  private readonly git: SimpleGit;
  private available = false;

  constructor(private readonly root: string) {
    this.git = simpleGit({ baseDir: root, timeout: { block: 60_000 } });
  }

  get enabled(): boolean {
    return env.git.enabled;
  }

  /**
   * Does the workspace own a `.git` entry?
   *
   * This must NOT use `git rev-parse --is-inside-work-tree`: that returns true
   * whenever the workspace merely sits *inside* some unrelated repository up the
   * directory tree. That would make us adopt a stranger's origin remote and
   * try to pull their code into the user's files.
   */
  private async hasOwnRepository(): Promise<boolean> {
    try {
      const stats = await fs.stat(path.join(this.root, '.git'));
      // A `.git` file (not a directory) is how git worktrees/submodules record it.
      return stats.isDirectory() || stats.isFile();
    } catch {
      return false;
    }
  }

  /** Initialise the repository if needed and make sure a remote is configured. */
  async ensure(): Promise<EnsureResult> {
    if (!this.enabled) {
      logger.info('Git integration disabled by configuration');
      return { created: false };
    }

    let created = false;

    try {
      const isRepo = await this.hasOwnRepository();
      if (!isRepo) {
        created = true;
        logger.info({ root: this.root }, 'Initialising git repository');
        await this.git.raw(['init', '-b', env.git.branch]);
        await this.git.addConfig('user.name', env.git.authorName);
        await this.git.addConfig('user.email', env.git.authorEmail);
        await this.writeGitignore();
      } else {
        await this.git.addConfig('user.name', env.git.authorName);
        await this.git.addConfig('user.email', env.git.authorEmail);
      }

      await this.configureRemote();
      this.available = true;
      return { created };
    } catch (error) {
      this.available = false;
      logger.error({ err: error }, 'Git initialisation failed — version history is disabled');
      return { created };
    }
  }

  /**
   * Inject the token into the remote URL at runtime so credentials never touch disk.
   * Handles both https and scp-style ssh remotes.
   */
  private async configureRemote(): Promise<void> {
    const remotes = await this.git.getRemotes(true);
    const hasOrigin = remotes.some((remote) => remote.name === 'origin');

    if (!env.git.remote) {
      if (hasOrigin) logger.info('GIT_REMOTE not set; using the existing origin remote');
      return;
    }

    const authenticated = injectToken(env.git.remote, env.git.remoteToken);

    if (!hasOrigin) {
      await this.git.addRemote('origin', authenticated);
      logger.info({ remote: redactRemote(authenticated) }, 'Configured git remote');
      return;
    }

    const current = remotes.find((remote) => remote.name === 'origin')?.refs?.['push'] ?? remotes.find((r) => r.name === 'origin')?.refs?.['fetch'];
    if (current !== authenticated) {
      await this.git.removeRemote('origin');
      await this.git.addRemote('origin', authenticated);
      logger.info({ remote: redactRemote(authenticated) }, 'Updated git remote');
    }
  }

  private async writeGitignore(): Promise<void> {
    const file = path.join(this.root, '.gitignore');
    const existing = await fs.readFile(file, 'utf8').catch(() => null);
    if (existing !== null) return;
    await fs.writeFile(file, AUTOSAVE_GITIGNORE, 'utf8');
  }

  async hasChanges(): Promise<boolean> {
    if (!this.available) return false;
    const status = await this.git.status();
    return status.files.length > 0;
  }

  async commit(message: string, options: { allowEmpty?: boolean } = {}): Promise<boolean> {
    if (!this.available) return false;
    try {
      await this.git.add(['--all', '.']);

      // `status()` after `add --all` reports the staged set, so this is the
      // cheapest reliable "is there anything to commit?" check.
      const staged = await this.git.status();
      if (staged.files.length === 0 && !options.allowEmpty) return false;

      await this.git.commit(message);
      logger.info({ message }, 'Created workspace snapshot');
      return true;
    } catch (error) {
      logger.error({ err: error, message }, 'Git commit failed');
      return false;
    }
  }

  private async pendingCount(): Promise<number> {
    const status = await this.git.status();
    return status.files.length;
  }

  async push(): Promise<boolean> {
    if (!this.available) return false;
    const remotes = await this.git.getRemotes(true);
    if (remotes.length === 0) return false;

    try {
      await this.git.push(['--set-upstream', 'origin', env.git.branch]);
      logger.info('Pushed workspace snapshot to remote');
      return true;
    } catch (error) {
      logger.error({ err: error }, 'git push failed');
      return false;
    }
  }

  /** Commit + push in one step. Used by the autosave timer and the manual button. */
  async snapshot(message: string): Promise<{ committed: boolean; pushed: boolean }> {
    const committed = await this.commit(message);
    if (!committed) return { committed: false, pushed: false };
    const pushed = await this.push();
    return { committed, pushed };
  }

  /**
   * Restore the workspace from the remote. This is what makes ephemeral PaaS
   * disks behave like persistent storage across restarts and redeploys.
   */
  async pullOnBoot(): Promise<boolean> {
    if (!this.available) return false;
    const remotes = await this.git.getRemotes(true);
    if (remotes.length === 0) return false;
    if (!env.git.pullOnBoot) return false;

    try {
      await this.git.fetch(['origin', env.git.branch]);
      // Fast-forward only: never clobber local work with an automatic merge.
      await this.git.pull(['--ff-only', 'origin', env.git.branch]);
      logger.info('Restored workspace from remote');
      return true;
    } catch (error) {
      logger.error({ err: error }, 'git pull on boot failed — continuing with local files');
      return false;
    }
  }

  async status(): Promise<GitStatus> {
    const base: GitStatus = {
      enabled: this.enabled,
      available: this.available,
      branch: null,
      remote: null,
      lastCommit: null,
      pendingChanges: 0,
    };

    if (!this.available) return base;

    try {
      const [branch, log, remotes] = await Promise.all([
        this.git.revparse(['--abbrev-ref', 'HEAD']),
        // `raw` returns the plain string; `log()` would hand back a parsed object.
        this.git.raw(['log', '-1', '--format=%H%x1f%s%x1f%ct']),
        this.git.getRemotes(true),
      ]);

      const [hash, message, timestamp] = log.trim().split('\x1f');
      const remote = remotes.find((entry) => entry.name === 'origin');

      return {
        ...base,
        branch: branch.trim() || null,
        remote: remote ? redactRemote(remote.refs?.push ?? remote.refs?.fetch ?? '') : null,
        lastCommit: hash ? { hash, message: message ?? '', date: Number(timestamp ?? 0) * 1000 } : null,
        pendingChanges: await this.pendingCount(),
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to read git status');
      return base;
    }
  }

  /** Commit history for the UI. */
  async log(limit = 20): Promise<Array<{ hash: string; message: string; date: number }>> {
    if (!this.available) return [];
    try {
      const raw = await this.git.raw(['log', `-${limit}`, '--format=%H%x1f%s%x1f%ct']);
      return raw
        .split('\n')
        .map((line: string) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [hash, message, timestamp] = line.split('\x1f');
          return { hash: hash ?? '', message: message ?? '', date: Number(timestamp ?? 0) * 1000 };
        });
    } catch (error) {
      logger.error({ err: error }, 'Failed to read git log');
      return [];
    }
  }
}

/** Add a token to an https remote URL without mutating the value on disk. */
function injectToken(remote: string, token: string): string {
  if (!token) return remote;
  if (!/^https?:\/\//i.test(remote)) return remote;

  try {
    const url = new URL(remote);
    // GitHub style: https://<token>@github.com/owner/repo.git
    url.username = token;
    url.password = '';
    return url.toString();
  } catch {
    return remote;
  }
}

/** Never let a token reach a log line. */
function redactRemote(remote: string): string {
  return remote.replace(/\/\/[^@/]+@/, '//***@');
}