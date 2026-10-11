import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/**
 * Monaco needs its language servers running in web workers. Importing them with
 * Vite's `?worker` suffix bundles them locally instead of pulling them from a
 * CDN, so the editor works on locked-down networks and loads fast.
 */
/** Shape of the global Monaco uses to spawn its language-server workers. */
interface MonacoEnvironment {
  getWorker(moduleId: string, label: string): Worker;
}

(globalThis as unknown as { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

export const CLOUDFORGE_DARK = 'cloudforge-dark';
export const CLOUDFORGE_LIGHT = 'cloudforge-light';

const BASE_DARK = vscodeDark();

function vscodeDark(): monaco.editor.IStandaloneThemeData {
  return {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7a8f', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7dd3fc' },
      { token: 'string', foreground: 'a5e887' },
      { token: 'number', foreground: 'fdba74' },
      { token: 'type.identifier', foreground: 'c4b5fd' },
    ],
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#c9d1d9',
      'editorLineNumber.foreground': '#3d4450',
      'editorLineNumber.activeForeground': '#8b949e',
      'editor.selectionBackground': '#264f78aa',
      'editor.lineHighlightBackground': '#ffffff08',
      'editorCursor.foreground': '#58a6ff',
      'editorIndentGuide.background1': '#21262d',
      'editorWidget.background': '#161b22',
      'editorSuggestWidget.background': '#161b22',
      'editorSuggestWidget.border': '#30363d',
      'editorSuggestWidget.selectedBackground': '#1f6feb33',
    },
  };
}

/** Called by @monaco-editor/react before the editor mounts. */
export function configureMonaco(instance: typeof monaco): void {
  instance.editor.defineTheme(CLOUDFORGE_DARK, BASE_DARK);
  instance.editor.defineTheme(CLOUDFORGE_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6e7781', fontStyle: 'italic' },
      { token: 'keyword', foreground: '0550ae' },
      { token: 'string', foreground: '0a7d33' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#00000008',
    },
  });

  instance.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: instance.languages.typescript.ScriptTarget.ESNext,
    jsx: instance.languages.typescript.JsxEmit.ReactJSX,
    moduleResolution: instance.languages.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    isolatedModules: true,
  });

  // Monaco's TS server expects a whole project's worth of node_modules types.
  // Turning off semantic validation keeps the useful syntax highlighting and
  // completions without flagging every import as an error.
  instance.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
  });

  instance.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
  });
}

export { monaco };