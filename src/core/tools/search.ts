import { readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import type { ShellResult } from '@/core/types';
import { readTextContent } from './file';
import { msys2ToWindowsPath } from './path-utils';

interface SearchFilesInput {
  workspace: string;
  pattern: unknown;
  path?: unknown;
}

interface SearchContentInput {
  workspace: string;
  pattern: unknown;
  path?: unknown;
  glob?: unknown;
}

const SKIP_DIRS = new Set(['.git']);

export function searchFiles(input: SearchFilesInput): ShellResult {
  try {
    const pattern = String(input.pattern || '*');
    const rawPath = msys2ToWindowsPath(String(input.path || '.'));
    const root = resolve(input.workspace, rawPath);
    const matches: string[] = [];

    for (const file of walkFiles(input.workspace, root)) {
      const rel = toPosix(relative(input.workspace, file));
      if (matchesFilePattern(rel, pattern)) {
        matches.push(rel);
      }
    }

    matches.sort();
    return {
      ok: true,
      command: `search_files ${pattern}`,
      exitCode: 0,
      stdout: matches.length ? `${matches.join('\n')}\n` : '',
      stderr: '',
    };
  } catch (error) {
    return failed(`search_files ${String(input.pattern || '')}`, error);
  }
}

export function searchContent(input: SearchContentInput): ShellResult {
  const pattern = String(input.pattern || '');
  try {
    const rawPath = msys2ToWindowsPath(String(input.path || '.'));
    const root = resolve(input.workspace, rawPath);
    const regex = new RegExp(pattern);
    const glob = input.glob === undefined ? null : String(input.glob);
    const lines: string[] = [];

    for (const file of walkFiles(input.workspace, root)) {
      const rel = toPosix(relative(input.workspace, file));
      if (glob && !matchesFilePattern(rel, glob)) {
        continue;
      }

      const read = readTextContent(input.workspace, rel);
      if (!read.ok) {
        continue;
      }

      const fileLines = read.content.split('\n');
      for (let index = 0; index < fileLines.length; index++) {
        const line = fileLines[index]!;
        if (regex.test(line)) {
          lines.push(`${rel}:${index + 1}:${line}`);
        }
      }
    }

    return {
      ok: true,
      command: `search_content ${pattern}`,
      exitCode: 0,
      stdout: lines.length ? `${lines.join('\n')}\n` : '',
      stderr: '',
    };
  } catch (error) {
    return failed(`search_content ${pattern}`, error);
  }
}

function* walkFiles(workspace: string, root: string): Generator<string> {
  const workspaceRoot = resolve(workspace);
  const resolvedRoot = resolve(root);
  const relRoot = relative(workspaceRoot, resolvedRoot);
  if (relRoot && (relRoot === '..' || relRoot.startsWith('..\\') || relRoot.startsWith('../'))) {
    throw new Error(`Refusing search outside workspace: ${root}`);
  }

  const stat = statSync(resolvedRoot);
  if (stat.isFile()) {
    yield resolvedRoot;
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const child = resolve(resolvedRoot, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(workspaceRoot, child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

function matchesFilePattern(relativePath: string, pattern: string): boolean {
  const normalized = toPosix(pattern || '*');
  const target = normalized.includes('/') ? relativePath : basename(relativePath);
  return globToRegExp(normalized.includes('/') ? normalized : normalized).test(target);
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    const next = glob[i + 1];
    if (char === '*') {
      if (next === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char === '{') {
      const close = glob.indexOf('}', i + 1);
      if (close !== -1) {
        const choices = glob
          .slice(i + 1, close)
          .split(',')
          .map((choice) => escapeRegExp(choice))
          .join('|');
        pattern += `(?:${choices})`;
        i = close;
      } else {
        pattern += '\\{';
      }
    } else {
      pattern += escapeRegExp(char);
    }
  }
  return new RegExp(`${pattern}$`);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function failed(command: string, error: unknown): ShellResult {
  return {
    ok: false,
    command,
    exitCode: -1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  };
}
