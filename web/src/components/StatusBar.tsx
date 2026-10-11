import { useEffect } from 'react';
import { useEditor } from '../store';

export function StatusBar(): JSX.Element {
  const status = useEditor((state) => state.status);
  const active = useEditor((state) => state.active);
  const language = useEditor((state) => (state.active ? state.language[state.active] : undefined));
  const content = useEditor((state) => (state.active ? state.contents[state.active] : undefined));
  const dirtyCount = useEditor((state) => Object.keys(state.dirty).length);
  const connected = useEditor((state) => state.connected);
  const peers = useEditor((state) => state.peers);
  const lastSavedAt = useEditor((state) => state.lastSavedAt);
  const refreshStatus = useEditor((state) => state.refreshStatus);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshStatus(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const lines = content ? content.split('\n').length : 0;
  const cursor = 'Ln 1, Col 1';

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className={`status-dot${connected ? ' is-online' : ''}`} title={connected ? 'Live sync connected' : 'Reconnecting…'} />
        <span title={active ?? 'No file open'}>{active ?? 'No file open'}</span>
      </div>

      <div className="status-bar__right">
        {dirtyCount > 0 && <span className="status-chip status-chip--warn">{dirtyCount} unsaved</span>}

        {status?.git.available && (
          <span className="status-chip" title={status.git.lastCommit?.message ?? 'No commits yet'}>
            {status.git.branch ?? 'git'}
            {status.git.pendingChanges > 0 ? ` •${status.git.pendingChanges}` : ''}
          </span>
        )}

        {peers > 1 && <span className="status-chip">{peers} online</span>}

        {lastSavedAt && (
          <span title={new Date(lastSavedAt).toLocaleTimeString()}>
            Saved {relativeTime(lastSavedAt)}
          </span>
        )}

        {active && <span>{language ?? 'plaintext'}</span>}
        {active && <span>{lines} lines</span>}
        <span>{cursor}</span>
      </div>
    </div>
  );
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}