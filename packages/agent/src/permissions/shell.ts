import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  createLinuxHostShellJob,
  createMacosHostShellJob,
  createShellJob,
  createWindowsShellJob,
  ripgrepAsset,
  type TrustedWorkerLaunch,
} from '@kite-ai/agent/jobs/shell';
import { createShellExtension, gitWorktreeAssetDirectory } from '@kite-ai/agent/shell';
import type {
  AuthorizationRequest,
  Extension,
  JobContext,
  JobDefinition,
  JobHandle,
} from '../extensions';
import { JobStartError } from '../extensions';
import { launchIdentityAsync, mapAssetVerification } from '../jobs/launch-identity';
import { parseShellCommandInput } from '../shell-input';
import { AgentError } from '../storage/types';
import type { GitWorktreeHost } from '../tools/git-worktree';
import {
  digest,
  type GitWorktreeConfiguration,
  parseGitWorktreeRequest,
  parseWorkerCommand,
} from '../tools/git-worktree/protocol';
import { shellToolCapability as describe } from './capabilities';
import { dispatchScopeLeaves } from './dispatch-scope';
import type { CapabilityDescription, PermissionPolicySnapshot } from './index';
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
  'git.worktree',
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
  signal?: AbortSignal,
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
  return mapAssetVerification(
    paths,
    ([path, executable], signal) => asset(path, executable, signal),
    signal,
  );
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
async function asset(path: string, executable: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!isAbsolute(path)) throw new AgentError('shell_asset_unavailable');
  const selected = await realpath(path);
  const stat = await lstat(selected);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
    throw new AgentError('shell_asset_unavailable');
  if (executable) await access(selected, constants.X_OK);
  const fact = await launchIdentityAsync(path, true, signal);
  if (fact.canonical !== selected) throw new AgentError('shell_asset_unavailable');
  return { path: selected, digest: fact.digest! };
}
/** Allowlist is applied before the guardian, shell, or worker interpreter can execute. */
function workerEnvironment(options: ShellConfigurationOptions, git: string, bun: string) {
  const result: Record<string, string> = {};
  const allowed = new Set(
    options.platform === 'win32'
      ? [
          'SYSTEMROOT',
          'WINDIR',
          'COMSPEC',
          'USERPROFILE',
          'LOCALAPPDATA',
          'HOMEDRIVE',
          'HOMEPATH',
          'HOME',
          'TEMP',
          'TMP',
        ]
      : ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'],
  );
  for (const [key, value] of Object.entries(options.env).sort(([a], [b]) => a.localeCompare(b)))
    if (allowed.has(options.platform === 'win32' ? key.toUpperCase() : key)) result[key] = value;
  result.PATH =
    options.platform === 'win32'
      ? [
          dirname(git),
          dirname(bun),
          dirname(options.shellExecutable),
          join(result.SystemRoot ?? result.SYSTEMROOT ?? 'C:\\Windows', 'System32'),
        ].join(';')
      : '/usr/bin:/bin:/usr/sbin:/sbin';
  return Object.freeze(result);
}
/** Apple's /usr/bin/git dispatcher's hash does not identify the selected Git,
 * and dispatch can write xcrun caches. Freeze a protected native binary instead. */
