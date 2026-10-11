import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { AuthorizationRequest, Extension, JobContext } from '@kite-ai/agent/extensions';
import {
  createLinuxHostShellJob,
  createMacosHostShellJob,
  createShellJob,
} from '@kite-ai/agent/jobs/shell';
import { createShellExtension } from '@kite-ai/agent/shell';
import type { CapabilityDescription, CapabilityEffect } from './permissions';
import { createShellCommandPolicy } from './shell-command-policy';

export interface ShellConfigurationOptions {
  /** Trusted platform assembly; command input cannot choose an OS boundary. */
  readonly platform: 'darwin' | 'linux';
  readonly configurationId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly supervisorPath: string;
  readonly bunExecutable: string;
  readonly shellExecutable: string;
  readonly graceMs?: number;
  readonly maxQueuedBytes?: number;
  /** Linux supervisorPath is the packaged native init, plus this verified launcher. */
  readonly linux?: { readonly bubblewrapPath: string };
  /** Default host boundary; Linux requires it, explicit macOS legacy assembly may omit it. */
  readonly host?: {
    readonly controlBase: string;
    readonly protectedRoots: readonly string[];
    readonly readonlyAssets: readonly string[];
    readonly runtimeReadOnlyRoots: readonly string[];
  };
}
export const shellToolIds = ['shell.launch', 'shell.read', 'shell.wait', 'shell.stop'] as const;
/** Interpret only the original accepted default-policy tree, including delegated AND policies. */
function acceptedScopeLeaves(context: JobContext, definitionId: string) {
  const authorization = context.dispatchAuthorization;
  const pending = [authorization?.snapshot];
  const leaves: { mode: string; executionScope: unknown }[] = [];
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
      !['accept_edits', 'auto', 'full'].includes(data.mode) ||
      !capability ||
      typeof capability !== 'object' ||
      Array.isArray(capability) ||
      capability.kind !== 'job' ||
      capability.definitionId !== definitionId ||
      capability.definitionVersion !== '1' ||
      capability.hardAllowed !== true
    )
      throw new AgentError('shell_dispatch_scope_unavailable');
    leaves.push({ mode: data.mode, executionScope: capability.executionScope });
  }
  return leaves;
}
export function hostFilesystemScope(
  context: JobContext,
  definitionId = 'shell.command',
): 'workspace_write' | 'full_access' {
  return acceptedScopeLeaves(context, definitionId).every((leaf) => leaf.mode === 'full')
    ? 'full_access'
    : 'workspace_write';
}
/** Read only the final accepted proof, intersecting independent filesystem and network grants. */
export function hostExecutionScope(context: JobContext, definitionId = 'shell.command') {
  let filesystem: 'workspace_write' | 'full_access' = 'full_access';
  let network: 'none' | 'internet' = 'internet';
  for (const leaf of acceptedScopeLeaves(context, definitionId)) {
    // Older trusted adapter proofs never contained a per-call escalation. Keep
    // their mode ceiling; a missing field cannot widen an approved call.
    const scope = leaf.executionScope ?? {
      filesystem: leaf.mode === 'full' ? 'full_access' : 'workspace_write',
      network: leaf.mode === 'full' ? 'internet' : 'none',
    };
    if (
      !scope ||
      typeof scope !== 'object' ||
      Array.isArray(scope) ||
      Object.keys(scope).some((key) => !['filesystem', 'network'].includes(key)) ||
      !('filesystem' in scope) ||
      !['workspace_write', 'full_access'].includes(String(scope.filesystem)) ||
      !('network' in scope) ||
      !['none', 'internet'].includes(String(scope.network))
    )
      throw new AgentError('shell_dispatch_scope_unavailable');
    if (scope.filesystem === 'workspace_write') filesystem = 'workspace_write';
    if (scope.network === 'none') network = 'none';
  }
  return { filesystem, network };
}
const permissionsSchema = {
  type: 'object',
  properties: {
    filesystem: { enum: ['workspace_write', 'full_access'] },
    network: { enum: ['none', 'internet'] },
  },
  required: ['filesystem', 'network'],
  additionalProperties: false,
};
function commandRequest(request: AuthorizationRequest, scoped: boolean) {
  const tool =
    request.kind === 'tool' &&
    request.definitionId === 'shell.launch' &&
    request.definitionVersion === '1';
  const job =
    request.kind === 'job' &&
    request.definitionId === 'shell.command' &&
    request.definitionVersion === '1';
  const value = request.input;
  if (
    (!tool && !job) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.command !== 'string' ||
    !value.command ||
    value.command.length > 262144 ||
    Object.keys(value).some(
      (key) =>
        !(
          tool
            ? ['key', 'command', 'cancellation', ...(scoped ? ['permissions'] : [])]
            : ['command', ...(scoped ? ['permissions'] : [])]
        ).includes(key),
    ) ||
    (tool &&
      value.cancellation !== undefined &&
      !['attached', 'detached'].includes(String(value.cancellation)))
  )
    return undefined;
  const scope = value.permissions;
  if (
    scope !== undefined &&
    (!scope ||
      typeof scope !== 'object' ||
      Array.isArray(scope) ||
      Object.keys(scope).some((key) => !['filesystem', 'network'].includes(key)) ||
      !['workspace_write', 'full_access'].includes(String(scope.filesystem)) ||
      !['none', 'internet'].includes(String(scope.network)))
  )
    return undefined;
  return {
    command: value.command,
    cancellation: tool ? (value.cancellation ?? 'attached') : null,
    executionScope:
      scope === undefined
        ? { filesystem: 'workspace_write' as const, network: 'none' as const }
        : {
            filesystem: scope.filesystem as 'workspace_write' | 'full_access',
            network: scope.network as 'none' | 'internet',
          },
  };
}
/** Read-only verification of trusted supervision assets; does not create a Job or process. */
type ShellAsset = Awaited<ReturnType<typeof asset>>;
export async function inspectShellAssets(
  options: ShellConfigurationOptions,
): Promise<
  [ShellAsset, ShellAsset, ShellAsset] | [ShellAsset, ShellAsset, ShellAsset, ShellAsset]
