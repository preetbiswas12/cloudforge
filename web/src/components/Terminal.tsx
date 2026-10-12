import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useEditor } from '../store';
import { BrowserRunner, STREAM_STYLE, sandboxLanguageFor, type LogLine } from '../run/runner';
import type { TerminalConfig } from '../types';
import { api } from '../api';

const THEME = {
  background: '#0a0c11',
  foreground: '#e6e8ee',
  cursor: '#7c8cff',
  cursorAccent: '#0a0c11',
  selectionBackground: '#7c8cff40',
  black: '#0a0c11',
  red: '#ff6b6b',
  green: '#3ddc97',
  yellow: '#ffc857',
  blue: '#7c8cff',
  magenta: '#b07cff',
  cyan: '#35d6f2',
  white: '#e6e8ee',
};

export type TerminalTab = 'output' | 'shell';

interface TerminalPanelProps {
  onClose: () => void;
}

/**
 * Bottom-docked panel with two modes:
 *
 *  - "Output": runs JS/TS and Python entirely in a sandboxed iframe. Nothing
 *    touches the server, so this is always available.
 *  - "Shell": a real shell on the server, only when the operator has enabled
 *    it (and paired it with a token). Hidden entirely otherwise.
 */
export function TerminalPanel({ onClose }: TerminalPanelProps): JSX.Element {
  const active = useEditor((state) => state.active);
  const content = useEditor((state) => (state.active ? state.contents[state.active] : undefined));
  const language = useEditor((state) => (state.active ? state.language[state.active] : undefined));
  const saveFile = useEditor((state) => state.saveFile);
  const notify = useEditor((state) => state.notify);

  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const runnerRef = useRef<BrowserRunner | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const shellSessionRef = useRef<string | null>(null);

  const [tab, setTab] = useState<TerminalTab>('output');
  const [config, setConfig] = useState<TerminalConfig>({ enabled: false, reason: null });
  const [busy, setBusy] = useState(false);

  // Sandbox runner, created once, fed by a callback that writes to xterm.
  useEffect(() => {
    const runner = new BrowserRunner((line: LogLine) => writeLine(line));
    runnerRef.current = runner;
    return () => {
      runner.dispose();
      runnerRef.current = null;
    };
    // Intentionally created once: the callback reads xterm via a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One xterm instance for the whole panel; both tabs write into it.
  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.45,
      theme: THEME,
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: false,
      disableStdin: tab !== 'shell',
      fontWeight: '400',
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);

    xtermRef.current = term;
    fitRef.current = fit;

    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // Container may not be laid out yet.
      }
    });

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // Ignore.
      }
    };
    window.addEventListener('resize', onResize);

    term.writeln('\x1b[2mCloudForge terminal\x1b[0m');
    term.writeln('\x1b[2mPress Run, or Ctrl+` to close this panel.\x1b[0m');

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [tab]);

  // Ask the server whether a real shell is available.
  useEffect(() => {
    let cancelled = false;
    void api.terminal().then((result) => {
      if (!cancelled) setConfig(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function writeLine(line: LogLine): void {
    const term = xtermRef.current;
    if (!term) return;
    const color = STREAM_STYLE[line.stream] ?? '#e6e8ee';
    const text = line.text.replace(/\n$/, '');
    term.writeln(`\x1b[38;2;${hexToRgb(color)}${text}\x1b[0m`);
  }

  const runBrowserSandbox = useCallback(async () => {
    if (!active || content === undefined) {
      notify('Open a JavaScript or Python file first', 'info');
      return;
    }
    const target = sandboxLanguageFor(language);
    if (!target) {
      notify(
        `Browser sandbox handles JavaScript, TypeScript and Python. "${language}" needs the shell tab.`,
        'info',
      );
      return;
    }

    setBusy(true);
    try {
      // Save first so the run matches what is on disk.
      if (useEditor.getState().dirty[active]) await saveFile(active);
      await runnerRef.current?.run(target, content);
    } finally {
      setBusy(false);
    }
  }, [active, content, language, notify, saveFile]);

  const openShell = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = window.localStorage.getItem('cloudforge.token');
    const url = new URL(`${protocol}//${window.location.host}/ws`);
    if (token) url.searchParams.set('token', token);

    const socket = new WebSocket(url.toString());
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'terminal:open' }));
      xtermRef.current?.writeln('\x1b[2mConnecting to shell…\x1b[0m');
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        data?: string;
        sessionId?: string;
        message?: string;
        level?: string;
        code?: number | null;
      };

      if (message.type === 'terminal:output' && message.data) {
        xtermRef.current?.write(message.data);
      } else if (message.type === 'terminal:exit') {
        xtermRef.current?.writeln(`\r\n\x1b[2m[session ended${message.code != null ? ` · exit ${message.code}` : ''}]\x1b[0m`);
        shellSessionRef.current = null;
      } else if (message.type === 'toast' && message.level === 'error') {
        xtermRef.current?.writeln(`\x1b[31m${message.message}\x1b[0m`);
      }
    });

    socket.addEventListener('error', () => {
      xtermRef.current?.writeln('\x1b[31mCould not reach the terminal.\x1b[0m');
    });

    // Forward keystrokes to the shell.
    const term = xtermRef.current;
    if (term) {
      term.onData((data) => {
        socket.send(JSON.stringify({ type: 'terminal:input', sessionId: shellSessionRef.current, data }));
      });
    }
  }, []);

  // Capture the assigned session id from the first output frame.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const handler = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { type: string; sessionId?: string };
      if (message.type === 'terminal:output' && message.sessionId && !shellSessionRef.current) {
        shellSessionRef.current = message.sessionId;
      }
    };
    socket.addEventListener('message', handler);
    return () => socket.removeEventListener('message', handler);
  }, [tab]);

  // Release the server shell when the panel goes away, so an abandoned
  // panel does not hold one of the (capped) session slots open.
  useEffect(() => {
    return () => {
      const socket = socketRef.current;
      if (socket && shellSessionRef.current) {
        socket.send(JSON.stringify({ type: 'terminal:close', sessionId: shellSessionRef.current }));
      }
      socket?.close();
      socketRef.current = null;
      shellSessionRef.current = null;
    };
  }, []);

  const runnable = active ? sandboxLanguageFor(language) !== null : false;

  return (
    <div className="terminal">
      <div className="terminal__head">
        <div className="terminal__tabs">
          <button
            type="button"
            className={`terminal__tab${tab === 'output' ? ' is-active' : ''}`}
            onClick={() => setTab('output')}
          >
            Output
          </button>
          {config.enabled && (
            <button
              type="button"
              className={`terminal__tab${tab === 'shell' ? ' is-active' : ''}`}
              onClick={() => {
                setTab('shell');
                if (!socketRef.current) openShell();
              }}
            >
              Shell
              <span className="terminal__warn" title="Runs on the server">
                ⚠
              </span>
            </button>
          )}
        </div>

        <div className="terminal__actions">
          {tab === 'output' && (
            <button
              type="button"
              className="btn btn--ghost terminal__btn"
              onClick={() => void runBrowserSandbox()}
              disabled={!runnable || busy}
              title={runnable ? 'Run in a sandboxed iframe' : 'Open a JS/TS or Python file'}
            >
              {busy ? 'Running…' : '▶ Run'}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Clear"
            onClick={() => xtermRef.current?.clear()}
            aria-label="Clear terminal"
          >
            ⌫
          </button>
          <button type="button" className="icon-btn" onClick={onClose} title="Close (Ctrl+`)" aria-label="Close terminal">
            ×
          </button>
        </div>
      </div>

      <div className="terminal__body" ref={hostRef} />

      {tab === 'shell' && !config.enabled && (
        <div className="terminal__blocked">
          <strong>Server shell is disabled.</strong>
          <span>{config.reason}</span>
        </div>
      )}
      {tab === 'output' && !runnable && (
        <div className="terminal__hint">
          Open a <code>.js</code>, <code>.ts</code> or <code>.py</code> file to run it here.
        </div>
      )}
    </div>
  );
}

function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const int = Number.parseInt(value, 16);
  // xterm expects an SGR sequence, so normalise to decimal RGB.
  return `${(int >> 16) & 255};${(int >> 8) & 255};${int & 255}`;
}