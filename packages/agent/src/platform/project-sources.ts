import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ContextSource, ContextSources, SourceRequest } from '../context';
import { AgentError } from '../storage/types';
import {
  createKnowledgeReadScope,
  KnowledgeReadCleanupError,
  type KnowledgeReadScope,
} from './knowledge-reads';

export interface ProjectSourcesOptions {
  knowledgeScope?: KnowledgeReadScope;
  workspaceRoot(workspaceId: string): Promise<string>;
  /** Host-trusted target selection. Raw caller input is not a filesystem capability. */
  targetPaths?(request: SourceRequest): readonly string[];
}
const names = ['CLAUDE.md', 'AGENTS.md'] as const;
const unavailable = () => new AgentError('context_source_unavailable');
const missing = (error: unknown) => (error as { code?: string })?.code === 'ENOENT';
function inside(root: string, path: string) {
  const value = relative(root, path);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * Bounded discovery and byte snapshots at a host checkpoint. No watcher or recursive
 * workspace scan. This is not a filesystem transaction: external editors can change
 * files after this capture and SQLite cannot make the later I/O atomic with it.
 */
export function createProjectSources(
  options: ProjectSourcesOptions,
): ContextSources & { dispose(): Promise<void> } {
  const scope = options.knowledgeScope ?? createKnowledgeReadScope();
  const captureBatch = (requests: readonly SourceRequest[]): Promise<ContextSource[]> =>
    scope.run(async (files) => {
      try {
        const plans: { request: SourceRequest; root: string; directories: string[] }[] = [];
        const roots = new Map<string, string>();
        const targetDirectories = new Map<string, string>();
        for (const request of requests) {
          let root = roots.get(request.workspaceId);
          if (!root) {
            const selectedRoot = await options.workspaceRoot(request.workspaceId);
            if (!selectedRoot) throw unavailable();
            const original = await lstat(resolve(selectedRoot));
            if (!original.isDirectory() || original.isSymbolicLink()) throw unavailable();
            root = await realpath(resolve(selectedRoot));
            roots.set(request.workspaceId, root);
          }
          const targets = options.targetPaths?.(request) ?? [];
          const directories = new Set<string>([root]);
          for (const target of targets) {
            if (!target || target.includes('\0')) throw unavailable();
            const absolute = resolve(root, target);
            if (!inside(root, absolute)) throw unavailable();
            const parts = relative(root, absolute).split(sep).filter(Boolean);
            // Validate the full target chain before inspecting its final entry. An
            // intermediate symlink is never followed, even when it points inside.
            const targetKey = `${root}\0${absolute}`;
            let directory = targetDirectories.get(targetKey);
            if (!directory) {
              let cursor = root;
              let finalIsDirectory = absolute === root;
              for (let index = 0; index < parts.length; index++) {
                cursor = resolve(cursor, parts[index]!);
                const entry = await stat(cursor);
                if (!entry) break;
                if (entry.isSymbolicLink()) throw unavailable();
                if (index < parts.length - 1 && !entry.isDirectory()) throw unavailable();
                if (index === parts.length - 1) {
                  if (!entry.isDirectory() && !entry.isFile()) throw unavailable();
                  finalIsDirectory = entry.isDirectory();
                }
              }
              directory = finalIsDirectory ? absolute : dirname(absolute);
              targetDirectories.set(targetKey, directory);
            }
            let scope = root;
            for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
              scope = resolve(scope, segment);
              directories.add(scope);
            }
          }
          const ordered = [...directories].sort(
            (a, b) =>
              relative(root, a).split(sep).filter(Boolean).length -
                relative(root, b).split(sep).filter(Boolean).length || (a < b ? -1 : a > b ? 1 : 0),
          );
          plans.push({ request, root, directories: ordered });
        }
        // This byte snapshot belongs only to this checkpoint. Each original request
        // still validates its complete trusted target chain and original file identity.
        const snapshots = new Map<string, { digest: string; content: string } | null>();
        const sources = new Map<string, ContextSource>();
        const checkedDirectories = new Set<string>();
        for (const { request, root, directories } of plans) {
          for (const directory of directories) {
            // Recheck ancestor paths at each read; a newly added directory/symlink
            // cannot widen the host-selected scope silently.
            const directoryKey = `${root}\0${directory}`;
            if (!checkedDirectories.has(directoryKey)) {
              let cursor = root;
              for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
                cursor = resolve(cursor, segment);
                const entry = await stat(cursor);
                if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw unavailable();
              }
              checkedDirectories.add(directoryKey);
            }
            for (const name of names) {
              const path = resolve(directory, name);
              if (!snapshots.has(path)) {
                const before = await stat(path);
                if (!before) {
                  snapshots.set(path, null);
                } else {
                  if (!before.isFile() || before.isSymbolicLink()) throw unavailable();
                  if (!inside(root, await realpath(path))) throw unavailable();
                  await files.read(
                    path,
                    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
                    async (handle) => {
                      const held = await handle.stat();
                      // A replacement inode cannot supply bytes for the original path.
                      if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino)
                        throw unavailable();
                      const bytes = await handle.readFile();
                      if (bytes.includes(0)) throw unavailable();
                      snapshots.set(path, {
                        digest: createHash('sha256').update(bytes).digest('hex'),
                        content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                      });
                    },
                  );
                }
              }
              const snapshot = snapshots.get(path);
              if (!snapshot) continue;
              const local = relative(root, path).split(sep).join('/');
              const id = `project:${request.workspaceId}:${local}`;
              const value: ContextSource = {
                id,
                kind: 'project_instruction',
                role: 'user',
                placement: 'after_history',
                scope: directory,
                digest: snapshot.digest,
                content: `<project-instructions role="workspace-context">\n${local}\n${snapshot.content}\n</project-instructions>`,
              };
              const previous = sources.get(id);
              if (previous && previous.digest !== value.digest)
                throw new AgentError('context_refresh_required');
              sources.set(id, value);
            }
          }
        }
        return [...sources.values()];
      } catch (error) {
        if (error instanceof KnowledgeReadCleanupError) throw error;
        throw unavailable();
      }
    });
  return {
    capture: (request) => captureBatch([request]),
    captureBatch,
    dispose: () => scope.dispose(),
  };
}
