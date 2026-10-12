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
      { token: 'comment', foreground: '5f6b80', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'b07cff' },
      { token: 'string', foreground: '3ddc97' },
      { token: 'number', foreground: 'ffc857' },
      { token: 'type.identifier', foreground: '7c8cff' },
      { token: 'type', foreground: '7c8cff' },
      { token: 'identifier', foreground: 'e6e8ee' },
      { token: 'delimiter', foreground: '9ba3b4' },
      { token: 'tag', foreground: '35d6f2' },
      { token: 'attribute.name', foreground: '7c8cff' },
    ],
    colors: {
      'editor.background': '#0a0c11',
      'editor.foreground': '#e6e8ee',
      'editorLineNumber.foreground': '#39415a',
      'editorLineNumber.activeForeground': '#7c8cff',
      'editor.selectionBackground': '#7c8cff33',
      'editor.inactiveSelectionBackground': '#7c8cff1a',
      'editor.lineHighlightBackground': '#ffffff07',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#7c8cff',
      'editorIndentGuide.background1': '#1b1f29',
      'editorIndentGuide.activeBackground1': '#2a3040',
      'editorWhitespace.foreground': '#2a3040',
      'editorBracketMatch.background': '#7c8cff22',
      'editorBracketMatch.border': '#7c8cff88',
      'editorWidget.background': '#14171f',
      'editorWidget.border': '#ffffff14',
      'editorSuggestWidget.background': '#14171f',
      'editorSuggestWidget.border': '#ffffff1f',
      'editorSuggestWidget.selectedBackground': '#7c8cff26',
      'editorSuggestWidget.highlightForeground': '#7c8cff',
      'editorHoverWidget.background': '#14171f',
      'editorHoverWidget.border': '#ffffff1f',
      'minimap.background': '#0a0c1100',
      'scrollbarSlider.background': '#ffffff14',
      'scrollbarSlider.hoverBackground': '#ffffff26',
      'scrollbarSlider.activeBackground': '#7c8cff4d',
      'editorOverviewRuler.border': '#00000000',
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