import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Json } from '../storage/types';
import { AgentError } from '../storage/types';
import { createWorkspaceFiles } from '../tools/files';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unavailable = (reason: string): Record<string, Json> => ({
  availability: 'unavailable',
  reason,
});

/** A deliberately bounded rg argv grammar, not a Shell interpreter or risk verdict. */
export function ripgrepRiskFacts(argv: readonly string[]): Record<string, Json> {
  const tokens: Record<string, Json>[] = [{ index: 0, value: argv[0] ?? '', role: 'executable' }];
  const consumedOptionValues: Record<string, Json>[] = [];
  const configuredPreprocessors: Record<string, Json>[] = [];
  const positionals: Record<string, Json>[] = [];
  const flags = new Set(['-F', '--fixed-strings', '-n', '--line-number', '--no-config']);
  let end = false;
  let explicitPattern = false;
  let optionTerminatorIndex: number | null = null;
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (!end && value === '--') {
      tokens.push({ index, value, role: 'option_terminator' });
      optionTerminatorIndex = index;
      end = true;
      continue;
    }
    if (!end && flags.has(value)) {
      tokens.push({ index, value, role: 'option' });
      continue;
    }
    let option: string | undefined;
    let attached: string | undefined;
    let form = 'next_token';
    if (!end) {
      if (['-e', '--regexp', '-f', '--file', '--pre'].includes(value)) option = value;
      else {
        option = ['--regexp', '--file', '--pre'].find((name) => value.startsWith(`${name}=`));
        if (option) {
          attached = value.slice(option.length + 1);
          form = 'equals';
        } else if (value.length > 2 && ['-e', '-f'].includes(value.slice(0, 2))) {
          option = value.slice(0, 2);
          attached = value.slice(2);
          form = 'attached';
        }
      }
    }
    if (option) {
      const optionIndex = index;
      const valueIndex = attached === undefined ? index + 1 : index;
      const argument = attached ?? argv[index + 1];
      if (argument === undefined) return unavailable('missing_option_value');
      if (option === '--pre' && (!argument || configuredPreprocessors.length))
        return unavailable('unsupported_empty_or_repeated_preprocessor');
      const valueKind = ['-e', '--regexp'].includes(option)
        ? 'pattern'
        : ['-f', '--file'].includes(option)
          ? 'pattern_file'
          : 'preprocessor_command';
      const relation = { optionIndex, valueIndex, option, value: argument, valueKind, form };
      tokens.push({ index, value, role: 'option', consumes: relation });
      consumedOptionValues.push(relation);
      if (attached === undefined) {
        index++;
        tokens.push({
          index,
          value: argument,
          role: 'option_value',
          consumedByIndex: optionIndex,
          valueKind,
        });
      }
      if (valueKind === 'preprocessor_command')
        configuredPreprocessors.push({ command: argument, optionIndex, valueIndex, form });
      else explicitPattern = true;
      continue;
    }
    if (!end && value.startsWith('-')) return unavailable('unsupported_option');
    const positional = { index, value, role: 'positional' };
    tokens.push(positional);
    positionals.push(positional);
  }
  for (const positional of positionals) {
    positional.role = explicitPattern ? 'path_argument' : 'pattern_argument';
    explicitPattern = true;
  }
  if (!explicitPattern) return unavailable('missing_pattern');
  return {
    availability: 'available',
    coverage: 'literal_rg_option_subset',
    argv: [...argv],
    tokens,
    consumedOptionValues,
    optionTerminatorIndex,
    configuredPreprocessors,
    literalPathArguments: tokens
      .filter((token) => token.role === 'path_argument')
      .map((token) => token.value!),
  };
}

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
  cwd: string;
  env: Readonly<Record<string, string>>;
  rgPath: string;
  interpreterPaths: readonly string[];
  protectedPaths: readonly string[];
  binding: Json;
  sanitizedEnvironment: boolean;
  classify(command: string): Promise<{ plainCommands: readonly (readonly string[])[] | null }>;
  rewritten(command: string): Promise<boolean>;
}) {
  const limit = 64 * 1024;
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
      const local = relative(resolve(value), input.cwd);
      return !local || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
    });
    if (rootProtected) throw new AgentError('shell_review_protected_path');
    const protectedPaths = denied.flatMap((value) => {
      const local = relative(input.cwd, resolve(value));
      return local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
        ? [local.replaceAll('\\', '/')]
        : [];
    });
    const files = createWorkspaceFiles({
      root: input.cwd,
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
          resolvedPath: resolve(input.cwd, local),
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
      const classified = await input.classify(command);
      signal.throwIfAborted();
      const commands = classified.plainCommands;
      const directScripts: Record<string, Json>[] = [];
      const snapshots: ShellRiskSnapshot[] = [];
      let facts: Record<string, Json> = unavailable('not_single_literal_invocation');
      let reusable = false;
      if (commands?.length === 1) {
        const argv = commands[0]!;
        const name = argv[0]!;
        const rewritten = await input.rewritten(command);
        const resolved = rewritten ? input.rgPath : await executable(name, signal);
        const environmentKnown =
          input.sanitizedEnvironment ||
          !Object.keys(input.env).some((key) => /^(?:BASH_ENV|ENV|ZDOTDIR|BASH_FUNC_)/.test(key));
        const bundledRg =
          (name === 'rg' || name === 'rg.exe' || name === input.rgPath) &&
          resolved === input.rgPath;
        let paths: string[] = [];
        if (bundledRg && environmentKnown && (rewritten || !input.env.RIPGREP_CONFIG_PATH)) {
          facts = ripgrepRiskFacts(argv);
          facts.program = {
            identity: 'frozen_bundled_ripgrep',
            path: input.rgPath,
            configuration: rewritten ? 'no_config_rewrite' : 'no_config_path',
          };
          if (facts.availability === 'available') {
            paths = (facts.configuredPreprocessors as Record<string, Json>[]).map((entry) =>
              String(entry.command),
            );
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
