import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { useMemo, useRef, useState } from 'react';

interface FileMatch {
  name: string;
  path: string;
}

function parseGitignore(dir: string): string[] {
  const gitignorePath = join(dir, '.gitignore');
  if (!existsSync(gitignorePath)) return [];
  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function gitignoreToRegex(pattern: string): RegExp {
  let p = pattern.replace(/\./g, '\\.');
  p = p.replace(/\*\*/g, '__DS__');
  p = p.replace(/\*/g, '[^/]*');
  p = p.replace(/__DS__/g, '.*');
  if (p.endsWith('/.*')) p = `${p.slice(0, -3)}(/.*)?`;
  return new RegExp(`^${p}$`);
}

function listFiles(dir: string, base: string, maxFiles: number = 500): string[] {
  const files: string[] = [];
  const skip = new Set([
    'node_modules',
    '.git',
    '.openpx',
    'dist',
    'build',
    '__pycache__',
    '.DS_Store',
    'coverage',
  ]);

  function walk(current: string, gitignorePatterns: string[]) {
    if (files.length >= maxFiles) return;
    try {
      const localPatterns = parseGitignore(current);
      const allPatterns = gitignorePatterns.concat(localPatterns);

      const entries = readdirSync(current);
      for (const entry of entries) {
        if (skip.has(entry)) continue;
        if (entry.startsWith('.') && entry !== '.gitignore') continue;
        const full = join(current, entry);
        const rel = relative(base, full).replace(/\\/g, '/');

        try {
          const s = statSync(full);
          if (s.isDirectory()) {
            if (!allPatterns.some((p) => gitignoreToRegex(p).test(`${rel}/`))) {
              walk(full, allPatterns);
            }
          } else if (s.isFile()) {
            if (!allPatterns.some((p) => gitignoreToRegex(p).test(rel))) {
              files.push(relative(base, full));
            }
          }
        } catch {
          // permission errors
        }
      }
    } catch {
      // directory not readable
    }
  }

  walk(dir, []);
  return files.slice(0, maxFiles);
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      score += consecutive * 2;
      if (
        ti === 0 ||
        t[ti - 1] === sep ||
        t[ti - 1] === '/' ||
        t[ti - 1] === '-' ||
        t[ti - 1] === '_'
      ) {
        score += 5;
      }
    } else {
      consecutive = 0;
    }
  }

  return qi === q.length ? score : 0;
}

export function useFileSearch(inputValue: string, workspace: string) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Lazy-init: only scan disk when @ is first detected, not on mount
  const filesRef = useRef<string[] | null>(null);

  const query = useMemo(() => {
    const match = inputValue.match(/@(\S*)$/);
    return match ? match[1]! : null;
  }, [inputValue]);

  // Trigger lazy file listing when @ is first detected
  if (query !== null && filesRef.current === null) {
    filesRef.current = listFiles(workspace, workspace);
  }

  // Reset file cache when query goes away (user dismissed @ search)
  if (query === null && filesRef.current !== null) {
    // Keep the cache — clearing and rescanning is more expensive
  }

  const results = useMemo((): FileMatch[] => {
    if (query === null) return [];
    const files = filesRef.current;
    if (!files) return [];
    // Show all files when just @ is typed (empty query)
    if (query.length === 0) {
      return files.slice(0, 8).map((f) => ({
        name: f.split(sep).pop() ?? f,
        path: f,
      }));
    }
    const scored = files
      .map((f) => ({ name: f.split(sep).pop() ?? f, path: f, score: fuzzyScore(query, f) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    return scored.map(({ name, path }) => ({ name, path }));
  }, [query]);

  const active = query !== null;

  const replaceQuery = (file: FileMatch): string => {
    return inputValue.replace(/@\S*$/, `@${file.path}`);
  };

  return {
    query,
    results,
    active,
    selectedIndex,
    setSelectedIndex,
    replaceQuery,
  };
}
