import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  createLinuxHostShellJob,
  createMacosHostShellJob,
  createShellJob,
  createWindowsShellJob,
  ripgrepAsset,
} from '@kite-ai/agent/jobs/shell';
import { createShellExtension } from '@kite-ai/agent/shell';
import type { AuthorizationRequest, Extension, JobContext } from '../extensions';
import { JobStartError } from '../extensions';
import { parseShellCommandInput } from '../shell-input';
import { AgentError } from '../storage/types';
import { shellToolCapability as describe } from './capabilities';
import { dispatchScopeLeaves } from './dispatch-scope';
import type { CapabilityDescription } from './index';
import { createShellCommandPolicy } from './shell-command-policy';
import { shellExplorationPresentation } from './shell-presentation';
import { createShellRiskPreparer, type ShellRiskSnapshot } from './shell-risk-facts';
import { readOnlySearchCommand } from './shell-search';

export interface ShellConfigurationOptions {
  /** Trusted platform assembly; command input cannot choose an OS boundary. */
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly configurationId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly supervisorPath: string;
  readonly bunExecutable: string;
  readonly shellExecutable: string;
  readonly graceMs?: number;
  readonly maxQueuedBytes?: number;
  /** Linux supervisorPath is the packaged native init, plus this verified launcher. */
  readonly linux?: { readonly bubblewrapPath: string };
  readonly windows?: {
    readonly coreutilsPath: string;
    readonly stateRoot: string;
    readonly fullShellExecutable: string;
  };
  /** Default host boundary; Linux requires it, explicit macOS legacy assembly may omit it. */
  readonly host?: {
    readonly controlBase: string;
    readonly protectedRoots: readonly string[];
    /** Trusted private names may be absent or rotate. These are never read as executable assets. */
    readonly protectedFiles?: readonly string[];
    readonly readonlyAssets: readonly string[];
    readonly runtimeReadOnlyRoots: readonly string[];
  };
}
export const shellToolIds = [
  'shell.execute',
  'shell.launch',
  'shell.read',
  'shell.wait',
  'shell.stop',
] as const;
/** Interpret only the original accepted default-policy tree, including delegated AND policies. */
function acceptedScopeLeaves(context: JobContext, definitionId: string) {
  const authorization = context.dispatchAuthorization;
  const leaves: { mode: string; executionScope: unknown }[] = [];
  if (!authorization?.revision) throw new AgentError('shell_dispatch_scope_unavailable');
  for (const { namespace, data } of dispatchScopeLeaves(
    authorization.snapshot,
    'shell_dispatch_scope_unavailable',
  )) {
    const capability = data.capability;
    if (
      namespace !== 'builtin.permissions' ||
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
    filesystem: {
      enum: ['workspace_write', 'full_access'],
      description:
        'Requested write scope. workspace_write is the default workspace and permitted private temporary-directory scope. full_access requests outside writes; it does not select Full approval mode or remove protected-resource restrictions.',
    },
    network: {
      enum: ['none', 'internet'],
      description:
        'Requested network scope. none is the offline default; passing risk review does not grant network access. internet requests network access including localhost, 127.0.0.1, ::1, the local network and the Internet. Network and filesystem requests are independent.',
    },
  },
  required: ['filesystem', 'network'],
  additionalProperties: false,
};
function shellCommandKind(request: AuthorizationRequest): 'tool' | 'job' | undefined {
  if (request.definitionVersion !== '1') return undefined;
  if (request.kind === 'tool' && ['shell.execute', 'shell.launch'].includes(request.definitionId))
    return 'tool';
  if (request.kind === 'job' && request.definitionId === 'shell.command') return 'job';
  return undefined;
}
function commandRequest(request: AuthorizationRequest, scoped: boolean) {
  const kind = shellCommandKind(request);
  if (!kind) return undefined;
  return parseShellCommandInput(
    request.input,
    kind === 'job' ? 'job' : request.definitionId === 'shell.execute' ? 'execute' : 'launch',
    scoped,
  );
}
/** Read-only verification of trusted supervision assets; does not create a Job or process. */
type ShellAsset = Awaited<ReturnType<typeof asset>>;
export async function inspectShellAssets(
  options: ShellConfigurationOptions,
): Promise<ShellAsset[]> {
  assertShellConfiguration(options);
  const paths: [string, boolean][] = [
    [options.supervisorPath, options.platform !== 'darwin'],
    [options.bunExecutable, true],
    [options.shellExecutable, true],
  ];
  if (options.linux) paths.push([options.linux.bubblewrapPath, true]);
  if (options.windows)
    paths.push(
      [options.windows.coreutilsPath, true],
      [options.windows.fullShellExecutable, true],
      [`${dirname(options.windows.fullShellExecutable)}/coreutils.exe`, true],
      [`${dirname(options.shellExecutable)}/../../manifest.json`, true],
    );
  return Promise.all(paths.map(([path, executable]) => asset(path, executable)));
}
function assertShellConfiguration(options: ShellConfigurationOptions) {
  if (
    process.platform !== options.platform ||
    !['darwin', 'linux', 'win32'].includes(options.platform) ||
    (options.platform === 'linux' && (!options.host || !options.linux)) ||
    (options.platform === 'darwin' && (options.linux || options.windows)) ||
    (options.platform === 'win32' &&
      (!options.host ||
        !options.windows ||
        options.linux ||
        process.arch !== 'x64' ||
        !process.versions.bun)) ||
    (options.platform !== 'win32' && options.windows)
  )
    throw new AgentError('shell_platform_unqualified');
  if (
    !/^[A-Za-z0-9_.-]{1,128}$/.test(options.configurationId) ||
    Object.keys(options.env).length > 128 ||
    Buffer.byteLength(JSON.stringify(options.env)) > 64 * 1024 ||
    Object.entries(options.env).some(
      ([key, value]) =>
        !(
          options.platform === 'win32'
            ? /^[A-Za-z_][A-Za-z0-9_]*(?:\(x86\))?$/
            : /^[A-Za-z_][A-Za-z0-9_]*$/
        ).test(key) ||
        typeof value !== 'string' ||
        value.length > 16384,
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
      prepareRiskReview: async (_request: AuthorizationRequest) => null,
    };
  if (!input.options) throw new AgentError('shell_unavailable');
  const options = structuredClone(input.options);
  assertShellConfiguration(options);
  try {
    const cwd = await realpath(input.workspaceRoot);
    if (!(await lstat(cwd)).isDirectory()) throw new AgentError('shell_workspace_unavailable');
    const assets = await inspectShellAssets(options);
    const [supervisor, bun, shell, extra] = assets;
    const bubblewrap = options.platform === 'linux' ? extra : undefined;
    const coreutils = options.platform === 'win32' ? extra : undefined;
    if (!supervisor || !bun || !shell) throw new AgentError('shell_asset_unavailable');
    const commandPolicy = await createShellCommandPolicy({ cwd, shellExecutable: shell.path });
    const searchAsset = await asset(ripgrepAsset(), true);
    const host = options.host && {
      ...options.host,
      readonlyAssets: [
        ...options.host.readonlyAssets,
        searchAsset.path,
        dirname(searchAsset.path),
        ...commandPolicy.assets.map((item) => item.path),
      ],
    };
    const riskPreparer = createShellRiskPreparer({
      cwd,
      env: options.env,
      rgPath: searchAsset.path,
      interpreterPaths: [shell.path, bun.path],
      protectedPaths: [
        ...(host ? [host.controlBase, ...host.protectedRoots, ...(host.protectedFiles ?? [])] : []),
        ...assets.map((item) => item.path),
        ...commandPolicy.assets.map((item) => item.path),
        searchAsset.path,
      ],
      binding: {
        cwd,
        env: Object.entries(options.env).sort(([a], [b]) => a.localeCompare(b)),
        assets,
        parserAssets: [...commandPolicy.assets],
        configurationId: options.configurationId,
      },
      sanitizedEnvironment: !!host && !/zsh/i.test(shell.path),
      classify: (command) => commandPolicy.classify(command),
      rewritten: async (command) =>
        readOnlySearchCommand(
          (await commandPolicy.classify(command)).plainCommands,
          shell.path,
          coreutils?.path,
        ) !== undefined,
    });
    const riskSnapshots = new Map<string, readonly ShellRiskSnapshot[]>();
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
      options.platform === 'win32' && coreutils && host
        ? createWindowsShellJob({
            ...jobOptions,
            controlBase: host.controlBase,
            coreutilsPath: coreutils.path,
            fullShellExecutable: options.windows!.fullShellExecutable,
            stateRoot: options.windows!.stateRoot,
            executionScope: hostExecutionScope,
          })
        : options.platform === 'linux' && bubblewrap && host
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
      async classifyPresentation(command) {
        const classified = await commandPolicy.classify(command);
        return classified.hardDenied
          ? 'standalone'
          : shellExplorationPresentation(classified.plainCommands);
      },
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
          let dispatched = false;
          const reviewedScripts = riskSnapshots.get(context.executionId);
          riskSnapshots.delete(context.executionId);
          try {
            context.signal.throwIfAborted();
            if (context.dispatchAuthorization?.riskReviewApproved && reviewedScripts)
              await riskPreparer.verify(reviewedScripts, context.signal);
            const actual = await Promise.all(
              assets.map((item, index) =>
                asset(item.path, index !== 0 || options.platform !== 'darwin'),
              ),
            );
            if (actual.some((item, index) => item.digest !== assets[index]!.digest))
              throw new AgentError('shell_asset_changed');
            if ((await asset(searchAsset.path, true)).digest !== searchAsset.digest)
              throw new AgentError('shell_asset_changed');
            context.signal.throwIfAborted();
            const command =
              value && typeof value === 'object' && !Array.isArray(value)
                ? value.command
                : undefined;
            if (typeof command !== 'string') throw new AgentError('invalid_shell_arguments');
            const classified = await commandPolicy.classify(command);
            context.signal.throwIfAborted();
            const search = readOnlySearchCommand(
              classified.plainCommands,
              shell.path,
              coreutils?.path,
            );
            dispatched = true;
            return await job.start({ command: search ?? command }, context);
          } catch (error) {
            if (!dispatched)
              throw new JobStartError(
                undefined,
                error instanceof Error ? error.message : 'shell_preparation_failed',
              );
            if (!options.host || error instanceof AgentError || error instanceof JobStartError)
              throw error;
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
          options.platform === 'win32'
            ? 'windows_unelevated_git_bash_job'
            : options.platform === 'linux'
              ? options.host?.protectedFiles?.length
                ? 'linux_owned_pid_namespace_bubblewrap_private_directories'
                : 'linux_owned_pid_namespace_bubblewrap'
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
          ...(coreutils ? { coreutils } : {}),
          parser: [...commandPolicy.assets],
          ripgrep: searchAsset,
        },
        ...(options.host ? { host: options.host, scope: 'final_dispatch_authorization' } : {}),
        envKeys: Object.keys(options.env).sort(),
        tools: (extension.tools ?? [])
          .filter((tool) => selected.includes(tool.id))
          .map(({ id, version }) => ({ id, definitionVersion: version })),
        job: { id: job.id, definitionVersion: job.version },
      },
      describe,
      async prepareRiskReview(request: AuthorizationRequest) {
        const kind = shellCommandKind(request);
        if (!kind) return null;
        const value = commandRequest(request, !!host);
        if (!value) return null;
        if (kind === 'job') riskSnapshots.delete(request.executionId);
        const prepared = await riskPreparer.prepare(
          value.command,
          value.executionScope,
          request.signal,
        );
        request.signal.throwIfAborted();
        if (kind === 'job') riskSnapshots.set(request.executionId, prepared.snapshots);
        return {
          material: prepared.material,
          fingerprint: prepared.fingerprint,
          reusable: prepared.reusable,
        };
      },
      async describeRequest(
        request: AuthorizationRequest,
      ): Promise<Partial<CapabilityDescription> | undefined> {
        if (!shellCommandKind(request)) return undefined;
        const value = commandRequest(request, !!host);
        if (!value) return { hardAllowed: false, denialReason: 'invalid_shell_arguments' };
        const classified = await commandPolicy.classify(value.command);
        return {
          ...(readOnlySearchCommand(classified.plainCommands, shell.path, coreutils?.path) &&
          value.executionScope.filesystem === 'workspace_write' &&
          value.executionScope.network === 'none'
            ? { safeRead: true, effects: ['read'] as const }
            : {}),
          ...(host
            ? {
                executionScope: value.executionScope,
                autoTimeoutScope: value.executionScope,
              }
            : {}),
          autoReviewKey: createHash('sha256')
            .update(
              JSON.stringify({
                command: value.command,
                cwd,
                env: Object.entries(options.env).sort(([a], [b]) => a.localeCompare(b)),
                assets,
                parserAssets: commandPolicy.assets,
                executionScope: host ? value.executionScope : null,
                configurationId: options.configurationId,
              }),
            )
            .digest('hex'),
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
              timeoutMs: value.timeoutMs,
              ...(request.definitionId === 'shell.execute' && value.background
                ? { background: true }
                : {}),
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
export { createShellCommandPolicy } from './shell-command-policy';
export { readOnlySearchCommand } from './shell-search';