async function macosGitCandidates(): Promise<string[]> {
  const rootOwnedPath = async (path: string, file = false) => {
    for (let current = path; ; current = dirname(current)) {
      const fact = await lstat(current);
      if (
        fact.isSymbolicLink() ||
        fact.uid !== 0 ||
        (fact.mode & 0o022) !== 0 ||
        (current === path && file ? !fact.isFile() : !fact.isDirectory())
      )
        return false;
      if (dirname(current) === current) return true;
    }
  };
  const candidates: string[] = [];
  try {
    const pointer = '/private/var/db/xcode_select_link';
    if (await rootOwnedPath(dirname(pointer))) {
      const fact = await lstat(pointer);
      const target = fact.isSymbolicLink() && fact.uid === 0 ? await readlink(pointer) : '';
      if (isAbsolute(target) && !target.includes('\0') && Buffer.byteLength(target) <= 4096)
        candidates.push(join(target, 'usr/bin/git'));
    }
  } catch {
    /* Missing or untrusted selection does not prevent fixed discovery. */
  }
  candidates.push(
    '/Library/Developer/CommandLineTools/usr/bin/git',
    '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
  );
  const verified: string[] = [];
  for (const candidate of new Set(candidates)) {
    try {
      if (
        candidate === '/usr/bin/git' ||
        candidate === '/bin/git' ||
        !(await rootOwnedPath(candidate, true))
      )
        continue;
      const handle = await open(candidate, 'r');
      let magic: string;
      try {
        const prefix = Buffer.alloc(4);
        const { bytesRead } = await handle.read(prefix, 0, 4, 0);
        magic = bytesRead === 4 ? prefix.toString('hex') : '';
      } finally {
        await handle.close();
      }
      if (
        [
          'cffaedfe',
          'cefaedfe',
          'feedfacf',
          'feedface',
          'cafebabe',
          'bebafeca',
          'cafebabf',
          'bfbafeca',
        ].includes(magic)
      )
        verified.push(candidate);
    } catch {
      /* Optional capability candidates fail closed. */
    }
  }
  return verified;
}
async function worktreeAssets(
  options: ShellConfigurationOptions,
  cwd: string,
  bun: ShellAsset,
  signal?: AbortSignal,
) {
  const root = gitWorktreeAssetDirectory();
  const unavailable = (code: string) => ({
    configuration: {
      configurationId: options.configurationId,
      sourceCwd: cwd,
      defaultRoot: join(homedir(), '.kite-code', 'worktrees'),
      bunPath: bun.path,
      workerPath: join(root, 'worker.js'),
      configPath: join(root, 'empty-bunfig.toml'),
      git: { path: '', sha256: '' },
      hooksPath: join(root, 'empty-hooks'),
      unavailable: code,
    } satisfies GitWorktreeConfiguration,
    assets: [] as ShellAsset[],
    profile: undefined as TrustedWorkerLaunch | undefined,
    async verify(_signal?: AbortSignal) {
      throw new AgentError(code);
    },
  });
  try {
    if (
      options.platform !== 'win32' &&
      !['sh', 'bash', 'dash'].includes(basename(await realpath(options.shellExecutable)))
    )
      return unavailable('unsupported_shell_configuration');
    const manifestPath = join(root, 'manifest.json');
    const manifestAsset = await asset(manifestPath, false, signal);
    const bytes = await readFile(manifestAsset.path);
    if (bytes.length > 8192) throw new AgentError('worktree_asset_changed');
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.emptyHooks !== 'empty-hooks' ||
      Object.keys(manifest).sort().join(',') !== 'emptyHooks,files,schemaVersion' ||
      !manifest.files ||
      Object.keys(manifest.files).sort().join(',') !== 'empty-bunfig.toml,worker.js'
    )
      throw new AgentError('worktree_asset_changed');
    const worker = await asset(join(root, 'worker.js'), false, signal);
    const config = await asset(join(root, 'empty-bunfig.toml'), false, signal);
    if (
      manifest.files['worker.js'] !== worker.digest ||
      manifest.files['empty-bunfig.toml'] !== config.digest
    )
      throw new AgentError('worktree_asset_changed');
    const hooks = join(root, 'empty-hooks');
    const hookIdentity = await launchIdentityAsync(hooks, false, signal);
    if (
      !(await lstat(hooks)).isDirectory() ||
      (await lstat(hooks)).isSymbolicLink() ||
      (await readdir(hooks)).length !== 0
    )
      throw new AgentError('worktree_asset_changed');
    const candidates =
      options.platform === 'win32'
        ? [join(dirname(options.windows!.fullShellExecutable), '../../mingw64/bin/git.exe')]
        : options.platform === 'darwin'
          ? await macosGitCandidates()
          : ['/usr/bin/git', '/bin/git'];
    let git: ShellAsset | undefined;
    for (const candidate of candidates) {
      try {
        git = await asset(candidate, true, signal);
        break;
      } catch {
        signal?.throwIfAborted();
      }
    }
    if (!git) return unavailable('git_not_found');
    const configuration: GitWorktreeConfiguration = {
      configurationId: options.configurationId,
      defaultRoot: join(homedir(), '.kite-code', 'worktrees'),
      sourceCwd: cwd,
      bunPath: bun.path,
      workerPath: worker.path,
      configPath: config.path,
      git: { path: git.path, sha256: git.digest },
      hooksPath: hookIdentity.canonical,
    };
    const profileBase = {
      version: 1 as const,
      env: workerEnvironment(options, git.path, bun.path),
      bunFlags: Object.freeze(['--no-env-file', `--config=${config.path}`]),
    };
    const profile: TrustedWorkerLaunch = Object.freeze({
      ...profileBase,
      digest: createHash('sha256')
        .update(JSON.stringify({ ...profileBase, config, bun }))
        .digest('hex'),
    });
    const captured = [worker, config, git, manifestAsset];
    configuration.identity = createHash('sha256')
      .update(
        JSON.stringify({
          configuration,
          assets: [...captured, bun],
          hooks: hookIdentity,
          profile,
        }),
      )
      .digest('hex');
    Object.freeze(configuration.git);
    Object.freeze(configuration);
    for (const item of captured) Object.freeze(item);
    Object.freeze(captured);
    return {
      configuration,
      assets: captured,
      profile,
      async verify(verificationSignal?: AbortSignal) {
        const actual = await mapAssetVerification(
          captured,
          (item, readSignal, index) => asset(item.path, index === 2, readSignal),
          verificationSignal,
        );
        if (actual.some((item, index) => item.digest !== captured[index]!.digest))
          throw new AgentError('worktree_asset_changed');
        const current = await launchIdentityAsync(hooks, false, verificationSignal);
        if (
          JSON.stringify(current) !== JSON.stringify(hookIdentity) ||
          !(await lstat(hooks)).isDirectory() ||
          (await lstat(hooks)).isSymbolicLink() ||
          (await readdir(hooks)).length !== 0
        )
          throw new AgentError('worktree_asset_changed');
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    return unavailable(error instanceof AgentError ? error.code : 'worktree_asset_changed');
  }
}
export async function createShellConfiguration(input: {
  workspaceRoot: string;
  toolIds: readonly string[];
  options?: ShellConfigurationOptions;
  signal?: AbortSignal;
  /** Programmatic host reader; functions never enter cloned ShellConfigurationOptions. */
  worktreeHost?: GitWorktreeHost;
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
        _policy?: Readonly<PermissionPolicySnapshot>,
      ): Promise<Partial<CapabilityDescription> | undefined> => undefined,
      commandDigest: (_request: AuthorizationRequest): string | undefined => undefined,
      prepareRiskReview: async (_request: AuthorizationRequest) => null,
      worktreeRequest: (_request: AuthorizationRequest) =>
        undefined as { action: string; phase?: string } | undefined,
    };
  if (!input.options) throw new AgentError('shell_unavailable');
  const options = structuredClone(input.options);
  assertShellConfiguration(options);
  try {
    const cwd = await realpath(input.workspaceRoot);
    if (!(await lstat(cwd)).isDirectory()) throw new AgentError('shell_workspace_unavailable');
    const assets = await inspectShellAssets(options, input.signal);
    const [supervisor, bun, shell, extra] = assets;
    const bubblewrap = options.platform === 'linux' ? extra : undefined;
    const coreutils = options.platform === 'win32' ? extra : undefined;
    if (!supervisor || !bun || !shell) throw new AgentError('shell_asset_unavailable');
    const commandPolicy = await createShellCommandPolicy({
      cwd,
      shellExecutable: shell.path,
      signal: input.signal,
    });
    const searchAsset = await asset(ripgrepAsset(), true, input.signal);
    const worktree = selected.includes('git.worktree')
      ? await worktreeAssets(options, cwd, bun, input.signal)
      : undefined;
    const worktreeRequest = (request: AuthorizationRequest) => {
      if (request.definitionVersion !== '1') return undefined;
      if (request.kind === 'tool' && request.definitionId === 'git.worktree') {
        const value = parseGitWorktreeRequest(request.input, request.executionId);
        return value ? { action: value.action } : undefined;
      }
      if (request.kind !== 'job' || request.definitionId !== 'shell.command' || !worktree?.profile)
        return undefined;
      const value = commandRequest(request, true);
      const worker = value && parseWorkerCommand(value.command, worktree.configuration);
      return worker
        ? {
            action:
              worker.phase === 'list'
                ? 'list'
                : worker.phase.includes('create')
                  ? 'create'
                  : 'remove',
            phase: worker.phase,
          }
        : undefined;
    };
    const host = options.host;
    const riskOptions = {
      cwd,
      env: options.env,
      rgPath: searchAsset.path,
      interpreterPaths: [shell.path, bun.path],
      protectedPaths: [],
      binding: {
        cwd,
        env: Object.entries(options.env).sort(([a], [b]) => a.localeCompare(b)),
        assets,
        parserAssets: [...commandPolicy.assets],
        configurationId: options.configurationId,
      },
      sanitizedEnvironment: !!host && !/zsh/i.test(shell.path),
      classify: (command: string) => commandPolicy.classify(command),
      rewritten: async (command: string) =>
        readOnlySearchCommand(
          await commandPolicy.classify(command),
          shell.path,
          coreutils?.path,
        ) !== undefined,
    };
    const riskPreparer = createShellRiskPreparer(riskOptions);
    const executionDirectory = async (workdir?: string) => {
      const path = workdir === undefined ? cwd : await realpath(resolve(cwd, workdir));
      const stat = await lstat(path);
      if (!stat.isDirectory()) throw new AgentError('shell_workdir_unavailable');
      return { path, dev: String(stat.dev), ino: String(stat.ino) };
    };
    const riskSnapshots = new Map<string, readonly ShellRiskSnapshot[]>();
    const workerScopes = new Map<
      string,
      { filesystem: 'workspace_write' | 'full_access'; network: 'none' }
    >();
    const executionScope = (context: JobContext) => {
      const accepted = hostExecutionScope(context);
      const requested = workerScopes.get(context.executionId);
      return requested
        ? {
            filesystem:
              accepted.filesystem === 'workspace_write' ||
              requested.filesystem === 'workspace_write'
                ? ('workspace_write' as const)
                : ('full_access' as const),
            network: 'none' as const,
          }
        : accepted;
    };
    const jobOptions = {
      cwd,
      env: options.env,
      supervisorPath: supervisor.path,
      bunExecutable: bun.path,
      shellExecutable: shell.path,
      trustedWorkerLaunch: (command: string) =>
        worktree?.profile && parseWorkerCommand(command, worktree.configuration)
          ? worktree.profile
          : undefined,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.maxQueuedBytes !== undefined ? { maxQueuedBytes: options.maxQueuedBytes } : {}),
      ...(bubblewrap
        ? { linux: { bubblewrapPath: bubblewrap.path, initExecutable: supervisor.path } }
        : {}),
    };
    const makeJob = async (directory = cwd) =>
      options.platform === 'win32' && coreutils && host
        ? await createWindowsShellJob(
            {
              ...jobOptions,
              cwd: directory,
              controlBase: host.controlBase,
              coreutilsPath: coreutils.path,
              fullShellExecutable: options.windows!.fullShellExecutable,
              stateRoot: options.windows!.stateRoot,
              executionScope,
            },
            input.signal,
          )
        : options.platform === 'linux' && bubblewrap && host
          ? createLinuxHostShellJob({
              ...jobOptions,
              cwd: directory,
              ...host,
              bubblewrapPath: bubblewrap.path,
              filesystemScope: hostFilesystemScope,
              executionScope,
            })
          : host
            ? createMacosHostShellJob({
                ...jobOptions,
                cwd: directory,
                ...host,
                filesystemScope: hostFilesystemScope,
                executionScope,
              })
            : createShellJob({ ...jobOptions, cwd: directory });
    const job = await makeJob();
    const handleOwners = new WeakMap<JobHandle, JobDefinition>();
    const extension = createShellExtension({
      ...(host ? { permissionsSchema } : {}),
      ...(worktree
        ? {
            gitWorktree: {
              configuration: worktree.configuration,
              worktreeHost: input.worktreeHost,
            },
          }
        : {}),
      async classifyPresentation(command) {
        const classified = await commandPolicy.classify(command);
        return classified.hardDenied
          ? 'standalone'
          : shellExplorationPresentation(classified.plainCommands);
      },
      job: {
        ...job,
        ...(host || worktree
          ? {
              inputSchema: {
                type: 'object',
                properties: {
                  command: { type: 'string', minLength: 1, maxLength: 262144 },
                  workdir: { type: 'string', minLength: 1, maxLength: 4096 },
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
            if (context.dispatchAuthorization?.materialReviewed && reviewedScripts)
              await riskPreparer.verify(reviewedScripts, context.signal);
            const actual = await mapAssetVerification(
              assets,
              (item, signal, index) =>
                asset(item.path, index !== 0 || options.platform !== 'darwin', signal),
              context.signal,
            );
            if (actual.some((item, index) => item.digest !== assets[index]!.digest))
              throw new AgentError('shell_asset_changed');
            if ((await asset(searchAsset.path, true, context.signal)).digest !== searchAsset.digest)
              throw new AgentError('shell_asset_changed');
            context.signal.throwIfAborted();
            const command =
              value && typeof value === 'object' && !Array.isArray(value)
                ? value.command
                : undefined;
            if (typeof command !== 'string') throw new AgentError('invalid_shell_arguments');
            const worker = worktree?.profile && parseWorkerCommand(command, worktree.configuration);
            if (worker) {
              if (!host && worker.phase !== 'list')
                throw new AgentError('worktree_permission_denied');
              await worktree!.verify(context.signal);
              context.signal.throwIfAborted();
              dispatched = true;
              const requested = commandRequest(
                {
                  kind: 'job',
                  sessionId: context.sessionId,
                  runId: null,
                  executionId: context.executionId,
                  definitionId: 'shell.command',
                  definitionVersion: '1',
                  input: value,
                  signal: context.signal,
                },
                true,
              )?.executionScope;
              if (requested?.network !== 'none')
                throw new JobStartError(undefined, 'worktree_permission_denied');
              workerScopes.set(context.executionId, {
                filesystem: requested.filesystem,
                network: 'none',
              });
              try {
                return await job.start({ command }, context);
              } finally {
                workerScopes.delete(context.executionId);
              }
            }
            if (
              !host &&
              value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              'permissions' in value
            )
              throw new AgentError('invalid_shell_arguments');
            const classified = await commandPolicy.classify(command, context.signal);
            context.signal.throwIfAborted();
            const search = readOnlySearchCommand(classified, shell.path, coreutils?.path);
            const parsed = parseShellCommandInput(value, 'job', !!host);
            if (!parsed) throw new AgentError('invalid_shell_arguments');
            const directory = await executionDirectory(parsed.workdir);
            const selectedJob = parsed.workdir === undefined ? job : await makeJob(directory.path);
            context.signal.throwIfAborted();
            dispatched = true;
            try {
              const handle = await selectedJob.start({ command: search ?? command }, context);
              handleOwners.set(handle, selectedJob);
              return handle;
            } catch (error) {
              if (error instanceof JobStartError && error.handle)
                handleOwners.set(error.handle, selectedJob);
              throw error;
            }
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
        observe: (handle) => (handleOwners.get(handle) ?? job).observe(handle),
        cancel: (handle) => (handleOwners.get(handle) ?? job).cancel(handle),
        async dispose(handle) {
          await (handleOwners.get(handle) ?? job).dispose(handle);
          handleOwners.delete(handle);
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
          ...(worktree
            ? {
                gitWorktree: {
                  configuration: worktree.configuration,
                  assets: worktree.assets,
                  profile: worktree.profile
                    ? {
                        version: worktree.profile.version,
                        digest: worktree.profile.digest,
                        bunFlags: worktree.profile.bunFlags,
                        envKeys: Object.keys(worktree.profile.env).sort(),
                      }
                    : null,
                },
              }
            : {}),
        },
        ...(options.host ? { host: options.host, scope: 'final_dispatch_authorization' } : {}),
        envKeys: Object.keys(options.env).sort(),
        tools: (extension.tools ?? [])
          .filter((tool) => selected.includes(tool.id))
          .map(({ id, version }) => ({ id, definitionVersion: version })),
        job: { id: job.id, definitionVersion: job.version },
      },
      describe,
      worktreeRequest,
      async prepareRiskReview(request: AuthorizationRequest) {
        const kind = shellCommandKind(request);
        if (!kind) return null;
        const value = commandRequest(request, !!host);
        if (!value) return null;
        if (worktree?.profile && parseWorkerCommand(value.command, worktree.configuration))
          return null;
        if (kind === 'job') riskSnapshots.delete(request.executionId);
        const directory = await executionDirectory(value.workdir);
        const preparer =
          value.workdir === undefined
            ? riskPreparer
            : createShellRiskPreparer({
                ...riskOptions,
                cwd: directory.path,
                binding: { ...riskOptions.binding, cwd: directory },
              });
        const prepared = await preparer.prepare(
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
        policy?: Readonly<PermissionPolicySnapshot>,
      ): Promise<Partial<CapabilityDescription> | undefined> {
        if (
          request.kind === 'tool' &&
          request.definitionId === 'git.worktree' &&
          request.definitionVersion === '1' &&
          request.input &&
          typeof request.input === 'object' &&
          !Array.isArray(request.input) &&
          request.input.action === 'observe'
        )
          return { hardAllowed: true, safeRead: true, effects: ['read'], autoReview: 'none' };
        const worktreeCall = worktreeRequest(request);
        if (
          request.kind === 'tool' &&
          request.definitionId === 'git.worktree' &&
          request.definitionVersion === '1' &&
          !worktreeCall
        )
          return { hardAllowed: false, denialReason: 'invalid_worktree_arguments' };
        if (worktreeCall) {
          if (!host && worktreeCall.action !== 'list')
            return { hardAllowed: false, denialReason: 'worktree_permission_denied' };
          if (!worktree?.profile)
            return {
              hardAllowed: false,
              denialReason: worktree?.configuration.unavailable ?? 'worktree_asset_changed',
            };
          try {
            await worktree.verify(request.signal);
          } catch {
            request.signal.throwIfAborted();
            return { hardAllowed: false, denialReason: 'worktree_asset_changed' };
          }
          const parsed =
            request.kind === 'tool'
              ? parseGitWorktreeRequest(request.input, request.executionId)
              : null;
          const scope =
            parsed && parsed.action !== 'list'
              ? parsed.permissions
              : (commandRequest(request, true)?.executionScope ?? {
                  filesystem: 'workspace_write' as const,
                  network: 'none' as const,
                });
          if (scope.network !== 'none')
            return { hardAllowed: false, denialReason: 'worktree_permission_denied' };
          return {
            // Only the verified Tool is Auto-exempt. Its frozen internal Jobs
            // derive the original decision through Store, never command text alone.
            autoReview: request.kind === 'tool' && policy?.mode === 'auto' ? 'none' : undefined,
            safeRead: worktreeCall.action === 'list',
            effects:
              worktreeCall.action === 'list'
                ? ['read']
                : ['process', 'workspace_write', 'record_write'],
            executionScope: scope,
            autoTimeoutScope: scope,
            hardAllowed: true,
            ...(worktreeCall.action === 'list'
              ? {}
              : {
                  worktreeAuthorization: {
                    configurationIdentity: digest(worktree.configuration),
                  },
                }),
            autoReviewKey: createHash('sha256')
              .update(
                JSON.stringify({
                  request: request.input,
                  configuration: worktree.configuration,
                  assets: worktree.assets,
                  profile: worktree.profile.digest,
                }),
              )
              .digest('hex'),
          };
        }
        if (!shellCommandKind(request)) return undefined;
        const value = commandRequest(request, !!host);
        if (!value) return { hardAllowed: false, denialReason: 'invalid_shell_arguments' };
        let directory: Awaited<ReturnType<typeof executionDirectory>>;
        try {
          directory = await executionDirectory(value.workdir);
        } catch {
          request.signal.throwIfAborted();
          return { hardAllowed: false, denialReason: 'shell_workdir_unavailable' };
        }
        const classified = await commandPolicy.classify(value.command);
        return {
          ...(readOnlySearchCommand(classified, shell.path, coreutils?.path) &&
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
                cwd: directory,
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
        const worktreeCall = worktreeRequest(request);
        if (worktreeCall && worktree?.profile)
          return createHash('sha256')
            .update(
              JSON.stringify({
                namespace: 'builtin.shell.git-worktree-permission',
                version: 1,
                kind: request.kind,
                definitionId: request.definitionId,
                definitionVersion: request.definitionVersion,
                input: request.input,
                configuration: worktree.configuration,
                assets: worktree.assets,
                launchProfile: worktree.profile,
                host: options.host ?? null,
              }),
            )
            .digest('hex');
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
              workdir: value.workdir ?? null,
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
    input.signal?.throwIfAborted();
    if (error instanceof AgentError) throw error;
    throw new AgentError('shell_asset_unavailable');
  }
}
export { createShellCommandPolicy } from './shell-command-policy';
export { readOnlySearchCommand } from './shell-search';
