import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { AuthorizationRequest, Extension } from '@kite-ai/agent/extensions';
import { createShellJob } from '@kite-ai/agent/jobs/shell';
import { createShellExtension } from '@kite-ai/agent/shell';
import type { CapabilityEffect } from './permissions';

export interface ShellConfigurationOptions {
  /** This slice qualifies explicit macOS POSIX group supervision, not a filesystem/network sandbox. */
  readonly platform: 'darwin';
  readonly configurationId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly supervisorPath: string;
  readonly bunExecutable: string;
  readonly shellExecutable: string;
  readonly graceMs?: number;
  readonly maxQueuedBytes?: number;
}
export const shellToolIds = ['shell.launch', 'shell.read', 'shell.wait', 'shell.stop'] as const;
/** Read-only verification of trusted supervision assets; does not create a Job or process. */
export async function inspectShellAssets(options: ShellConfigurationOptions) {
  assertShellConfiguration(options);
  return Promise.all([
    asset(options.supervisorPath, false),
    asset(options.bunExecutable, true),
    asset(options.shellExecutable, true),
  ]);
}
function assertShellConfiguration(options: ShellConfigurationOptions) {
  if (process.platform !== 'darwin' || options.platform !== 'darwin')
    throw new AgentError('shell_platform_unqualified');
  if (
    !/^[A-Za-z0-9_.-]{1,128}$/.test(options.configurationId) ||
    Object.keys(options.env).length > 128 ||
    Buffer.byteLength(JSON.stringify(options.env)) > 64 * 1024 ||
    Object.entries(options.env).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 16384,
    )
  )
    throw new AgentError('invalid_shell_configuration');
}
async function asset(path: string, executable: boolean) {
  if (!isAbsolute(path)) throw new AgentError('shell_asset_unavailable');
  const selected = await realpath(path);
  const stat = await lstat(selected);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
    throw new AgentError('shell_asset_unavailable');
  if (executable) await access(selected, constants.X_OK);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(selected)) hash.update(chunk);
  return { path: selected, digest: hash.digest('hex') };
}
export async function createShellConfiguration(input: {
  workspaceRoot: string;
  toolIds: readonly string[];
  options?: ShellConfigurationOptions;
}) {
  const selected = input.toolIds.filter((id) =>
    shellToolIds.includes(id as (typeof shellToolIds)[number]),
  );
  if (!selected.length)
    return {
      extensions: [] as Extension[],
      snapshot: { available: false, tools: [] as { id: string; definitionVersion: string }[] },
      describe,
      commandDigest: (_request: AuthorizationRequest): string | undefined => undefined,
    };
  if (!input.options) throw new AgentError('shell_unavailable');
  const options = structuredClone(input.options);
  assertShellConfiguration(options);
  try {
    const cwd = await realpath(input.workspaceRoot);
    if (!(await lstat(cwd)).isDirectory()) throw new AgentError('shell_workspace_unavailable');
    const [supervisor, bun, shell] = await inspectShellAssets(options);
    const job = createShellJob({
      cwd,
      env: options.env,
      supervisorPath: supervisor.path,
      bunExecutable: bun.path,
      shellExecutable: shell.path,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.maxQueuedBytes !== undefined ? { maxQueuedBytes: options.maxQueuedBytes } : {}),
    });
    const extension = createShellExtension({
      job: {
        ...job,
        async start(value, context) {
          context.signal.throwIfAborted();
          const actual = await Promise.all([
            asset(supervisor.path, false),
            asset(bun.path, true),
            asset(shell.path, true),
          ]);
          if (actual.some((item, index) => item.digest !== [supervisor, bun, shell][index]!.digest))
            throw new AgentError('shell_asset_changed');
          context.signal.throwIfAborted();
          return job.start(value, context);
        },
      },
    });
    return {
      extensions: [extension],
      snapshot: {
        available: true,
        platform: 'darwin',
        qualification: 'posix_group_supervision_only',
        configurationId: options.configurationId,
        cwd,
        assets: { supervisor, bun, shell },
        envKeys: Object.keys(options.env).sort(),
        tools: (extension.tools ?? [])
          .filter((tool) => selected.includes(tool.id))
          .map(({ id, version }) => ({ id, definitionVersion: version })),
        job: { id: job.id, definitionVersion: job.version },
      },
      describe,
      commandDigest(request: AuthorizationRequest): string | undefined {
        const tool =
          request.kind === 'tool' &&
          request.definitionId === 'shell.launch' &&
          request.definitionVersion === '1';
        const jobRequest =
          request.kind === 'job' &&
          request.definitionId === job.id &&
          request.definitionVersion === job.version;
        const value = request.input;
        if (
          (!tool && !jobRequest) ||
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof value.command !== 'string' ||
          !value.command ||
          value.command.length > 262144 ||
          Object.keys(value).some(
            (key) => !(tool ? ['key', 'command', 'cancellation'] : ['command']).includes(key),
          ) ||
          (tool &&
            value.cancellation !== undefined &&
            value.cancellation !== 'attached' &&
            value.cancellation !== 'detached')
        )
          return undefined;
        // A logical ensure key selects a new operation; it does not change this command's
        // authority. All execution semantics and private environment values remain hashed.
        return createHash('sha256')
          .update(
            JSON.stringify({
              namespace: 'builtin.shell.command-permission',
              version: 1,
              kind: request.kind,
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
              configurationId: options.configurationId,
              command: value.command,
              cancellation: tool ? (value.cancellation ?? 'attached') : null,
              cwd,
              env: Object.entries(options.env).sort(([left], [right]) => left.localeCompare(right)),
              assets: [supervisor, bun, shell],
              graceMs: options.graceMs ?? 200,
              maxQueuedBytes: options.maxQueuedBytes ?? 256 * 1024,
            }),
          )
          .digest('hex');
      },
    };
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('shell_asset_unavailable');
  }
}
function describe(id: string): { effects: readonly CapabilityEffect[]; safeRead: boolean } {
  if (id === 'shell.read' || id === 'shell.wait') return { effects: ['read'], safeRead: true };
  if (id === 'shell.launch')
    return { effects: ['process', 'unknown', 'record_write'], safeRead: false };
  return { effects: ['process', 'unknown'], safeRead: false };
}
