export type RunnerMode = 'browser' | 'shell';

export interface LogLine {
  stream: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'input' | 'system';
  text: string;
}

/** ANSI colours for the sandboxed output, so warnings read at a glance. */
export const STREAM_STYLE: Record<LogLine['stream'], string> = {
  log: '#e6e8ee',
  info: '#7c8cff',
  warn: '#ffc857',
  error: '#ff6b6b',
  debug: '#6a7285',
  input: '#3ddc97',
  system: '#6a7285',
};

/** Languages the in-browser sandbox knows how to run. */
export const BROWSER_LANGUAGES = new Set([
  'javascript',
  'typescript',
  'jsx',
  'python',
]);

/** Map a Monaco language id onto a sandbox language, if supported. */
export function sandboxLanguageFor(language: string | undefined): 'javascript' | 'python' | null {
  switch (language) {
    case 'javascript':
    case 'typescript':
      return 'javascript';
    case 'python':
      return 'python';
    default:
      return null;
  }
}

/**
 * Runs code inside a sandboxed iframe on an opaque origin.
 *
 * The iframe has `sandbox="allow-scripts"` with no `allow-same-origin`, so the
 * executing code cannot touch this app, its storage, its cookies, or the
 * server. Nothing in it performs a fetch back to our origin.
 */
export class BrowserRunner {
  private iframe: HTMLIFrameElement | null = null;
  private ready = false;
  private pending: ((result: { ok: boolean; logs: LogLine[]; error: string | null }) => void) | null = null;
  private nextId = 1;

  constructor(private readonly onLine: (line: LogLine) => void) {}

  private ensureIframe(): HTMLIFrameElement {
    if (this.iframe) return this.iframe;

    const frame = document.createElement('iframe');
    frame.src = '/sandbox.html';
    // No allow-same-origin: the sandbox gets a unique opaque origin, so the
    // code it runs cannot reach back into this page or our API.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';

    window.addEventListener('message', this.handleMessage);
    document.body.appendChild(frame);

    this.iframe = frame;
    return frame;
  }

  private handleMessage = (event: MessageEvent): void => {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;

    const message = event.data as
      | { type: 'ready' }
      | { type: 'duration'; ms: number }
      | { type: 'result'; id: number; ok: boolean; logs: LogLine[]; error: string | null };

    if (message.type === 'ready') {
      this.ready = true;
      return;
    }
    if (message.type !== 'result' || !this.pending) return;
    // Only accept the reply for the run we are actually waiting on.
    if (message.id !== this.lastId) return;

    const resolve = this.pending;
    this.pending = null;
    resolve?.({ ok: message.ok, logs: message.logs ?? [], error: message.error ?? null });
  };

  private lastId = 0;

  /** True once the sandbox iframe has signalled it is ready. */
  get isReady(): boolean {
    return this.ready;
  }

  async run(language: 'javascript' | 'python', code: string): Promise<void> {
    const frame = this.ensureIframe();

    if (!this.ready) {
      await new Promise<void>((resolve) => {
        const timer = window.setInterval(() => {
          if (this.ready) {
            window.clearInterval(timer);
            resolve();
          }
        }, 30);
        window.setTimeout(() => {
          window.clearInterval(timer);
          resolve();
        }, 8000);
      });
    }

    const id = this.nextId++;
    this.lastId = id;

    this.onLine({ stream: 'system', text: `Running ${language} in your browser — the server is not involved.` });

    const result = await new Promise<{ ok: boolean; logs: LogLine[]; error: string | null }>((resolve) => {
      this.pending = resolve;
      frame.contentWindow?.postMessage({ type: 'run', id, language, code }, '*');

      // Hard stop: a runaway loop in the iframe must not wedge the UI.
      window.setTimeout(() => {
        if (this.pending !== resolve) return;
        this.pending = null;
        resolve({
          ok: false,
          logs: [],
          error: 'Execution timed out after 10 seconds and was stopped.',
        });
      }, 10_000);
    });

    for (const line of result.logs) this.onLine(line);
    if (result.error) {
      this.onLine({ stream: 'error', text: result.error });
    }
  }

  dispose(): void {
    window.removeEventListener('message', this.handleMessage);
    this.iframe?.remove();
    this.iframe = null;
    this.ready = false;
    this.pending = null;
  }
}