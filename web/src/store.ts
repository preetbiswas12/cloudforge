import { create } from 'zustand';
import { ApiError, api, authToken, clearStoredToken, readStoredToken, storeToken } from './api';
import { Realtime } from './realtime';
import type { FsEntry, ServerEvent, WorkspaceStatus } from './types';

export interface Notice {
  text: string;
  kind: 'info' | 'error' | 'success';
  at: number;
}

const AUTOSAVE_DELAY_MS = 900;

/** Pending autosave timers, keyed by file path. */
const autosaveTimers = new Map<string, number>();

/** Debounce the filesystem broadcasts that arrive while another client writes. */
const refreshTimers = new Map<string, number>();

function scheduleTimer(map: Map<string, number>, key: string, delay: number, run: () => void): void {
  const existing = map.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  map.set(
    key,
    window.setTimeout(() => {
      map.delete(key);
      run();
    }, delay),
  );
}

export interface EditorStore {
  // state
  ready: boolean;
  requiresToken: boolean;
  connected: boolean;
  peers: number;
  tree: Record<string, FsEntry[]>;
  expanded: Record<string, true>;
  tabs: string[];
  active: string | null;
  contents: Record<string, string>;
  language: Record<string, string>;
  binary: Record<string, boolean>;
  dirty: Record<string, true>;
  saving: Record<string, true>;
  status: WorkspaceStatus | null;
  notice: Notice | null;
  lastSavedAt: number | null;
  sidebarVisible: boolean;

  // actions
  bootstrap: () => Promise<void>;
  submitToken: (token: string) => Promise<void>;
  loadDir: (path: string) => Promise<void>;
  toggleDir: (path: string) => void;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  createEntry: (parent: string, name: string, kind: 'file' | 'dir') => Promise<void>;
  renameEntry: (from: string, to: string) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
  createSnapshot: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  setSidebar: (visible: boolean) => void;
  notify: (text: string, kind?: Notice['kind']) => void;
  dismissNotice: () => void;
}

