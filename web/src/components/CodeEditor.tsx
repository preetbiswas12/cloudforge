import Editor, { loader, type Monaco } from '@monaco-editor/react';
import { useCallback, useEffect } from 'react';
import { useEditor } from '../store';
import { CLOUDFORGE_DARK, configureMonaco, monaco } from '../monaco';

loader.config({ monaco });

interface CodeEditorProps {
  onSave: () => void;
}

/** The Monaco surface. One model per open file, keyed by path. */
export function CodeEditor({ onSave }: CodeEditorProps): JSX.Element | null {
  const active = useEditor((state) => state.active);
  const content = useEditor((state) => (state.active ? state.contents[state.active] : undefined));
  const language = useEditor((state) => (state.active ? state.language[state.active] : undefined));
  const isBinary = useEditor((state) => (state.active ? state.binary[state.active] : undefined));
  const updateContent = useEditor((state) => state.updateContent);

  const handleBeforeMount = useCallback((instance: Monaco) => {
    configureMonaco(instance as unknown as typeof monaco);
  }, []);

  // Ctrl+S must save through our pipeline (so git + other tabs stay in sync).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSave]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (active && value !== undefined) updateContent(active, value);
    },
    [active, updateContent],
  );

  if (!active) {
    return (
      <div className="editor-empty">
        <div className="editor-empty__inner">
          <div className="editor-empty__mark" aria-hidden="true">
            {'</>'}
          </div>
          <h2>Nothing open</h2>
          <p>
            Pick a file from the sidebar, or hit <kbd>Ctrl</kbd> <kbd>P</kbd> to jump straight to one.
          </p>
        </div>
      </div>
    );
  }

  if (isBinary) {
    return (
      <div className="editor-empty">
        <div className="editor-empty__inner">
          <div className="editor-empty__mark" aria-hidden="true">
            ⚑
          </div>
          <h2>Binary file</h2>
          <p>
            <code>{active}</code> holds non-text data, so there is nothing to edit here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-host">
      <Editor
        // Remounting per file keeps each path's model, undo stack and scroll
        // position independent.
        key={active}
        height="100%"
        path={active}
        language={language ?? 'plaintext'}
        value={content ?? ''}
        beforeMount={handleBeforeMount}
        onChange={handleChange}
        theme={CLOUDFORGE_DARK}
        loading={<div className="editor-loading">Loading editor…</div>}
        options={{
          fontSize: 14,
          fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
          fontLigatures: true,
          lineHeight: 21,
          minimap: { enabled: true, maxColumn: 80, renderCharacters: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderWhitespace: 'selection',
          renderLineHighlight: 'all',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          tabSize: 2,
          insertSpaces: true,
          detectIndentation: true,
          wordWrap: 'off',
          automaticLayout: true,
          padding: { top: 12, bottom: 24 },
          scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
          suggest: { showWords: true },
          quickSuggestions: { other: true, comments: false, strings: false },
          occurrencesHighlight: 'singleFile',
        }}
      />
    </div>
  );
}