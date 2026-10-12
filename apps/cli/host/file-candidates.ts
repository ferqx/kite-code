import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentClient } from '@kite-ai/client';
import type { TuiFileCandidatesPort, TuiFileScope } from '@kite-ai/ui/tui';
import ignore, { type Ignore } from 'ignore';

import {
  type CandidateDirectory,
  type CandidateIgnoreFile,
  openCandidateDirectory,
} from './file-candidate-filesystem';

const excluded = new Set([
  'node_modules',
  '.git',
  '.kite-code',
  'dist',
  'build',
  '__pycache__',
  '.DS_Store',
  'coverage',
]);
async function config(file: CandidateIgnoreFile, signal: AbortSignal): Promise<Ignore> {
  const before = file.facts();
  if (!before.regular || before.links !== 1) throw new Error('file_candidate_ignore_invalid');
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    buffer = Buffer.alloc(65536);
  let text = '',
    chunks = 0;
  for (;;) {
    const size = file.read(buffer);
    if (!size) break;
    signal.throwIfAborted();
    text += decoder.decode(buffer.subarray(0, size), { stream: true });
    if (++chunks % 16 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  text += decoder.decode();
  if (text.includes('\0')) throw new Error('file_candidate_ignore_invalid');
  if (file.facts().stamp !== before.stamp) throw new Error('file_candidate_ignore_changed');
  return ignore().add(text);
}
function rank(path: string, query: string) {
  let index = 0,
    score = 0,
    streak = 0;
  const p = path.toLowerCase(),
    q = query.toLowerCase();
  for (let i = 0; i < p.length && index < q.length; i++) {
    if (p[i] === q[index]) {
      index++;
      score += 1 + ++streak * 2 + (i === 0 || /[/_-]/.test(p[i - 1]!) ? 5 : 0);
    } else streak = 0;
  }
  return index === q.length ? score : -1;
}
export function createTuiFileCandidates(
  client: Pick<AgentClient, 'getView' | 'listWorkspaces'>,
  admittedStoreId: string,
): TuiFileCandidatesPort {
  let saved:
    | {
        id: string;
        scope: TuiFileScope;
        root: string;
        query: string;
        paths: string[];
        unavailable: { path: string; reason: string }[];
      }
    | undefined;
  async function root(scope: TuiFileScope, signal: AbortSignal) {
    signal.throwIfAborted();
    const view = await client.getView(scope.sessionId, { signal });
    if (
      scope.storeId !== admittedStoreId ||
      view.storeId !== scope.storeId ||
      view.session.id !== scope.sessionId ||
      view.session.workspaceId !== scope.workspaceId ||
      view.session.deletedAt !== null
    )
      throw new Error('file_candidate_scope_mismatch');
    const workspace = (await client.listWorkspaces({ signal })).find(
      (w) => w.id === scope.workspaceId,
    );
    if (!workspace?.rootUri.startsWith('file:'))
      throw new Error('file_candidate_workspace_unavailable');
    return realpathSync(fileURLToPath(workspace.rootUri));
  }
  return {
    async read(scope, input, signal) {
      const canonical = await root(scope, signal);
      const scopeKey = JSON.stringify([scope.storeId, scope.sessionId, scope.workspaceId]);
      let offset = 0;
      if (input.cursor) {
        const cursor = JSON.parse(input.cursor);
        if (
          !saved ||
          !Array.isArray(cursor) ||
          cursor.length !== 2 ||
          cursor[0] !== saved.id ||
          !Number.isSafeInteger(cursor[1]) ||
          cursor[1] < 0 ||
          cursor[1] > saved.paths.length ||
          JSON.stringify([saved.scope.storeId, saved.scope.sessionId, saved.scope.workspaceId]) !==
            scopeKey ||
          saved.query !== input.query ||
          saved.root !== canonical
        )
          throw new Error('file_candidate_cursor_mismatch');
        offset = cursor[1];
      } else {
        const paths: string[] = [],
          unavailable: { path: string; reason: string }[] = [];
        const directory = openCandidateDirectory(canonical);
        try {
          const rootStamp = directory.stamp();
          async function walk(
            dir: CandidateDirectory,
            prefix: string,
            rules: { base: string; matcher: Ignore }[],
          ) {
            signal.throwIfAborted();
            dir.verifyCanonicalPath(prefix ? `${canonical}/${prefix.slice(0, -1)}` : canonical);
            const before = dir.stamp(),
              entries = dir.entries(),
              configuration = entries.find((e) => e.name === '.gitignore');
            if (configuration) {
              if (configuration.type !== 8) throw new Error('file_candidate_ignore_invalid');
              const cf = dir.openIgnoreFile();
              try {
                rules = [...rules, { base: prefix, matcher: await config(cf, signal) }];
              } finally {
                cf.close();
              }
            }
            const start = paths.length;
            for (let index = 0; index < entries.length; index++) {
              if (index % 32 === 0) {
                await new Promise<void>((resolve) => setImmediate(resolve));
                signal.throwIfAborted();
              }
              const e = entries[index]!,
                path = prefix + e.name;
              if (excluded.has(e.name) || (e.name.startsWith('.') && e.name !== '.gitignore'))
                continue;
              if (e.type === 10 || (e.type !== 4 && e.type !== 8)) {
                unavailable.push({ path, reason: 'file_candidate_type_unavailable' });
                continue;
              }
              let ignored = false;
              for (const r of rules) {
                const result = r.matcher.test(
                  path.slice(r.base.length) + (e.type === 4 ? '/' : ''),
                );
                if (result.ignored) ignored = true;
                else if (result.unignored) ignored = false;
              }
              if (ignored) continue;
              if (e.type === 8) {
                paths.push(path);
                continue;
              }
              let child: CandidateDirectory | undefined;
              try {
                child = dir.openDirectory(e.name);
                await walk(child, `${path}/`, rules);
              } catch (error) {
                signal.throwIfAborted();
                unavailable.push({
                  path,
                  reason:
                    error instanceof Error ? error.message : 'file_candidate_directory_unavailable',
                });
              } finally {
                child?.close();
              }
            }
            try {
              dir.verifyCanonicalPath(prefix ? `${canonical}/${prefix.slice(0, -1)}` : canonical);
            } catch (error) {
              paths.splice(start);
              throw error;
            }
            if (dir.stamp() !== before) {
              paths.splice(start);
              throw new Error('file_candidate_directory_changed');
            }
          }
          await walk(directory, '', []);
          const afterRoot = await root(scope, signal);
          directory.verifyCanonicalPath(canonical);
          if (directory.stamp() !== rootStamp || afterRoot !== canonical)
            throw new Error('file_candidate_workspace_changed');
        } finally {
          directory.close();
        }
        signal.throwIfAborted();
        saved = {
          id: crypto.randomUUID(),
          scope: { ...scope },
          root: canonical,
          query: input.query,
          paths: paths
            .map((path) => ({ path, score: rank(path, input.query) }))
            .filter((p) => p.score >= 0)
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
            .map((p) => p.path),
          unavailable,
        };
      }
      const catalog = saved!;
      const paths = catalog.paths.slice(offset, offset + 200),
        next = offset + paths.length;
      return {
        scope: { ...scope },
        query: input.query,
        snapshotId: catalog.id,
        paths,
        nextCursor: next < catalog.paths.length ? JSON.stringify([catalog.id, next]) : null,
        unavailable: catalog.unavailable,
      };
    },
  };
}