export const useEditor = create<EditorStore>((set, get) => ({
  ready: false,
  requiresToken: false,
  connected: false,
  peers: 0,
  tree: {},
  expanded: { '': true },
  tabs: [],
  active: null,
  contents: {},
  language: {},
  binary: {},
  dirty: {},
  saving: {},
  status: null,
  notice: null,
  lastSavedAt: null,
  sidebarVisible: true,

  async bootstrap() {
    readStoredToken();

    try {
      const config = await api.config();
      if (config.requiresToken && !authToken()) {
        set({ requiresToken: true, ready: true });
        return;
      }
    } catch {
      // Config is advisory; let the first real request surface any auth error.
    }

    connectRealtime(set, get);
    await get().loadDir('');
    await get().refreshStatus();
    set({ ready: true });
  },

  async submitToken(token) {
    storeToken(token.trim());
    set({ requiresToken: false });
    connectRealtime(set, get);
    await get().loadDir('');
    await get().refreshStatus();
    set({ ready: true });
  },

  async loadDir(path) {
    try {
      const listing = await api.list(path);
      set((state) => ({
        tree: { ...state.tree, [path]: listing.entries },
        expanded: { ...state.expanded, [path]: true },
      }));
    } catch (error) {
      handleError(error, get);
      if (error instanceof ApiError && error.isAuthError) return;
      // A missing folder should not spam the user; just clear the listing.
      set((state) => ({ tree: { ...state.tree, [path]: [] } }));
    }
  },

  toggleDir(path) {
    const isOpen = Boolean(get().expanded[path]);

    set((state) => {
      const expanded = { ...state.expanded };
      if (isOpen) delete expanded[path];
      else expanded[path] = true;

      // Drop cached listings for collapsed branches so memory stays bounded.
      if (isOpen) {
        const tree = { ...state.tree };
        for (const key of Object.keys(tree)) {
          if (key === path || key.startsWith(`${path}/`)) delete tree[key];
        }
        return { expanded, tree };
      }
      return { expanded };
    });

    if (!isOpen && get().tree[path] === undefined) void get().loadDir(path);
  },

  async openFile(path) {
    const existing = get().contents[path];
    const alreadyLoaded = existing !== undefined || get().binary[path] === true;
    if (!alreadyLoaded) {
      try {
        const file = await api.read(path);
        set((state) => ({
          contents: { ...state.contents, [path]: file.content },
          language: { ...state.language, [path]: file.language },
          binary: { ...state.binary, [path]: file.binary },
        }));
      } catch (error) {
        handleError(error, get);
        return;
      }
    }

    set((state) => ({
      tabs: state.tabs.includes(path) ? state.tabs : [...state.tabs, path],
      active: path,
    }));
  },

  closeTab(path) {
    const timer = autosaveTimers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    autosaveTimers.delete(path);

    set((state) => {
      const tabs = state.tabs.filter((tab) => tab !== path);
      const active =
        state.active === path ? (tabs[tabs.length - 1] ?? null) : state.active;

      const contents = { ...state.contents };
      const language = { ...state.language };
      const binary = { ...state.binary };
      const dirty = { ...state.dirty };
      delete contents[path];
      delete language[path];
      delete binary[path];
      delete dirty[path];

      return { tabs, active, contents, language, binary, dirty };
    });
  },

  setActive(path) {
    set({ active: path });
  },

  updateContent(path, content) {
    set((state) => ({ contents: { ...state.contents, [path]: content }, dirty: { ...state.dirty, [path]: true } }));

    // Debounce so typing a sentence is one request, not thirty.
    scheduleTimer(autosaveTimers, path, AUTOSAVE_DELAY_MS, () => {
      void get().saveFile(path);
    });
  },

  async saveFile(path) {
    const state = get();
    if (state.saving[path] || !state.dirty[path]) return;
    const content = state.contents[path];
    if (content === undefined) return;

    set((current) => ({ saving: { ...current.saving, [path]: true } }));

    try {
      await api.write(path, content);
      set((current) => {
        const dirty = { ...current.dirty };
        const saving = { ...current.saving };
        delete dirty[path];
        delete saving[path];
        return { dirty, saving, lastSavedAt: Date.now() };
      });
    } catch (error) {
      set((current) => {
        const saving = { ...current.saving };
        delete saving[path];
        return { saving };
      });
      handleError(error, get);
    }
  },

  async saveAll() {
    const { dirty } = get();
    const paths = Object.keys(dirty);
    await Promise.all(paths.map((path) => get().saveFile(path)));

    if (paths.length > 0) {
      get().notify(`Saved ${paths.length} file${paths.length === 1 ? '' : 's'}`, 'success');
    }
  },

  async createEntry(parent, name, kind) {
    const clean = name.trim();
    if (!clean) return;
    const path = parent ? `${parent}/${clean}` : clean;

    try {
      if (kind === 'dir') await api.createFolder(path);
      else await api.createFile(path);

      await get().loadDir(parent);
      if (kind === 'dir') {
        set((state) => ({ expanded: { ...state.expanded, [parent]: true } }));
      } else {
        await get().openFile(path);
      }
    } catch (error) {
      handleError(error, get);
    }
  },

  async renameEntry(from, to) {
    try {
      const result = await api.rename(from, to);
      // Follow the tab across the rename so the user does not lose their place.
      const { tabs, active } = get();

      set((state) => ({
        tabs: tabs.map((tab) => (tab === from ? result.to : tab)),
        active: active === from ? result.to : active,
        contents: moveKey(state.contents, from, result.to),
        language: moveKey(state.language, from, result.to),
        dirty: moveKey(state.dirty, from, result.to) as Record<string, true>,
      }));

      // Flush the edit the user had in flight under the new name.
      await get().loadDir(parentOf(from));
      if (get().dirty[result.to]) await get().saveFile(result.to);
      get().notify(`Renamed to ${result.to}`, 'success');
    } catch (error) {
      handleError(error, get);
    }
  },

  async deleteEntry(path) {
    try {
      await api.remove(path);

      set((state) => {
        const tabs = state.tabs.filter((tab) => tab !== path);
        const contents = { ...state.contents };
        const language = { ...state.language };
        const dirty = { ...state.dirty };
        const binary = { ...state.binary };
        delete contents[path];
        delete language[path];
        delete dirty[path];
        delete binary[path];

        return {
          tabs,
          contents,
          language,
          dirty,
          binary,
          active: state.active === path ? (tabs[tabs.length - 1] ?? null) : state.active,
        };
      });

      await get().loadDir(parentOf(path));
      get().notify(`Deleted ${path}`, 'info');
    } catch (error) {
      handleError(error, get);
    }
  },

  async createSnapshot() {
    try {
      const result = await api.snapshot();
      get().notify(
        result.committed
          ? result.pushed
            ? 'Snapshot saved and pushed to remote'
            : 'Snapshot saved locally'
          : 'No changes to save yet',
        'success',
      );
      await get().refreshStatus();
    } catch (error) {
      handleError(error, get);
    }
  },

  async refreshStatus() {
    try {
      set({ status: await api.status() });
    } catch {
      // Status is informational only — never surface a failure for it.
    }
  },

  setSidebar(visible) {
    set({ sidebarVisible: visible });
  },

  notify(text, kind = 'info') {
    set({ notice: { text, kind, at: Date.now() } });
  },

  dismissNotice() {
    set({ notice: null });
  },
}));

