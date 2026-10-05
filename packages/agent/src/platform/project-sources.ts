import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ContextSource, ContextSources, SourceRequest } from '../context';
import { AgentError } from '../storage/types';

export interface ProjectSourcesOptions {
  workspaceRoot(workspaceId: string): Promise<string>;
  /** Host-trusted target selection. Raw caller input is not a filesystem capability. */
  targetPaths?(request: SourceRequest): readonly string[];
}
const limits = {
  targets: 64,
  depth: 32,
  directories: 256,
  path: 4096,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
};
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
export function createProjectSources(options: ProjectSourcesOptions): ContextSources {
  return {
    async capture(request) {
      try {
        const selectedRoot = await options.workspaceRoot(request.workspaceId);
        if (!selectedRoot || selectedRoot.length > limits.path) throw unavailable();
        const original = await lstat(resolve(selectedRoot));
        if (!original.isDirectory() || original.isSymbolicLink()) throw unavailable();
        const root = await realpath(resolve(selectedRoot));
        if (root.length > limits.path) throw unavailable();
        const targets = options.targetPaths?.(request) ?? [];
        if (targets.length > limits.targets) throw unavailable();
        const directories = new Set<string>([root]);
        for (const target of targets) {
          if (!target || target.length > limits.path || target.includes('\0')) throw unavailable();
          const absolute = resolve(root, target);
          if (absolute.length > limits.path || !inside(root, absolute)) throw unavailable();
          const parts = relative(root, absolute).split(sep).filter(Boolean);
          if (parts.length > limits.depth) throw unavailable();
          // Validate the full target chain before inspecting its final entry. An
          // intermediate symlink is never followed, even when it points inside.
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
          const directory = finalIsDirectory ? absolute : dirname(absolute);
          let scope = root;
          for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
            scope = resolve(scope, segment);
            directories.add(scope);
          }
          if (directories.size > limits.directories) throw unavailable();
        }
        const ordered = [...directories].sort(
          (a, b) =>
            relative(root, a).split(sep).filter(Boolean).length -
              relative(root, b).split(sep).filter(Boolean).length || (a < b ? -1 : a > b ? 1 : 0),
        );
        const sources: ContextSource[] = [];
        let totalBytes = 0;
        for (const directory of ordered) {
          // Recheck ancestor paths at each read; a newly added directory/symlink
          // cannot widen the host-selected scope silently.
          let cursor = root;
          for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
            cursor = resolve(cursor, segment);
            const entry = await stat(cursor);
            if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw unavailable();
          }
          for (const name of names) {
            const path = resolve(directory, name);
            if (path.length > limits.path) throw unavailable();
            const before = await stat(path);
            if (!before) continue;
            if (!before.isFile() || before.isSymbolicLink() || before.size > limits.fileBytes)
              throw unavailable();
            if (!inside(root, await realpath(path))) throw unavailable();
            const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
              const held = await handle.stat();
              // Check identity before reading any bytes. Path replacement with a
              // different inode is rejected rather than reading its contents.
              if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino)
                throw unavailable();
              const buffer = Buffer.alloc(limits.fileBytes + 1);
              let length = 0;
              while (length < buffer.length) {
                const chunk = await handle.read(buffer, length, buffer.length - length, length);
                if (!chunk.bytesRead) break;
                length += chunk.bytesRead;
              }
              totalBytes += length;
              if (length > limits.fileBytes || totalBytes > limits.totalBytes) throw unavailable();
              const bytes = buffer.subarray(0, length);
              if (bytes.includes(0)) throw unavailable();
              const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              const local = relative(root, path).split(sep).join('/');
              sources.push({
                id: `project:${request.workspaceId}:${local}`,
                kind: 'project_instruction',
                scope: directory,
                digest: createHash('sha256').update(bytes).digest('hex'),
                content,
              });
            } finally {
              await handle.close();
            }
          }
        }
        return sources;
      } catch {
        throw unavailable();
      }
    },
  };
}
