import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useEditor } from '../store';

interface QuickOpenProps {
  open: boolean;
  onClose: () => void;
}

const MAX_RESULTS = 50;

interface Hit {
  path: string;
  score: number;
}

/** Ctrl+P palette — fuzzy-searches every file in the workspace. */
export function QuickOpen({ open, onClose }: QuickOpenProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [allPaths, setAllPaths] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const openFile = useEditor((state) => state.openFile);

  // Fetch the flat file list each time the palette opens so it reflects the
  // current workspace, including files inside collapsed folders.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    requestAnimationFrame(() => inputRef.current?.focus());

    let cancelled = false;
    void api
      .listAll()
      .then((result) => {
        if (!cancelled) setAllPaths(result.paths);
      })
      .catch(() => {
        if (!cancelled) setAllPaths([]);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const scored: Hit[] = [];
    for (const path of allPaths) {
      const score = scorePath(path, query);
      if (score > 0) scored.push({ path, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, MAX_RESULTS);
  }, [allPaths, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const commit = (path: string | undefined) => {
    if (!path) return;
    void openFile(path);
    onClose();
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Quick open">
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Search files by name…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelected((current) => Math.min(current + 1, hits.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              commit(hits[selected]?.path);
            }
          }}
        />

        <ul className="palette__results">
          {hits.length === 0 && (
            <li className="palette__empty">{allPaths.length === 0 ? 'No files yet' : 'No matching files'}</li>
          )}
          {hits.map((hit, index) => (
            <li key={hit.path}>
              <button
                type="button"
                className={`palette__item${index === selected ? ' is-selected' : ''}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => commit(hit.path)}
              >
                <span className="palette__name">{baseName(hit.path)}</span>
                <span className="palette__path">{dirOf(hit.path)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Subsequence match in the spirit of VS Code: every query character must appear
 * in order. Rewards consecutive characters, and matches inside the file name
 * over matches buried in the directory path.
 */
function scorePath(path: string, query: string): number {
  if (query === '') return 1;

  const needle = query.toLowerCase().replace(/\s+/g, '');
  const nameStart = path.lastIndexOf('/') + 1;
  const name = path.slice(nameStart).toLowerCase();
  const haystack = path.toLowerCase();

  let total = 0;
  let streak = 0;

  // Prefer matching inside the filename.
  let nameIndex = 0;
  let nameScore = 0;
  let nameStreak = 0;
  for (const char of needle) {
    const found = name.indexOf(char, nameIndex);
    if (found === -1) {
      nameScore = 0;
      break;
    }
    nameStreak = found === nameIndex ? nameStreak + 1 : 0;
    nameScore += 10 + nameStreak * 5;
    nameIndex = found + 1;
  }
  total += nameScore * 2;

  let pathIndex = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, pathIndex);
    if (found === -1) return 0;
    streak = found === pathIndex ? streak + 1 : 0;
    total += 10 + streak * 5;
    pathIndex = found + 1;
  }

  // Shorter paths are usually the more specific match.
  return total - path.length * 0.1;
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? 'workspace root' : path.slice(0, index);
}