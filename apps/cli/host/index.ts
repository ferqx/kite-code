import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import type {
  AgentClient,
  FollowUpCommandRequest,
  Session,
  StartCommandRequest,
  Workspace,
} from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import {
  parseRuntimeProtection,
  type RuntimeProtection,
} from '@kite-ai/service/runtime-protection';
import {
  createStdioInteractionHandler,
  observeCommand,
  run,
  type StdioInput,
  setPermissionMode,
  setWorkspaceTrust,
} from '../src';
import type { CLIArguments } from '../src/arguments';
import { callerCanonical, callerDigest, parseCallerIntent } from './caller-intents';
import { openCallerJournal } from './caller-journal';
import { CLICallerPrepareError, createCLICallerPort, createTuiCallerPort } from './caller-port';
import { selectWorkflowActivations } from './workflow-activations';

export {
  runNativeTerminalCLI,
  runNativeTerminalTUI,
  runRegisteredTerminalCLI,
  runRegisteredTerminalTUI,
} from './registered-terminal';

/** Installer or development host selection, never a public command/token override. */
export interface CLIServiceArtifact {
  readonly entrypoint: string;
  readonly entrypointSha256: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly buildId: string;
  readonly apiMajor: 1;
  readonly runtimeProtection?: RuntimeProtection;
  readonly daemon?: {
    readonly entrypoint: string;
    readonly entrypointSha256: string;
    readonly web: { readonly directory: string; readonly manifestSha256: string };
  };
}
export class CLIHostError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** The adjacent manifest is a closed installer input, not unchecked JSON cast as trusted assets. */
export function parseCLIServiceArtifact(value: unknown): Readonly<CLIServiceArtifact> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CLIHostError('invalid_cli_artifact');
  const fields = [
    'entrypoint',
    'entrypointSha256',
    'executable',
    'executableSha256',
    'buildId',
    'apiMajor',
  ];
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !==
      fields.length + ('daemon' in input ? 1 : 0) + ('runtimeProtection' in input ? 1 : 0) ||
    Object.keys(input).some(
      (key) => !fields.includes(key) && key !== 'daemon' && key !== 'runtimeProtection',
    ) ||
    input.apiMajor !== 1 ||
    typeof input.buildId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,160}$/.test(input.buildId) ||
    typeof input.entrypoint !== 'string' ||
    !isAbsolute(input.entrypoint) ||
    !/\.m?js$/.test(input.entrypoint) ||
    typeof input.executable !== 'string' ||
    !isAbsolute(input.executable) ||
    typeof input.entrypointSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.entrypointSha256) ||
    typeof input.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.executableSha256)
  )
    throw new CLIHostError('invalid_cli_artifact');
  let runtimeProtection: RuntimeProtection | undefined;
  if ('runtimeProtection' in input) {
    try {
      runtimeProtection = parseRuntimeProtection(input.runtimeProtection);
    } catch {
      throw new CLIHostError('invalid_cli_artifact');
    }
  }
  let daemon: CLIServiceArtifact['daemon'];
  if ('daemon' in input) {
    const candidate = input.daemon as Record<string, unknown> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length !== 3 ||
      Object.keys(candidate).some(
        (key) => !['entrypoint', 'entrypointSha256', 'web'].includes(key),
      ) ||
      typeof candidate.entrypoint !== 'string' ||
      !isAbsolute(candidate.entrypoint) ||
      !/\.m?js$/.test(candidate.entrypoint) ||
      typeof candidate.entrypointSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(candidate.entrypointSha256)
    )
      throw new CLIHostError('invalid_cli_artifact');
    const web = candidate.web as Record<string, unknown> | null;
    if (
      !web ||
      typeof web !== 'object' ||
      Array.isArray(web) ||
      Object.keys(web).length !== 2 ||
      Object.keys(web).some((key) => !['directory', 'manifestSha256'].includes(key)) ||
      typeof web.directory !== 'string' ||
      !isAbsolute(web.directory) ||
      typeof web.manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(web.manifestSha256)
    )
      throw new CLIHostError('invalid_cli_artifact');
    daemon = Object.freeze({
      entrypoint: candidate.entrypoint,
      entrypointSha256: candidate.entrypointSha256,
      web: Object.freeze({ directory: web.directory, manifestSha256: web.manifestSha256 }),
    });
  }
  return Object.freeze({
    entrypoint: input.entrypoint,
    entrypointSha256: input.entrypointSha256,
    executable: input.executable,
    executableSha256: input.executableSha256,
    buildId: input.buildId,
    apiMajor: 1,
    ...(runtimeProtection ? { runtimeProtection } : {}),
    ...(daemon ? { daemon } : {}),
  });
}
export function verifyArtifact(path: string, digest: string, executable: boolean) {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(digest))
    throw new CLIHostError('invalid_cli_artifact');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (executable && !(stat.mode & 0o111)))
      throw new CLIHostError('cli_artifact_unavailable');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== digest)
      throw new CLIHostError('cli_artifact_identity_mismatch');
  } catch (error) {
    if (error instanceof CLIHostError) throw error;
    throw new CLIHostError('cli_artifact_unavailable');
  }
}
function canonicalWorkspace(path: string, cwd: string): string {
  try {
    const canonical = realpathSync(resolve(cwd, path));
    if (!lstatSync(canonical).isDirectory()) throw new Error();
    return pathToFileURL(canonical).href;
  } catch {
    throw new CLIHostError('workspace_unavailable');
  }
}
function receiptSession(
  command: Awaited<ReturnType<AgentClient['getCommand']>>,
): string | undefined {
  const receipt = command.receipt;
  return receipt &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    typeof receipt.sessionId === 'string'
    ? receipt.sessionId
    : undefined;
}
async function registerWorkspace(
  client: AgentClient,
  storeId: string,
  rootUri: string,
  signal?: AbortSignal,
): Promise<Workspace> {
  const id = `workspace-${createHash('sha256').update(rootUri).digest('hex')}`;
  signal?.throwIfAborted();
  try {
    return await client.createWorkspace(
      {
        expectedStoreId: storeId,
        id,
        name: basename(new URL(rootUri).pathname) || 'Workspace',
        rootUri,
      },
      { signal },
    );
  } catch {
    // The original identity is a lookup target, never permission to repeat the POST.
    const original = (await client.listAllWorkspaces({ signal })).find(
      (item) => item.id === id && item.rootUri === rootUri,
    );
    if (!original) throw new CLIHostError('workspace_outcome_unknown');
    return original;
  }
}

