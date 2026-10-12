/**
 * Inline SVG icons. Emoji were the previous approach but they render
 * differently on every OS (and inconsistently on Windows), so file types
 * get proper monochrome glyphs that inherit the accent palette.
 */

const svg = (path: string, fill = 'none') =>
  `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const ICONS: Record<string, string> = {
  // Languages
  ts: svg('<path d="M4 7h9M8.5 7v10M15 10.5c0-1 1-1.6 2-1.6s2 .6 2 1.6v6.4"/><path d="M15 13h3.6"/>'),
  js: svg('<path d="M4 7h9M8.5 7v10M16 10.5c0-1 .9-1.6 1.9-1.6s1.9.6 1.9 1.6v6.4M16 13h3.5"/>'),
  json: svg('<path d="M14 3H7a2 2 0 0 0-2 2v4l-2 3 2 3v4a2 2 0 0 0 2 2h7M10 17l4-5-4-5M18 17V7"/>'),
  css: svg('<path d="M4 4h16l-1.5 14L12 20l-6.5-2z"/><path d="M8 9h8M8 13h4"/>'),
  html: svg('<path d="M4 4h16l-1.5 14L12 20l-6.5-2z"/><path d="M8.5 9.5h7M9 9.5v4a2 2 0 0 0 3 1.2"/>'),
  md: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M7 15V9l3 3 3-3v6M16 9v6M14.2 12.6 16 15l1.8-2.4"/>'),
  py: svg('<path d="M9 3.5c-2.5 0-3 .5-3 2v2h3v1H5c-1.6 0-2 1-2 3s.4 3 2 3h1v-2.2c0-1.5.9-2.3 2.3-2.3H11c1.4 0 2.5-.9 2.5-2.4v-2c0-1.5-.9-2.1-2.5-2.1z"/><path d="M15 20.5c2.5 0 3-.5 3-2v-2h-3v-1h4c1.6 0 2-1 2-3s-.4-3-2-3h-1v2.2c0 1.5-.9 2.3-2.3 2.3H13c-1.4 0-2.5.9-2.5 2.4v2c0 1.5.9 2.1 2.5 2.1z"/>'),
  // Config
  config: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  shell: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
  docker: svg('<path d="M4 13h14v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M4 13l1.5-2H7M8 11V8h3v3M14 11V8h3v3M18 11h2v2"/>'),
  data: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
  // Default
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
};

const EXT_ICON: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'md',
  markdown: 'md',
  py: 'py',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'shell',
  sql: 'data',
  yml: 'config',
  yaml: 'config',
  toml: 'config',
  ini: 'config',
  env: 'config',
  lock: 'config',
  dockerfile: 'docker',
};

/** Accent colour per file type — a subtle cue, not a rainbow. */
const EXT_COLOR: Record<string, string> = {
  ts: '#7c8cff',
  js: '#ffc857',
  json: '#3ddc97',
  css: '#b07cff',
  html: '#35d6f2',
  md: '#9ba3b4',
  py: '#3ddc97',
  shell: '#ffc857',
  config: '#6a7285',
  docker: '#35d6f2',
  data: '#b07cff',
  file: '#6a7285',
};

export function fileIcon(name: string): { markup: string; color: string } {
  const lower = name.toLowerCase();

  let key: string = 'file';
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) key = 'docker';
  else if (lower.startsWith('.env')) key = 'config';
  else {
    const ext = lower.split('.').pop() ?? '';
    key = EXT_ICON[ext] ?? 'file';
  }

  return { markup: ICONS[key] ?? ICONS['file']!, color: EXT_COLOR[key] ?? EXT_COLOR['file']! };
}

export const folderIcon = (open: boolean): string =>
  open
    ? svg('<path d="M4 8a2 2 0 0 1 2-2h3.5l2 2.5H18a2 2 0 0 1 2 2v1"/><path d="M4 8v9a2 2 0 0 0 2 2h13a2 2 0 0 0 1.9-1.4L23 9H7.2a2 2 0 0 0-1.9 1.4z"/>')
    : svg('<path d="M4 7a2 2 0 0 1 2-2h3.5l2 2.5H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>');

export const FOLDER_COLOR = '#8a93a8';