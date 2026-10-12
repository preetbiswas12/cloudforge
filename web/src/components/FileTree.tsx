import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { FOLDER_COLOR, fileIcon, folderIcon } from '../icons';
import type { FsEntry } from '../types';

interface MenuState {
  x: number;
  y: number;
  entry: FsEntry | null;
  parent: string;
}

interface DraftState {
  mode: 'new-file' | 'new-dir' | 'rename';
  parent: string;
  initial: string;
}

/**
 * The tree recurses through many levels, so the "what is being created/renamed"
 * state and the context-menu opener live in context instead of being threaded
 * through every node as props.
 */
interface TreeContextValue {
  draft: DraftState | null;
  setDraft: (draft: DraftState | null) => void;
  openMenu: (event: React.MouseEvent, entry: FsEntry | null, parent: string) => void;
}

const TreeContext = createContext<TreeContextValue>({
  draft: null,
  setDraft: () => undefined,
  openMenu: () => undefined,
});

export function FileTree(): JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);

  const openMenu = useCallback((event: React.MouseEvent, entry: FsEntry | null, parent: string) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 220),
      entry,
      parent,
    });
  }, []);

  // Dismiss the menu on any outside interaction or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const entries = useEditor((state) => state.tree[''] ?? []);

  const context: TreeContextValue = {
    draft,
    setDraft,
    openMenu: (event, entry, parent) => {
      setDraft(null);
      openMenu(event, entry, parent);
    },
  };

  return (
    <div className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">Explorer</span>
        <div className="sidebar__actions">
          <button
            type="button"
            className="icon-btn"
            title="New file"
            aria-label="New file"
            onClick={() => setDraft({ mode: 'new-file', parent: '', initial: '' })}
          >
            +
          </button>
          <button
            type="button"
            className="icon-btn"
            title="New folder"
            aria-label="New folder"
            onClick={() => setDraft({ mode: 'new-dir', parent: '', initial: '' })}
          >
            ⌸
          </button>
        </div>
      </div>

      <div className="sidebar__body" onContextMenu={(event) => openMenu(event, null, '')}>
        {entries.length === 0 && !draft && (
          <p className="sidebar__empty">Empty workspace. Right-click to create a file.</p>
        )}

        <TreeContext.Provider value={context}>
          <TreeLevel dir="" depth={0} />
        </TreeContext.Provider>
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onCreate={(mode, parent) => {
            setDraft({ mode, parent, initial: '' });
            setMenu(null);
          }}
          onRename={() => {
            if (menu.entry) setDraft({ mode: 'rename', parent: menu.parent, initial: menu.entry.name });
            setMenu(null);
          }}
          onDelete={() => {
            if (menu.entry) void useEditor.getState().deleteEntry(menu.entry.path);
            setMenu(null);
          }}
          onOpen={() => {
            if (menu.entry) void useEditor.getState().openFile(menu.entry.path);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** Applies whatever the inline input collected when it commits. */
function commitDraft(draft: DraftState, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  const { parent, initial, mode } = draft;
  const store = useEditor.getState();

  if (mode === 'rename') {
    if (trimmed === initial) return;
    void store.renameEntry(join(parent, initial), join(parent, trimmed));
    return;
  }

  void store.createEntry(parent, trimmed, mode === 'new-dir' ? 'dir' : 'file');
}

interface ContextMenuProps {
  menu: MenuState;
  onClose: () => void;
  onCreate: (mode: 'new-file' | 'new-dir', parent: string) => void;
  onRename: () => void;
  onDelete: () => void;
  onOpen: () => void;
}

function ContextMenu({ menu, onClose, onCreate, onRename, onDelete, onOpen }: ContextMenuProps): JSX.Element {
  const { entry } = menu;

  const remove = () => {
    if (!entry) return;
    const message =
      entry.type === 'dir'
        ? `Delete the folder "${entry.name}" and everything inside it?`
        : `Delete "${entry.name}"?`;
    if (window.confirm(message)) onDelete();
    else onClose();
  };

  return (
    <ul className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
      {entry === null ? (
        <>
          <li>
            <button type="button" onClick={() => onCreate('new-file', menu.parent)}>
              New file
            </button>
          </li>
          <li>
            <button type="button" onClick={() => onCreate('new-dir', menu.parent)}>
              New folder
            </button>
          </li>
        </>
      ) : (
        <>
          {entry.type === 'file' && (
            <li>
              <button type="button" onClick={onOpen}>
                Open
              </button>
            </li>
          )}
          <li>
            <button type="button" onClick={() => onCreate('new-file', menu.parent)}>
              New file here
            </button>
          </li>
          <li>
            <button type="button" onClick={() => onCreate('new-dir', menu.parent)}>
              New folder here
            </button>
          </li>
          <li>
            <button type="button" onClick={onRename}>
              Rename
            </button>
          </li>
          <li className="context-menu__divider" />
          <li>
            <button type="button" className="is-danger" onClick={remove}>
              Delete
            </button>
          </li>
        </>
      )}
    </ul>
  );
}

function TreeLevel({ dir, depth }: { dir: string; depth: number }): JSX.Element | null {
  const { draft, setDraft } = useContext(TreeContext);
  const entries = useEditor((state) => state.tree[dir]);

  // A "new file/folder" draft belongs to this directory, so render the input
  // at the end of its listing (right after the entries) rather than at the root.
  const showCreateInput = Boolean(draft) && draft?.parent === dir && draft?.mode !== 'rename';

  if ((!entries || entries.length === 0) && !showCreateInput) return null;

  return (
    <>
      {(entries ?? []).map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={depth} parent={dir} />
      ))}
      {showCreateInput && draft && (
        <InlineInput
          depth={depth}
          initial=""
          placeholder={draft.mode === 'new-dir' ? 'folder name' : 'file name'}
          onCommit={(value) => {
            setDraft(null);
            commitDraft(draft, value);
          }}
          onCancel={() => setDraft(null)}
        />
      )}
    </>
  );
}

function TreeNode({ entry, depth, parent }: { entry: FsEntry; depth: number; parent: string }): JSX.Element {
  const { draft, setDraft, openMenu } = useContext(TreeContext);
  const expanded = useEditor((state) => Boolean(state.expanded[entry.path]));
  const isActive = useEditor((state) => state.active === entry.path);
  const toggleDir = useEditor((state) => state.toggleDir);
  const openFile = useEditor((state) => state.openFile);

  // While renaming, this row is replaced by an input in place.
  if (draft?.mode === 'rename' && draft.parent === parent && draft.initial === entry.name) {
    return (
      <InlineInput
        depth={depth}
        initial={entry.name}
        onCommit={(value) => {
          setDraft(null);
          void useEditor.getState().renameEntry(entry.path, join(parent, value.trim()));
        }}
        onCancel={() => setDraft(null)}
      />
    );
  }

  const indent = { paddingLeft: 8 + depth * 14 };

  if (entry.type === 'dir') {
    return (
      <>
        <button
          type="button"
          className="tree-row tree-row--dir"
          style={indent}
          onClick={() => toggleDir(entry.path)}
          onContextMenu={(event) => openMenu(event, entry, parent)}
          title={entry.path}
        >
          <span className={`tree-caret${expanded ? ' tree-caret--open' : ''}`} aria-hidden="true" />
          <DirIcon open={expanded} />
          <span className="tree-name">{entry.name}</span>
        </button>

        {expanded && <TreeLevel dir={entry.path} depth={depth + 1} />}
      </>
    );
  }

  return (
    <button
      type="button"
      className={`tree-row${isActive ? ' tree-row--active' : ''}`}
      style={indent}
      onClick={() => void openFile(entry.path)}
      onContextMenu={(event) => openMenu(event, entry, parent)}
      title={entry.path}
    >
      <span className="tree-caret" aria-hidden="true" />
      <FileIcon name={entry.name} />
      <span className="tree-name">{entry.name}</span>
    </button>
  );
}

interface InlineInputProps {
  depth: number;
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

function InlineInput({ depth, initial, placeholder, onCommit, onCancel }: InlineInputProps): JSX.Element {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (initial) {
      // Select the stem so typing replaces the name but keeps the extension.
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
  }, [initial]);

  return (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <input
        ref={inputRef}
        className="tree-input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') onCommit(value);
          if (event.key === 'Escape') onCancel();
        }}
      />
    </div>
  );
}

function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Inline SVG markup, coloured per file type. */
function FileIcon({ name }: { name: string }): JSX.Element {
  const { markup, color } = fileIcon(name);
  return (
    <span className="tree-icon" style={{ color }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />
  );
}

function DirIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <span
      className="tree-icon"
      style={{ color: FOLDER_COLOR }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: folderIcon(open) }}
    />
  );
}