/** Status preserves the explicit trust boundary without creating a conversation. */
async function printSelectedStatus(
  args: Extract<CLIArguments, { kind: 'run' | 'resume' }>,
  client: AgentClient,
  cwd: string,
  write: (line: string) => void,
  prompt: (line: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const info = client.serverInfo;
  if (!args.status || !info) throw new CLIHostError('cli_status_unavailable');
  let workspaceId: string | undefined, sessionId: string | undefined;
  if (info.dataAvailability === 'available') {
    const workspaces = await client.listAllWorkspaces({ signal });
    let workspace: Workspace | undefined;
    if (args.thread) {
      const session = (await client.listAllSessions({ signal })).find(
        (item) => item.id === args.thread,
      );
      if (!session) throw new CLIHostError('session_not_found');
      sessionId = session.id;
      workspace = workspaces.find((item) => item.id === session.workspaceId);
      if (!workspace) throw new CLIHostError('workspace_unavailable');
      if (
        args.workspace !== undefined &&
        canonicalWorkspace(args.workspace, cwd) !== workspace.rootUri
      )
        throw new CLIHostError('workspace_identity_mismatch');
    } else {
      const rootUri = canonicalWorkspace(args.workspace ?? '.', cwd);
      workspace = workspaces.find((item) => item.rootUri === rootUri);
      if (!workspace) {
        if (!args.trustWorkspace) throw new CLIHostError('workspace_not_trusted');
        workspace = await registerWorkspace(client, info.storeId, rootUri, signal);
      }
    }
    workspaceId = workspace.id;
    const observed = await client.getWorkspaceTrust(workspaceId, { storeId: info.storeId, signal });
    if (!observed.trusted) {
      if (!args.trustWorkspace) throw new CLIHostError('workspace_not_trusted');
      const outcome = await setWorkspaceTrust(
        workspaceId,
        {
          expectedStoreId: info.storeId,
          commandId: crypto.randomUUID(),
          ifRevision: observed.revision,
          trusted: true,
          canonicalIdentity: observed.canonicalIdentity,
          externalReadScopeDigest: observed.externalReadScopeDigest,
        },
        { client, write: prompt, signal },
      );
      if (outcome.exitCode !== 0) return outcome.exitCode;
    }
  }
  const status = await client.getHostStatus({ workspaceId, sessionId, signal });
  write(
    JSON.stringify({
      identity: status.identity,
      scope: status.scope,
      [args.status]: status[args.status],
    }),
  );
  return status.identity.dataAvailability === 'available' ? 0 : 2;
}

export async function ensureSession(
  args: Extract<CLIArguments, { kind: 'run' | 'resume' }>,
  client: AgentClient,
  storeId: string,
  cwd: string,
  write: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ session: Session; workspace: Workspace }> {
  const sessions = await client.listAllSessions({ signal });
  const sessionId = args.thread ?? crypto.randomUUID();
  const original = sessions.find((item) => item.id === sessionId);
  const workspaces = await client.listAllWorkspaces({ signal });
  if (original) {
    const workspace = workspaces.find((item) => item.id === original.workspaceId);
    if (!workspace) throw new CLIHostError('workspace_unavailable');
    if (
      args.workspace !== undefined &&
      canonicalWorkspace(args.workspace, cwd) !== workspace.rootUri
    )
      throw new CLIHostError('workspace_identity_mismatch');
    return { session: original, workspace };
  }
  if (args.kind === 'resume') throw new CLIHostError('session_not_found');
  const rootUri = canonicalWorkspace(args.workspace ?? '.', cwd);
  let workspace = workspaces.find((item) => item.rootUri === rootUri);
  if (!workspace) workspace = await registerWorkspace(client, storeId, rootUri, signal);
  const commandId = crypto.randomUUID();
  const intent = Object.freeze({
    expectedStoreId: storeId,
    commandId,
    sessionId,
    workspaceId: workspace.id,
    title: args.task.slice(0, 120) || 'CLI Session',
  });
  write(
    `session intent ${JSON.stringify({ storeId, commandId, sessionId, workspaceId: workspace.id })}`,
  );
  signal?.throwIfAborted();
  let session: Session;
  try {
    session = await client.createSession(intent, { signal });
  } catch {
    const originalCommand = await client.getCommand(commandId, { signal }).catch(() => undefined);
    if (
      !originalCommand ||
      originalCommand.originStoreId !== storeId ||
      originalCommand.sessionId !== sessionId ||
      originalCommand.kind !== 'session.create' ||
      receiptSession(originalCommand) !== sessionId ||
      originalCommand.status !== 'applied'
    )
      throw new CLIHostError('session_outcome_unknown');
    const actual = (await client.listAllSessions({ signal })).find(
      (item) => item.id === sessionId && item.workspaceId === workspace.id,
    );
    if (!actual) throw new CLIHostError('session_outcome_unknown');
    session = actual;
  }
  if (session.id !== sessionId || session.workspaceId !== workspace.id)
    throw new CLIHostError('session_identity_mismatch');
  return { session, workspace };
}
async function printOriginalAnswer(
  client: AgentClient,
  storeId: string,
  sessionId: string,
  commandId: string,
  write: (line: string) => void,
  signal?: AbortSignal,
) {
  if (
    !client.serverInfo?.capabilities.includes('model_inputs') ||
    !client.serverInfo.capabilities.includes('model_outputs')
  ) {
    write('Model output reader unavailable');
    return;
  }
  const command = await client.getCommand(commandId, { signal });
  const receipt = command.receipt;
  const runId =
    receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt.runId : undefined;
  if (
    command.originStoreId !== storeId ||
    command.sessionId !== sessionId ||
    typeof runId !== 'string'
  )
    throw new CLIHostError('command_identity_mismatch');
  let afterSeq = '0',
    upperSeq: string | undefined,
    executionId: string | undefined;
  for (;;) {
    const page = await client.listModelInputs(sessionId, {
      expectedStoreId: storeId,
      afterSeq,
      ...(upperSeq ? { upperSeq } : {}),
      limit: 200,
      signal,
    });
    upperSeq ??= page.upperSeq;
    for (const item of page.items)
      if (item.runId === runId && item.originCommandId === commandId)
        executionId = item.executionId;
    if (page.nextAfterSeq === null) break;
    afterSeq = page.nextAfterSeq;
  }
  if (!executionId) return;
  const snapshot = await client.getModelOutput(sessionId, executionId, {
    expectedStoreId: storeId,
    signal,
  });
  if (snapshot.runId !== runId || snapshot.originCommandId !== commandId)
    throw new CLIHostError('model_output_identity_mismatch');
  // JSON escaping preserves the complete content and prevents terminal control execution.
  write(
    `answer ${JSON.stringify({
      storeId,
      sessionId,
      commandId,
      executionId,
      complete: snapshot.output.complete,
      content: snapshot.output.content,
    })}`,
  );
}

/** Trusted process host. Portable CLI functions continue to depend only on public Client. */
export async function runSelectedCLI(input: {
  readonly arguments: CLIArguments;
  readonly artifact?: CLIServiceArtifact;
  readonly resolveArtifact?: () => CLIServiceArtifact;
  readonly dataRoot: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly stdin?: StdioInput;
  readonly write: (line: string) => void;
  readonly prompt: (line: string) => void;
  readonly signal?: AbortSignal;
  /** Explicit host termination, separate from cancelling the foreground work. */
  readonly exitSignal?: AbortSignal;
  readonly onLaunched?: (paired: Awaited<ReturnType<typeof launchPairedService>>) => void;
}): Promise<number> {
  const args = input.arguments;
  if (
    args.kind !== 'run' &&
    args.kind !== 'resume' &&
    args.kind !== 'work' &&
    args.kind !== 'caller'
  )
    throw new CLIHostError('cli_command_unavailable');
  if (args.kind === 'caller' && args.action === 'lookup') parseCallerIntent(args.input);
  input.signal?.throwIfAborted();
  const profile = selectProfile({
    dataRoot: args.dataRoot ?? input.dataRoot,
    profile: input.profile ?? 'default',
  });
  const taskArgs = args.kind === 'run' || args.kind === 'resume' ? args : undefined;
  const requiredCapabilities = taskArgs?.status
    ? ['host_status', 'sessions', 'permission_controls']
    : [
        'sessions',
        'commands',
        'history',
        ...(taskArgs?.skills.length ? ['run_skill_selection'] : []),
        ...(taskArgs?.activateSkills?.length
          ? ['skill_workflow_catalogue', 'run_extension_inputs']
          : []),
      ];
  const connection = args.server
    ? await (await import('./shared-service')).connectSharedService({
        profile,
        server: args.server,
        requiredCapabilities,
        workspace: taskArgs?.workspace,
        cwd: input.cwd,
        signal: input.exitSignal,
      })
    : await (async () => {
        const selected = input.artifact ?? input.resolveArtifact?.();
        if (!selected) throw new CLIHostError('cli_artifact_unavailable');
        const artifact = parseCLIServiceArtifact(selected);
        verifyArtifact(artifact.entrypoint, artifact.entrypointSha256, false);
        verifyArtifact(artifact.executable, artifact.executableSha256, true);
        return {
          mode: 'paired' as const,
          ...(await launchPairedService({
            profile,
            entrypoint: artifact.entrypoint,
            executable: artifact.executable,
            buildId: artifact.buildId,
            instanceId: crypto.randomUUID(),
            apiMajor: artifact.apiMajor,
            requiredCapabilities,
            ...(artifact.runtimeProtection
              ? { runtimeProtection: artifact.runtimeProtection }
              : {}),
          })),
        };
      })();
  let callerAccess: ReturnType<typeof acquireProfileAccess> | undefined;
  let callerJournal: ReturnType<typeof openCallerJournal> | undefined;
  const interaction = createStdioInteractionHandler({ input: input.stdin, write: input.prompt });
  const stopHost = () => {
    // A shared host exit ends only its local answer wait, never the Service work.
    if (connection.mode === 'shared') interaction.dispose();
    void connection.close();
  };
  input.exitSignal?.addEventListener('abort', stopHost, { once: true });
  const executeWork = async (
    sessionId: string,
    intent: StartCommandRequest | FollowUpCommandRequest,
    caller: NonNullable<import('../src').CLIOptions['caller']>,
    submit: boolean,
    json = false,
  ) => {
    const client = connection.client,
      storeId = intent.expectedStoreId,
      commandId = intent.commandId;
    const write = json
      ? (line: string) => input.write(JSON.stringify({ kind: 'work.event', commandId, line }))
      : input.write;
    const finish = async (outcome: import('../src').CommandOutcome) => {
      if (json) {
        let actualRun: Awaited<ReturnType<AgentClient['getRun']>> | undefined;
        try {
          const command = await caller.lookup(sessionId, intent);
          const receipt = command.receipt;
          if (
            receipt &&
            typeof receipt === 'object' &&
            !Array.isArray(receipt) &&
            typeof receipt.runId === 'string'
          ) {
            const observed = await client.getRun(receipt.runId);
            if (
              observed.id === receipt.runId &&
              observed.originStoreId === storeId &&
              observed.sessionId === sessionId &&
              observed.originCommandId === commandId
            )
              actualRun = observed;
          }
        } catch {}
        input.write(
          JSON.stringify({
            kind: 'work.outcome',
            sessionId,
            storeId,
            ...outcome,
            ...(actualRun ? { run: actualRun } : {}),
          }),
        );
        if (
          connection.mode === 'paired' &&
          (outcome.status === 'outcome_unknown' || outcome.status === 'waiting_interaction')
        )
          input.prompt(
            `Paired original work ${commandId} ${outcome.status}; host cleanup may interrupt remaining owned work\n`,
          );
      }
      return outcome.exitCode;
    };
    let outcome = await (submit ? run : observeCommand)(sessionId, intent, {
      client: connection.client,
      caller,
      write,
      signal: input.signal,
      answerInteraction: interaction.answerInteraction,
    });
    if (outcome.status === 'failed') {
      const rejected = await client
        .getCommand(commandId, { signal: input.signal })
        .catch(() => undefined);
      if (
        rejected?.id === commandId &&
        rejected.originStoreId === storeId &&
        rejected.sessionId === sessionId &&
        rejected.kind === intent.kind &&
        rejected.status === 'rejected'
      ) {
        const receipt = rejected.receipt;
        if (
          receipt &&
          typeof receipt === 'object' &&
          !Array.isArray(receipt) &&
          typeof receipt.reason === 'string'
        )
          write(`original rejection ${JSON.stringify({ commandId, reason: receipt.reason })}`);
      }
    }
    let savedAnswer = outcome.answerIntent ? structuredClone(outcome.answerIntent) : undefined;
    let cancellationObserved = outcome.cancellationAttempted === true;
    const shown = new Set<string>();
    let childExited = false;
    if (connection.mode === 'paired')
      void connection.exited.then(() => {
        childExited = true;
      });
    if (
      connection.mode === 'shared' &&
      (outcome.status === 'waiting_interaction' || outcome.status === 'outcome_unknown')
    ) {
      write(`Shared connection detached; original work ${commandId} ${outcome.status}`);
      return finish(outcome);
    }
    if (outcome.status === 'waiting_interaction' || outcome.status === 'outcome_unknown')
      write('Paired host remains active for the original work; EOF does not cancel it');
    while (outcome.status === 'waiting_interaction' || outcome.status === 'outcome_unknown') {
      if (input.exitSignal?.aborted && json)
        return finish({ ...outcome, status: 'outcome_unknown', exitCode: 2 });
      input.exitSignal?.throwIfAborted();
      if (childExited) break;
      await new Promise<void>((resolveWait) => {
        const ended = () => {
          clearTimeout(timer);
          input.exitSignal?.removeEventListener('abort', ended);
          resolveWait();
        };
        const timer = setTimeout(ended, 100);
        input.exitSignal?.addEventListener('abort', ended, { once: true });
        if (input.exitSignal?.aborted) ended();
      });
      if (input.exitSignal?.aborted && json)
        return finish({ ...outcome, status: 'outcome_unknown', exitCode: 2 });
      input.exitSignal?.throwIfAborted();
      if (childExited) break;
      outcome = await observeCommand(sessionId, intent, {
        client,
        caller,
        answerIntent: savedAnswer,
        answerInteraction: interaction.answerInteraction,
        // Once cancellation was attempted, subsequent recovery only reads its actual outcome.
        ...(cancellationObserved ? {} : { signal: input.signal }),
        write: (line) => {
          if (!shown.has(line)) {
            shown.add(line);
            write(line);
          }
        },
      });
      savedAnswer = outcome.answerIntent ? structuredClone(outcome.answerIntent) : savedAnswer;
      cancellationObserved ||= outcome.cancellationAttempted === true;
    }
    if (outcome.status !== 'outcome_unknown' && outcome.status !== 'waiting_interaction') {
      try {
        await printOriginalAnswer(client, storeId, sessionId, commandId, write);
      } catch {
        write('Original Model output unavailable');
      }
    }
    return finish(outcome);
  };
  try {
    input.exitSignal?.throwIfAborted();
    if (connection.mode === 'paired') input.onLaunched?.(connection);
    input.signal?.throwIfAborted();
    const { client, bootstrap } = connection;
    if (taskArgs?.status)
      return await printSelectedStatus(
        connection.mode === 'shared'
          ? { ...taskArgs, workspace: connection.fixedWorkspace }
          : taskArgs,
        client,
        input.cwd ?? process.cwd(),
        input.write,
        input.prompt,
        input.signal,
      );
    if (bootstrap.dataAvailability !== 'available') throw new CLIHostError('data_unavailable');
    const storeId = bootstrap.storeId;
    callerAccess = acquireProfileAccess(profile);
    callerJournal = openCallerJournal({
      access: callerAccess,
      acquireWriteLock: () => acquireProfileDataLock(callerAccess!, 'tui_private'),
    });
    const caller = createCLICallerPort({
      client,
      storeId,
      journal: callerJournal,
      ...(args.kind === 'work'
        ? {
            onPrepared: (intent: import('@kite-ai/ui/tui').TuiCallerIntent) =>
              input.write(JSON.stringify({ kind: 'caller.intent', intent })),
          }
        : {}),
    });
    if (args.kind === 'caller' || args.kind === 'work') {
      const sessionId = args.sessionId;
      const view = await client.getView(sessionId, { signal: input.signal }).catch((error) => {
        if (args.kind === 'caller' && args.action === 'lookup') return undefined;
        throw error;
      });
      if (!view) {
        input.write(JSON.stringify({ intent: args.input, phase: 'unknown' }));
        return 2;
      }
      if (
        view.storeId !== storeId ||
        view.session.id !== sessionId ||
        view.session.parentSessionId !== null
      ) {
        if (args.kind === 'caller' && args.action === 'lookup') {
          input.write(JSON.stringify({ intent: args.input, phase: 'unknown' }));
          return 2;
        }
        throw new CLIHostError('caller_scope_unavailable');
      }
      if (connection.mode === 'shared') {
        const workspace = (await client.listAllWorkspaces({ signal: input.signal })).find(
          (w) => w.id === view.session.workspaceId,
        );
        if (!workspace || workspace.rootUri !== pathToFileURL(connection.fixedWorkspace).href)
          throw new CLIHostError('workspace_identity_mismatch');
      }
      if (args.kind === 'caller') {
        const port = createTuiCallerPort({ client, storeId, journal: callerJournal });
        if (args.action === 'list') {
          if (
            args.input.expectedStoreId !== storeId ||
            args.input.workspaceId !== view.session.workspaceId
          )
            throw new CLIHostError('caller_scope_unavailable');
          input.write(
            JSON.stringify({
              kind: 'caller.directory',
              records: (await port.list()).filter(
                (r) =>
                  r.intent.scope.storeId === storeId &&
                  r.intent.scope.sessionId === sessionId &&
                  r.intent.scope.workspaceId === args.input.workspaceId,
              ),
            }),
          );
          return 0;
        }
        const intent = parseCallerIntent(args.input);
        const row = callerJournal
          .list()
          .find((r) => r.intent.request.commandId === intent.request.commandId);
        if (!row || callerCanonical(row.intent) !== callerCanonical(intent)) {
          input.write(JSON.stringify({ intent, phase: 'unknown' }));
          return 2;
        }
        const result = await port.lookup(intent, input.signal ?? new AbortController().signal);
        input.write(JSON.stringify(result));
        return result.phase === 'unknown' || result.phase === 'accepted'
          ? 2
          : result.phase === 'rejected'
            ? 1
            : 0;
      }
      const request = args.input as unknown as import('@kite-ai/client').CallerCommandRequest;
      // Work receipts precede observing the exact original Run lifecycle.
      try {
        let saved: ReturnType<typeof callerJournal.list>[number] | undefined;
        try {
          saved = callerJournal
            .list()
            .find((r) => r.intent.request.commandId === request.commandId);
        } catch (error) {
          throw new CLICallerPrepareError(error);
        }
        if (
          saved &&
          (saved.intent.scope.storeId !== request.expectedStoreId ||
            saved.intent.scope.sessionId !== sessionId ||
            saved.intent.scope.workspaceId !== view.session.workspaceId ||
            saved.intent.bodyDigest !== callerDigest(JSON.parse(JSON.stringify(request))))
        ) {
          input.write(
            JSON.stringify({
              kind: 'caller.receipt',
              commandId: request.commandId,
              phase: 'unknown',
            }),
          );
          return 2;
        }
        const command = await caller.submit(sessionId, request, input.signal);
        input.write(JSON.stringify({ kind: 'caller.receipt', command }));
        if (request.kind === 'run.start' || request.kind === 'input.follow_up')
          return await executeWork(sessionId, request, caller, false, true);
        return command.status === 'rejected' ? 1 : command.status === 'applied' ? 0 : 2;
      } catch (error) {
        if (error instanceof CLICallerPrepareError) {
          input.write(
            JSON.stringify({
              kind: 'caller.receipt',
              commandId: request.commandId,
              phase: 'not_submitted',
              code: error.code,
              reason: error.reason,
            }),
          );
          return 1;
        }
        input.write(
          JSON.stringify({
            kind: 'caller.receipt',
            commandId: request.commandId,
            phase: 'unknown',
          }),
        );
        if (request.kind === 'run.start' || request.kind === 'input.follow_up')
          return await executeWork(sessionId, request, caller, false, true);
        return 2;
      }
    }
    if (args.kind !== 'run' && args.kind !== 'resume')
      throw new CLIHostError('cli_command_unavailable');
    const { session, workspace } = await ensureSession(
      connection.mode === 'shared' ? { ...args, workspace: connection.fixedWorkspace } : args,
      client,
      storeId,
      input.cwd ?? process.cwd(),
      input.write,
      input.signal,
    );
    const options = { client, caller, write: input.write, signal: input.signal };
    if (args.trustWorkspace) {
      const observed = await client.getWorkspaceTrust(workspace.id, {
        storeId,
        signal: input.signal,
      });
      const outcome = await setWorkspaceTrust(
        workspace.id,
        {
          expectedStoreId: storeId,
          commandId: crypto.randomUUID(),
          ifRevision: observed.revision,
          trusted: true,
          canonicalIdentity: observed.canonicalIdentity,
          externalReadScopeDigest: observed.externalReadScopeDigest,
        },
        options,
      );
      if (outcome.exitCode !== 0) return outcome.exitCode;
    }
    if (args.permissionMode) {
      const observed = await client.getPermissionMode(session.id, {
        storeId,
        signal: input.signal,
      });
      const outcome = await setPermissionMode(
        session.id,
        {
          expectedStoreId: storeId,
          commandId: crypto.randomUUID(),
          ifRevision: observed.revision,
          ifDefaultRevision: observed.defaultRevision,
          makeDefault: false,
          mode: args.permissionMode,
        },
        options,
      );
      if (outcome.exitCode !== 0) return outcome.exitCode;
    }
    input.signal?.throwIfAborted();
    const activations = args.activateSkills?.length
      ? selectWorkflowActivations(
          await client.listAllSkills(workspace.id, {
            storeId,
            workflow: 'manual',
            signal: input.signal,
          }),
          args.activateSkills,
        )
      : [];
    input.signal?.throwIfAborted();
    const current = activations.length
      ? await client.getView(session.id, { signal: input.signal })
      : undefined;
    if (current && (current.storeId !== storeId || current.session.id !== session.id))
      throw new CLIHostError('session_identity_mismatch');
    const activeRun = current?.runs.find((value) => value.isActive);
    const commandId = crypto.randomUUID();
    input.write(`work intent ${JSON.stringify({ storeId, sessionId: session.id, commandId })}`);
    const intent = Object.freeze({
      ...(activeRun
        ? {
            kind: 'input.follow_up' as const,
            afterRunId: activeRun.id,
            contextSelectionId: current!.session.contextSelectionId,
          }
        : { kind: 'run.start' as const }),
      expectedStoreId: storeId,
      commandId,
      content: args.task,
      ...(args.skills.length ? { selectedSkills: [...new Set(args.skills)] } : {}),
      ...(args.model ? { modelId: args.model } : {}),
      ...(activations.length
        ? {
            extensionInputs: [
              {
                extensionId: 'builtin.skill-workflow',
                definitionVersion: '1',
                input: { activations },
              },
            ],
          }
        : {}),
    });
    return await executeWork(session.id, intent, caller, true);
  } finally {
    input.exitSignal?.removeEventListener('abort', stopHost);
    interaction.dispose();
    callerJournal?.close();
    callerAccess?.lock.release();
    (taskArgs?.status || args.kind === 'work' || args.kind === 'caller'
      ? input.prompt
      : input.write)(
      connection.mode === 'shared'
        ? 'Shared client disconnected; daemon work remains owned by Service'
        : "Paired host exit stops only this Service instance's remaining owned work",
    );
    await connection.close();
  }
}
