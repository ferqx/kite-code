import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { AuthorizationRequest, Extension, JobContext } from '@kite-ai/agent/extensions';
import { createMacosHostShellJob, createShellJob } from '@kite-ai/agent/jobs/shell';
import { createShellExtension } from '@kite-ai/agent/shell';
import type { CapabilityEffect } from './permissions';

export interface ShellConfigurationOptions {
  /** Trusted macOS assembly; host selects the filesystem/network and coalition boundary. */
  readonly platform: 'darwin';
  readonly configurationId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly supervisorPath: string;
  readonly bunExecutable: string;
  readonly shellExecutable: string;
  readonly graceMs?: number;
  readonly maxQueuedBytes?: number;
  /** Default macOS host boundary; omission keeps explicit legacy group-only assembly. */
  readonly host?: {
    readonly controlBase: string;
    readonly protectedRoots: readonly string[];
    readonly readonlyAssets: readonly string[];
    readonly runtimeReadOnlyRoots: readonly string[];
  };
}
export const shellToolIds = ['shell.launch', 'shell.read', 'shell.wait', 'shell.stop'] as const;
/** Interpret only the original accepted default-policy tree, including delegated AND policies. */
function hostFilesystemScope(context: JobContext): 'workspace_write' | 'full_access' {
  const authorization = context.dispatchAuthorization;
  const pending = [authorization?.snapshot];
  let scope: 'workspace_write' | 'full_access' = 'full_access';
  let count = 0;
  if (!authorization?.revision) throw new AgentError('shell_dispatch_scope_unavailable');
  while (pending.length) {
    const snapshot = pending.pop();
    if (snapshot?.version !== '1' || ++count > 8192)
      throw new AgentError('shell_dispatch_scope_unavailable');
    const data = snapshot.data;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new AgentError('shell_dispatch_scope_unavailable');
    if (snapshot.namespace === 'agent.permission-intersection') {
      const policies = data.policies;
      if (!Array.isArray(policies) || policies.length < 1 || policies.length > 2)
        throw new AgentError('shell_dispatch_scope_unavailable');
      for (const [index, policy] of policies.entries()) {
        if (
          !policy ||
          typeof policy !== 'object' ||
          Array.isArray(policy) ||
          policy.scope !== (index === 0 ? 'parent' : 'child') ||
          typeof policy.revision !== 'string' ||
          !policy.revision ||
          typeof policy.allowed !== 'boolean' ||
          !policy.snapshot ||
          typeof policy.snapshot !== 'object' ||
          Array.isArray(policy.snapshot) ||
          typeof policy.snapshot.namespace !== 'string' ||
          typeof policy.snapshot.version !== 'string' ||
          !Object.hasOwn(policy.snapshot, 'data')
        )
          throw new AgentError('shell_dispatch_scope_unavailable');
        // allowed=false can be the original policy's approval challenge. The
        // final owned dispatch accepted that challenge; hardAllowed still must
        // be true in every leaf. Never synthesize a grant from this metadata.
        pending.push(policy.snapshot as NonNullable<typeof authorization.snapshot>);
      }
      continue;
    }
    const capability = data.capability;
    if (
      snapshot.namespace !== 'builtin.permissions' ||
      data.workspaceTrust !== true ||
      typeof data.mode !== 'string' ||
      !['ask', 'accept_edits', 'auto', 'full'].includes(data.mode) ||
      !capability ||
      typeof capability !== 'object' ||
      Array.isArray(capability) ||
      capability.kind !== 'job' ||
      capability.definitionId !== 'shell.command' ||
      capability.definitionVersion !== '1' ||
      capability.hardAllowed !== true
    )
      throw new AgentError('shell_dispatch_scope_unavailable');
    if (data.mode !== 'full') scope = 'workspace_write';
  }
  return scope;
}
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
    const jobOptions = {
      cwd,
      env: options.env,
      supervisorPath: supervisor.path,
      bunExecutable: bun.path,
      shellExecutable: shell.path,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.maxQueuedBytes !== undefined ? { maxQueuedBytes: options.maxQueuedBytes } : {}),
    };
    const job = options.host
      ? createMacosHostShellJob({
          ...jobOptions,
          ...options.host,
          filesystemScope: hostFilesystemScope,
        })
      : createShellJob(jobOptions);
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
          try {
            return await job.start(value, context);
          } catch (error) {
            if (!options.host || error instanceof AgentError) throw error;
            // Only a fixed non-secret adapter code crosses the ordinary Job
            // failure contract; private paths and native error text stay private.
            const message = error instanceof Error ? error.message : '';
            throw new AgentError(
              /^[a-z][a-z0-9_]{1,80}$/.test(message) ? message : 'shell_start_failed',
            );
          }
        },
      },
    });
    return {
      extensions: [extension],
      snapshot: {
        available: true,
        platform: 'darwin',
        qualification: options.host
          ? 'macos_launchd_coalition_seatbelt'
          : 'posix_group_supervision_only',
        configurationId: options.configurationId,
        cwd,
        assets: { supervisor, bun, shell },
        ...(options.host ? { host: options.host, scope: 'final_dispatch_authorization' } : {}),
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
              ...(options.host ? { host: options.host } : {}),
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
