import { useEffect, useRef } from 'react';
import { useEditor } from '../store';

export function Tabs(): JSX.Element | null {
  const tabs = useEditor((state) => state.tabs);
  const active = useEditor((state) => state.active);
  const dirty = useEditor((state) => state.dirty);
  const saving = useEditor((state) => state.saving);
  const setActive = useEditor((state) => state.setActive);
  const closeTab = useEditor((state) => state.closeTab);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when it changes.
  useEffect(() => {
    if (!active || !stripRef.current) return;
    const node = stripRef.current.querySelector(`[data-tab="${CSS.escape(active)}"]`);
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  if (tabs.length === 0) return null;

  return (
    <div className="tabs" ref={stripRef}>
      {tabs.map((path) => {
        const name = path.split('/').pop() ?? path;
        const isDirty = Boolean(dirty[path]);
        const isSaving = Boolean(saving[path]);

        return (
          <div
            key={path}
            data-tab={path}
            className={`tab${active === path ? ' tab--active' : ''}`}
            onMouseDown={(event) => {
              // Middle-click closes, like a browser.
              if (event.button === 1) {
                event.preventDefault();
                closeTab(path);
                return;
              }
              setActive(path);
            }}
            title={path}
          >
            <span className="tab__name">{name}</span>
            <span className="tab__status">
              {isSaving ? <span className="tab__spinner" aria-label="Saving" /> : null}
              {isDirty && !isSaving ? <span className="tab__dot" aria-label="Unsaved" /> : null}
            </span>
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(path);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}