import { useCallback, useEffect, useState } from 'react';
import { CodeEditor } from './components/CodeEditor';
import { FileTree } from './components/FileTree';
import { QuickOpen } from './components/QuickOpen';
import { StatusBar } from './components/StatusBar';
import { Tabs } from './components/Tabs';
import { useEditor } from './store';

export function App(): JSX.Element {
  const ready = useEditor((state) => state.ready);
  const requiresToken = useEditor((state) => state.requiresToken);
  const sidebarVisible = useEditor((state) => state.sidebarVisible);
  const notice = useEditor((state) => state.notice);
  const bootstrap = useEditor((state) => state.bootstrap);

  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Warn before closing the tab with unsaved work in flight.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.keys(useEditor.getState().dirty).length > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Flush pending saves when the user switches away from the tab.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void useEditor.getState().saveAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const setSidebarVisible = useEditor((state) => state.setSidebar);
  const saveAll = useEditor((state) => state.saveAll);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarVisible(!useEditor.getState().sidebarVisible);
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveAll();
      }
    },
    [saveAll, setSidebarVisible],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot__spinner" />
        <p>Connecting to CloudForge…</p>
      </div>
    );
  }

  if (requiresToken) {
    return <TokenGate />;
  }

  return (
    <div className={`app${sidebarVisible ? '' : ' app--no-sidebar'}`}>
      <TopBar onToggleSidebar={() => setSidebarVisible(!sidebarVisible)} />

      <div className="app__body">
        {sidebarVisible && <FileTree />}

        <main className="workspace">
          <Tabs />
          <div className="workspace__editor">
            <CodeEditor onSave={() => void saveAll()} />
          </div>
        </main>
      </div>

      <StatusBar />
      <QuickOpen open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {notice && <Toast />}
    </div>
  );
}

function TopBar({ onToggleSidebar }: { onToggleSidebar: () => void }): JSX.Element {
  const createSnapshot = useEditor((state) => state.createSnapshot);
  const status = useEditor((state) => state.status);

  return (
    <header className="topbar">
      <button type="button" className="icon-btn" onClick={onToggleSidebar} title="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar">
        ☰
      </button>

      <div className="topbar__brand">
        <span className="topbar__logo" aria-hidden="true">
          ◆
        </span>
        <span className="topbar__name">CloudForge</span>
      </div>

      <div className="topbar__spacer" />

      <button type="button" className="btn btn--ghost" onClick={() => void createSnapshot()} title="Commit the current state to git">
        ⎇ Save version
      </button>

      {status?.git.available && status.git.branch && (
        <span className="topbar__branch" title={status.git.remote ?? 'local only'}>
          {status.git.branch}
        </span>
      )}
    </header>
  );
}

function Toast(): JSX.Element | null {
  const notice = useEditor((state) => state.notice);
  const dismiss = useEditor((state) => state.dismissNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => dismiss(), notice.kind === 'error' ? 8000 : 3500);
    return () => window.clearTimeout(timer);
  }, [notice, dismiss]);

  if (!notice) return null;

  return (
    <div className={`toast toast--${notice.kind}`} role="status" onClick={dismiss}>
      {notice.text}
    </div>
  );
}

function TokenGate(): JSX.Element {
  const submitToken = useEditor((state) => state.submitToken);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submitToken(value);
    } catch {
      setError('That token was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={handleSubmit}>
        <h1 className="gate__title">CloudForge</h1>
        <p className="gate__subtitle">This workspace is protected. Enter the editor token to continue.</p>

        <input
          className="gate__input"
          type="password"
          placeholder="Editor token"
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
        />

        {error && <p className="gate__error">{error}</p>}

        <button type="submit" className="btn btn--primary" disabled={busy || value.trim().length === 0}>
          {busy ? 'Checking…' : 'Unlock editor'}
        </button>
      </form>
    </div>
  );
}