> {
  assertShellConfiguration(options);
  const [supervisor, bun, shell, bubblewrap] = await Promise.all([
    asset(options.supervisorPath, options.platform === 'linux'),
    asset(options.bunExecutable, true),
    asset(options.shellExecutable, true),
    options.linux ? asset(options.linux.bubblewrapPath, true) : Promise.resolve(undefined),
  ]);
  return bubblewrap ? [supervisor, bun, shell, bubblewrap] : [supervisor, bun, shell];
}
function assertShellConfiguration(options: ShellConfigurationOptions) {
  if (
    process.platform !== options.platform ||
    !['darwin', 'linux'].includes(options.platform) ||
    (options.platform === 'linux' && (!options.host || !options.linux)) ||
    (options.platform === 'darwin' && options.linux)
  )
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
      describeRequest: async (
        _request: AuthorizationRequest,
      ): Promise<Partial<CapabilityDescription> | undefined> => undefined,
      commandDigest: (_request: AuthorizationRequest): string | undefined => undefined,
    };
  if (!input.options) throw new AgentError('shell_unavailable');
  const options = structuredClone(input.options);
  assertShellConfiguration(options);
  try {
    const cwd = await realpath(input.workspaceRoot);
    if (!(await lstat(cwd)).isDirectory()) throw new AgentError('shell_workspace_unavailable');
    const assets = await inspectShellAssets(options);
    const [supervisor, bun, shell, bubblewrap] = assets;
    if (!supervisor || !bun || !shell) throw new AgentError('shell_asset_unavailable');
    const commandPolicy = await createShellCommandPolicy({ cwd, shellExecutable: shell.path });
    const host = options.host && {
      ...options.host,
      readonlyAssets: [
        ...options.host.readonlyAssets,
        ...commandPolicy.assets.map((item) => item.path),
      ],
    };
    const jobOptions = {
      cwd,
      env: options.env,
      supervisorPath: supervisor.path,
      bunExecutable: bun.path,
      shellExecutable: shell.path,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.maxQueuedBytes !== undefined ? { maxQueuedBytes: options.maxQueuedBytes } : {}),
      ...(bubblewrap
        ? { linux: { bubblewrapPath: bubblewrap.path, initExecutable: supervisor.path } }
        : {}),
    };
    const job =
      options.platform === 'linux' && bubblewrap && host
        ? createLinuxHostShellJob({
            ...jobOptions,
            ...host,
            bubblewrapPath: bubblewrap.path,
            filesystemScope: hostFilesystemScope,
            executionScope: hostExecutionScope,
          })
        : host
          ? createMacosHostShellJob({
              ...jobOptions,
              ...host,
              filesystemScope: hostFilesystemScope,
              executionScope: hostExecutionScope,
            })
          : createShellJob(jobOptions);
    const extension = createShellExtension({
      ...(host ? { permissionsSchema } : {}),
      job: {
        ...job,
        ...(host
          ? {
              inputSchema: {
                type: 'object',
                properties: {
                  command: { type: 'string', minLength: 1, maxLength: 262144 },
                  permissions: permissionsSchema,
                },
                required: ['command'],
                additionalProperties: false,
              },
            }
          : {}),
        async start(value, context) {
          context.signal.throwIfAborted();
          const actual = await Promise.all([
            asset(supervisor.path, options.platform === 'linux'),
            asset(bun.path, true),
            asset(shell.path, true),
            ...(bubblewrap ? [asset(bubblewrap.path, true)] : []),
          ]);
          if (actual.some((item, index) => item.digest !== assets[index]!.digest))
            throw new AgentError('shell_asset_changed');
          context.signal.throwIfAborted();
          const command =
            value && typeof value === 'object' && !Array.isArray(value) ? value.command : undefined;
          if (typeof command !== 'string') throw new AgentError('invalid_shell_arguments');
          const classified = await commandPolicy.classify(command);
          if (classified.hardDenied)
            throw new AgentError('shell_command_hard_denied', classified.hardDenied);
          context.signal.throwIfAborted();
          try {
            return await job.start({ command }, context);
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
        platform: options.platform,
        qualification:
          options.platform === 'linux'
            ? 'linux_owned_pid_namespace_bubblewrap'
            : host
              ? 'macos_launchd_coalition_seatbelt'
              : 'posix_group_supervision_only',
        configurationId: options.configurationId,
        cwd,
        assets: {
          supervisor,
          bun,
          shell,
          ...(bubblewrap ? { bubblewrap } : {}),
          parser: [...commandPolicy.assets],
        },
        ...(options.host ? { host: options.host, scope: 'final_dispatch_authorization' } : {}),
        envKeys: Object.keys(options.env).sort(),
        tools: (extension.tools ?? [])
          .filter((tool) => selected.includes(tool.id))
          .map(({ id, version }) => ({ id, definitionVersion: version })),
        job: { id: job.id, definitionVersion: job.version },
      },
      describe,
      async describeRequest(
        request: AuthorizationRequest,
      ): Promise<Partial<CapabilityDescription> | undefined> {
        if (!['shell.launch', 'shell.command'].includes(request.definitionId)) return undefined;
        const value = commandRequest(request, !!host);
        if (!value) return { hardAllowed: false, denialReason: 'invalid_shell_arguments' };
        const classified = await commandPolicy.classify(value.command);
        return {
          ...(host ? { executionScope: value.executionScope } : {}),
          hardAllowed: classified.hardDenied === null,
          ...(classified.hardDenied ? { denialReason: 'shell_command_hard_denied' } : {}),
        };
      },
      commandDigest(request: AuthorizationRequest): string | undefined {
        const value = commandRequest(request, !!host);
        if (!value) return undefined;
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
              cancellation: value.cancellation,
              executionScope: host ? value.executionScope : null,
              cwd,
              env: Object.entries(options.env).sort(([left], [right]) => left.localeCompare(right)),
              assets,
              parserAssets: commandPolicy.assets,
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