/** Build the WebSocket-backed event plumbing exactly once. */
function connectRealtime(
  set: (partial: Partial<EditorStore>) => void,
  get: () => EditorStore,
): void {
  if (realtimeInstance) realtimeInstance.dispose();

  const realtime = new Realtime({
    onStatus: (status) => set({ connected: status === 'open' }),
    onEvent: (event) => handleServerEvent(event, get),
  });

  realtimeInstance = realtime;
  realtime.connect();
}

let realtimeInstance: Realtime | null = null;

function handleServerEvent(event: ServerEvent, get: () => EditorStore): void {
  switch (event.type) {
    case 'peers':
    case 'hello':
      useEditor.setState({ peers: event.peers ?? 0 });
      return;

    case 'toast':
      if (event.message) get().notify(event.message, event.level === 'error' ? 'error' : 'info');
      return;

    case 'fs:changed': {
      const { path, kind } = event;
      if (!path) return;

      // Coalesce the burst of events a single save produces.
      scheduleTimer(refreshTimers, path, 150, () => {
        void applyExternalChange(path, kind === 'dir');
      });
      return;
    }

    default:
      return;
  }
}

/**
 * Re-sync after a change made outside this browser (another visitor, a git
 * pull, a deploy). Never clobber unsaved local edits — warn instead.
 */
async function applyExternalChange(path: string, isDirectory: boolean): Promise<void> {
  const state = useEditor.getState();
  const parent = parentOf(path);

  if (isDirectory) {
    await state.loadDir(parent);
    return;
  }

  await state.loadDir(parent);

  const isOpen = state.tabs.includes(path);
  if (!isOpen) return;

  try {
    const file = await api.read(path);
    const current = useEditor.getState();

    if (file.content === current.contents[path]) {
      // Same bytes — this was our own save echoing back.
      return;
    }

    if (current.dirty[path]) {
      current.notify(`${path} changed on the server — copy your changes before reloading`, 'error');
      return;
    }

    useEditor.setState((currentState) => ({
      contents: { ...currentState.contents, [path]: file.content },
      language: { ...currentState.language, [path]: file.language },
      binary: { ...currentState.binary, [path]: file.binary },
    }));
  } catch {
    // The file may have been deleted or renamed while it was open.
    const current = useEditor.getState();
    if (current.tabs.includes(path)) {
      current.notify(`${path} is no longer available`, 'error');
      current.closeTab(path);
    }
  }
}

function handleError(error: unknown, get: () => EditorStore): void {
  if (error instanceof ApiError) {
    if (error.isAuthError) {
      clearStoredToken();
      setRequiresToken();
      return;
    }
    get().notify(error.message, 'error');
    return;
  }
  get().notify(error instanceof Error ? error.message : 'Something went wrong', 'error');
}

function setRequiresToken(): void {
  realtimeInstance?.dispose();
  realtimeInstance = null;
  useEditor.setState({
    requiresToken: true,
    connected: false,
    tree: {},
    tabs: [],
    active: null,
    contents: {},
    notice: null,
  });
}

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function moveKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in record)) return record;
  const next = { ...record };
  const value = next[from];
  delete next[from];
  next[to] = value as T;
  return next;
}

/** Flatten the loaded + expanded tree for the quick-open palette. */
export function selectVisibleFiles(state: EditorStore): FsEntry[] {
  const files: FsEntry[] = [];

  const walk = (dir: string): void => {
    for (const entry of state.tree[dir] ?? []) {
      if (entry.type === 'file') files.push(entry);
      else if (state.expanded[entry.path]) walk(entry.path);
    }
  };

  walk('');
  return files;
}

export const selectHasUnsaved = (state: EditorStore): boolean => Object.keys(state.dirty).length > 0;