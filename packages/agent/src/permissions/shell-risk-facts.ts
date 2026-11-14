import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Json } from '../storage/types';
import { AgentError } from '../storage/types';
import { createWorkspaceFiles } from '../tools/files';
import { ripgrepRiskFacts } from './shell-rg-facts';

export { ripgrepRiskFacts } from './shell-rg-facts';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason: string): Record<string, Json> => ({
  availability: 'unavailable',
  reason,
});

export interface ShellRiskSnapshot {
  path: string;
  hash: string;
  device: string;
  inode: string;
}
export interface ShellRiskScope {
  filesystem: 'workspace_write' | 'full_access';
  network: 'none' | 'internet';
}

/** Byte capture is confined to this Workspace, even for a full_access command. */
export function createShellRiskPreparer(input: {
  workspaceRoot: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  rgPath: string;
  interpreterPaths: readonly string[];
  protectedPaths: readonly string[];
  binding: Json;
  sanitizedEnvironment: boolean;
  classify(
    command: string,
    signal: AbortSignal,
    cwd: string,
  ): Promise<{
    plainCommands: readonly (readonly string[])[] | null;
    powerShell?: { readonly entryScript?: string };
  }>;
  rewritten(command: string): Promise<boolean>;
}) {
  const limit = 64 * 1024;
  const workspace = input.workspaceRoot;
  async function read(path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    // Host paths and the Workspace may use different filesystem aliases. Keep
    // both spellings, and resolve existing protected paths before any byte read.
    const aliases = await Promise.all(
      input.protectedPaths.map((value) => realpath(value).catch(() => value)),
    );
    signal.throwIfAborted();
    const denied = [...input.protectedPaths, ...aliases];
    const rootProtected = denied.some((value) => {
      const local = relative(resolve(value), workspace);
      return !local || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
    });
    if (rootProtected) throw new AgentError('shell_review_protected_path');
    const protectedPaths = denied.flatMap((value) => {
      const local = relative(workspace, resolve(value));
      return local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
        ? [local.replaceAll('\\', '/')]
        : [];
    });
    const files = createWorkspaceFiles({
      root: workspace,
      strictReads: true,
      protectedPaths,
      protectReads: true,
    });
    try {
      const local = files.relativePath(resolve(input.cwd, path));
      const value = await files.readBytes(local, { maxBytes: limit });
      signal.throwIfAborted();
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value.bytes);
      if (text.includes('\0')) throw new AgentError('shell_review_binary_entry');
      return {
        material: {
          path,
          resolvedPath: resolve(workspace, local),
          availability: 'available',
          hash: value.baseline.hash,
          byteLength: value.bytes.byteLength,
          encoding: 'utf-8',
          text,
          complete: true,
        } as Record<string, Json>,
        snapshot: {
          path,
          hash: value.baseline.hash,
          device: value.baseline.device,
          inode: value.baseline.inode,
        },
      };
    } finally {
      await files.close();
    }
  }
  async function executable(name: string, signal: AbortSignal) {
    if (name.includes('/') || name.includes('\\')) {
      signal.throwIfAborted();
      return realpath(resolve(input.cwd, name)).catch(() => null);
    }
    const path = Object.entries(input.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    for (const directory of path.split(delimiter)) {
      signal.throwIfAborted();
      const candidate = resolve(input.cwd, directory, name);
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {}
    }
    return null;
  }
  return {
    async prepare(command: string, scope: ShellRiskScope, signal: AbortSignal) {
      signal.throwIfAborted();
      const classified = await input.classify(command, signal, input.cwd);
      signal.throwIfAborted();
      const commands = classified.plainCommands;
      const directScripts: Record<string, Json>[] = [];
      const snapshots: ShellRiskSnapshot[] = [];
      let facts: Record<string, Json> = unavailable('not_single_literal_invocation');
      let reusable = false;
      const entryScript = classified.powerShell?.entryScript;
      let paths: string[] = entryScript ? [entryScript] : [];
      let bundledRg = false;
      if (commands?.length === 1) {
        const argv = commands[0]!;
        const name = argv[0]!;
        const rewritten = await input.rewritten(command);
        const resolved = rewritten ? input.rgPath : await executable(name, signal);
        const environmentKnown =
          input.sanitizedEnvironment ||
          !Object.keys(input.env).some((key) => /^(?:BASH_ENV|ENV|ZDOTDIR|BASH_FUNC_)/.test(key));
        bundledRg =
          (name === 'rg' || name === 'rg.exe' || name === input.rgPath) &&
          resolved === input.rgPath;
        if (bundledRg && environmentKnown && (rewritten || !input.env.RIPGREP_CONFIG_PATH)) {
          const parsed = ripgrepRiskFacts(argv);
          facts = {
            ...parsed,
            program: {
              identity: 'frozen_bundled_ripgrep',
              path: input.rgPath,
              configuration: rewritten ? 'no_config_rewrite' : 'no_config_path',
            },
          };
          if (parsed.availability === 'available') {
            paths = parsed.configuredPreprocessors.map(({ command }) => command);
            reusable = paths.length === 0;
          }
        } else {
          facts = {
            ...unavailable(
              !environmentKnown
                ? 'shell_environment_unresolved'
                : bundledRg
                  ? 'ambient_rg_configuration'
                  : 'program_semantics_unverified',
            ),
            argv: [...argv],
          };
          // Only an unambiguous literal file operand is captured. No imports,
          // wrapper evaluation, PATH script search or recursive dependency scan.
          if (
            argv.length === 2 &&
            resolved &&
            input.interpreterPaths.includes(resolved) &&
            !argv[1]!.startsWith('-')
          )
            paths = [argv[1]!];
          else if (name.includes('/') || name.includes('\\')) paths = [name];
        }
      }
      for (const path of paths) {
        // rg's --pre may itself name a PATH command. Do not invent a cwd file.
        if (!path.includes('/') && !path.includes('\\') && bundledRg) {
          directScripts.push({
            path,
            ...unavailable('preprocessor_path_unresolved'),
            complete: false,
          });
          continue;
        }
        try {
          const captured = await read(path, signal);
          directScripts.push(captured.material);
          snapshots.push(captured.snapshot);
        } catch {
          signal.throwIfAborted();
          directScripts.push({
            path,
            ...unavailable('entry_bytes_unavailable'),
            complete: false,
          });
        }
      }
      signal.throwIfAborted();
      const material: Record<string, Json> = {
        command,
        cwd: input.cwd,
        scope: { ...scope },
        commandFacts: facts,
        directScripts,
        coverage: {
          dependencies: 'not_scanned',
          environment: input.sanitizedEnvironment ? 'host_sanitized' : 'not_fully_verified',
          scriptBytes: 'workspace_regular_files_only',
          maxScriptBytes: limit,
        },
      };
      return {
        material,
        fingerprint: digest(JSON.stringify({ binding: input.binding, material })),
        reusable,
        snapshots,
      };
    },
    async verify(snapshots: readonly ShellRiskSnapshot[], signal: AbortSignal) {
      for (const snapshot of snapshots) {
        try {
          const current = await read(snapshot.path, signal);
          if (JSON.stringify(current.snapshot) !== JSON.stringify(snapshot))
            throw new AgentError('shell_review_entry_changed');
        } catch {
          signal.throwIfAborted();
          throw new AgentError('shell_review_entry_changed');
        }
      }
    },
  };
}
