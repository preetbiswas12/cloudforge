import { logger } from '../logger.js';
import type { WorkspaceService } from './workspace.js';

const WELCOME_MD = `# Welcome to CloudForge

You're editing **real files on a real server**. Everything here is yours.

## Things to try

- Right-click the file tree → **New file** or **New folder**
- \`Ctrl/Cmd + P\` — quick-open any file by name
- \`Ctrl/Cmd + S\` — save now (changes also save automatically)
- \`Ctrl/Cmd + B\` — toggle the sidebar
- Open \`hello.html\` and start typing — it autosaves

## Notes

- Changes sync to everyone else on this domain instantly.
- The workspace is committed to git every few minutes, and on shutdown.
- Delete this file whenever you're ready.
`;

const HELLO_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello from CloudForge</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #0d1117;
        color: #c9d1d9;
      }
      main { text-align: center; padding: 24px; }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(28px, 6vw, 44px);
        background: linear-gradient(90deg, #58a6ff, #3fb950);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      p { margin: 0; color: #8b949e; }
      code {
        padding: 2px 6px;
        border-radius: 4px;
        background: #161b22;
        color: #7dd3fc;
        font-family: ui-monospace, monospace;
        font-size: 0.9em;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Hello, world.</h1>
      <p>Edit <code>hello.html</code> — it saves by itself.</p>
    </main>
  </body>
</html>
`;

/**
 * Drop a couple of starter files into a brand new workspace so the first visit
 * shows a working editor instead of an empty tree.
 */
export async function seedWorkspace(workspace: WorkspaceService): Promise<void> {
  try {
    const existing = await workspace.list('');

    // `.gitignore` is written before seeding runs, so ignore dotfiles when
    // deciding whether this is really a fresh workspace.
    const hasContent = existing.entries.some((entry) => !entry.name.startsWith('.'));
    if (hasContent) return;

    await workspace.write('README.md', WELCOME_MD);
    await workspace.write('hello.html', HELLO_HTML);

    logger.info('Seeded a new workspace with starter files');
  } catch (error) {
    logger.error({ err: error }, 'Failed to seed the workspace');
  }
}