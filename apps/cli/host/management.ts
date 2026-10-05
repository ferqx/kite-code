import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import type {
  AgentClient,
  CompressContextRequest,
  ContextQuery,
  DeleteSessionRequest,
  ForkSessionRequest,
  IncludeResultRequest,
  ReconcileJobRequest,
  RenameSessionRequest,
  ResetCompressionRequest,
  SelectContextRequest,
} from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { ManagementCLIArguments } from '../src/arguments';
import {
  type ContextOutcome,
  getCompleteContext,
  includeHistoricalResult,
  lookupContextOutcome,
  rewindContext,
} from '../src/context';
import { observeRecoveryRun } from '../src/index';
import { reconcileJob } from '../src/job-reconcile';
import { lookupRecovery, type RecoveryIntent, submitRecovery } from '../src/recovery';
import {
  lookupManagementOutcome,
  type ManagementIntent,
  type ManagementOutcome,
  submitManagement,
} from '../src/session-management';
import { createStdioInteractionHandler, type StdioInput } from '../src/stdio-interactions';
import {
  CLIHostError,
  type CLIServiceArtifact,
  parseCLIServiceArtifact,
  verifyArtifact,
} from './index';
import { openRecoveryJournal } from './recovery-journal';
export async function runSelectedManagement(input: {
  arguments: ManagementCLIArguments;
  artifact?: CLIServiceArtifact;
  resolveArtifact?: () => CLIServiceArtifact;
  dataRoot: string;
  profile?: string;
  write(line: string): void;
  stdin?: StdioInput;
  prompt?(line: string): void;
  signal?: AbortSignal;
  exitSignal?: AbortSignal;
}): Promise<number> {
  const args = structuredClone(input.arguments);
  const interaction =
    args.kind === 'recovery'
      ? createStdioInteractionHandler({ input: input.stdin, write: input.prompt })
      : undefined;
  const observe = async (
    saved: import('../src/recovery').RecoveryOutcome,
    client: AgentClient,
    signal: AbortSignal,
    mode: 'paired' | 'shared',
  ) => {
    input.write(JSON.stringify(saved));
    if (saved.status !== 'resumed' || !saved.run) return saved.exitCode;
    const outcome = await observeRecoveryRun(
      saved.intent.sessionId,
      {
        commandId: saved.run.originCommandId,
        expectedStoreId: saved.intent.request.expectedStoreId,
        runId: saved.run.id,
      },
      { client, write: input.write, signal, answerInteraction: interaction?.answerInteraction },
    );
    input.write(JSON.stringify({ kind: 'recovery.run_observation', runId: saved.run.id, outcome }));
    const run = await client.getRun(saved.run.id, { signal });
    if (
      run.id !== saved.run.id ||
      run.originCommandId !== saved.run.originCommandId ||
      run.originStoreId !== saved.intent.request.expectedStoreId ||
      run.sessionId !== saved.intent.sessionId
    )
      throw new CLIHostError('recovery_scope_unavailable');
    if (run.isActive)
      input.write(
        JSON.stringify({
          kind: 'recovery.observation_ended',
          runId: run.id,
          runStatus: run.status,
          reason: outcome.status,
          host: mode === 'paired' ? 'owned_service_shutdown_on_exit' : 'shared_service_detach',
        }),
      );
    input.write(JSON.stringify({ ...saved, run, exitCode: outcome.exitCode }));
    return outcome.exitCode;
  };
  input.signal?.throwIfAborted();
  input.exitSignal?.throwIfAborted();
  const profile = selectProfile({
    dataRoot: args.dataRoot ?? input.dataRoot,
    profile: input.profile ?? 'default',
  });
  const network = new AbortController();
  const connection = args.server
    ? await (await import('./shared-service')).connectSharedService({
        profile,
        server: args.server,
        requiredCapabilities: [
          'sessions',
          'commands',
          ...(args.kind === 'job' ? ['job_reconcile'] : []),
          ...(args.kind === 'recovery' && !['lookup', 'list'].includes(args.action)
            ? [
                args.action === 'run'
                  ? 'run_resume'
                  : args.action === 'report'
                    ? 'job_report_resume'
                    : 'session_recovery',
              ]
            : []),
          ...(args.kind === 'context' || args.action === 'fork' ? ['context'] : []),
        ],
        signal: input.exitSignal
          ? AbortSignal.any([input.signal ?? network.signal, input.exitSignal])
          : input.signal,
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
            requiredCapabilities: [
              'sessions',
              'commands',
              ...(args.kind === 'job' ? ['job_reconcile'] : []),
              ...(args.kind === 'recovery' && !['lookup', 'list'].includes(args.action)
                ? [
                    args.action === 'run'
                      ? 'run_resume'
                      : args.action === 'report'
                        ? 'job_report_resume'
                        : 'session_recovery',
                  ]
                : []),
              ...(args.kind === 'context' || args.action === 'fork' ? ['context'] : []),
            ],
          })),
        };
      })();
  let recoveryAccess: ReturnType<typeof acquireProfileAccess> | undefined,
    recoveryJournal: ReturnType<typeof openRecoveryJournal> | undefined;
  let cancelled = false,
    closing = false;
  let submitted = false,
    cancellationReady = false;
  let cancelPromise: Promise<unknown> | undefined;
  const original = args.input as unknown as { commandId?: string; expectedStoreId?: string };
  const cancel = () => {
    if (
      !submitted ||
      !cancellationReady ||
      cancelled ||
      !original.commandId ||
      !original.expectedStoreId
    )
      return;
    cancelled = true;
    cancelPromise = connection.client
      .cancelCommand(
        args.kind === 'session' && args.action === 'fork'
          ? String(args.input.newSessionId)
          : args.sessionId,
        {
          expectedStoreId: original.expectedStoreId,
          commandId: crypto.randomUUID(),
          kind: 'command.cancel',
          targetCommandId: original.commandId,
        },
        { signal: network.signal },
      )
      .catch(() => {});
  };
  const exit = () => {
    closing = true;
    network.abort();
    void connection.close();
  };
  const interrupt = () => {
    if (args.kind === 'job' || args.kind === 'recovery') network.abort();
    else if (submitted) cancel();
    else network.abort();
  };
  input.signal?.addEventListener('abort', interrupt, { once: true });
  input.exitSignal?.addEventListener('abort', exit, { once: true });
  try {
    if (input.exitSignal?.aborted) exit();
    if (input.signal?.aborted) interrupt();
    network.signal.throwIfAborted();
    if (connection.bootstrap.dataAvailability !== 'available')
      throw new CLIHostError('data_unavailable');
    const storeId = connection.bootstrap.storeId;
    const given =
      args.kind === 'recovery' && args.action === 'lookup'
        ? ((args.input.request as { expectedStoreId?: string })?.expectedStoreId ??
          args.input.expectedStoreId)
        : args.action === 'read'
          ? args.input.storeId
          : args.input.expectedStoreId;
    if (given !== storeId) throw new CLIHostError('store_identity_mismatch');
    const scopeSignal = AbortSignal.any([network.signal, ...(input.signal ? [input.signal] : [])]);
    scopeSignal.throwIfAborted();
    if (args.kind === 'recovery') {
      recoveryAccess = acquireProfileAccess(profile);
      recoveryJournal = openRecoveryJournal({
        access: recoveryAccess,
        acquireWriteLock: () => acquireProfileDataLock(recoveryAccess!, 'tui_private'),
      });
      if (args.action === 'list') {
        input.write(
          JSON.stringify({
            kind: 'recovery.directory',
            records: recoveryJournal
              .list()
              .filter(
                (row) =>
                  row.intent.sessionId === args.sessionId &&
                  row.intent.request.expectedStoreId === storeId,
              ),
          }),
        );
        return 0;
      }
      if (args.action === 'lookup') {
        const intent =
          args.input.request !== undefined
            ? (args.input as unknown as RecoveryIntent)
            : recoveryJournal
                .list()
                .find((row) => row.intent.request.commandId === args.input.commandId)?.intent;
        if (
          !intent ||
          intent.sessionId !== args.sessionId ||
          intent.request.expectedStoreId !== storeId
        )
          throw new CLIHostError('recovery_intent_unavailable');
        recoveryJournal.prepare(intent);
        const saved = await lookupRecovery(intent, {
          client: connection.client,
          signal: scopeSignal,
          journal: recoveryJournal,
          waitForRun: false,
        });
        const code = await observe(saved, connection.client, scopeSignal, connection.mode);
        return input.signal?.aborted ? 130 : code;
      }
    }
    const view = await connection.client.getView(args.sessionId, { signal: scopeSignal });
    if (
      view.storeId !== storeId ||
      view.session.id !== args.sessionId ||
      view.session.rootSessionId !== args.sessionId ||
      view.session.parentSessionId !== null
    )
      throw new CLIHostError('management_scope_unavailable');
    if (connection.mode === 'shared') {
      const workspace = (await connection.client.listAllWorkspaces({ signal: scopeSignal })).find(
        (item) => item.id === view.session.workspaceId,
      );
      if (!workspace || workspace.rootUri !== pathToFileURL(connection.fixedWorkspace).href)
        throw new CLIHostError('workspace_identity_mismatch');
    }
    scopeSignal.throwIfAborted();
    if (args.kind === 'recovery') {
      const intent: RecoveryIntent =
        args.action === 'lookup'
          ? (args.input as unknown as RecoveryIntent)
          : args.action === 'interrupt'
            ? {
                kind: 'interrupt',
                sessionId: args.sessionId,
                request: args.input as unknown as import('@kite-ai/client').RecoverSessionRequest,
              }
            : args.action === 'run'
              ? {
                  kind: 'run',
                  sessionId: args.sessionId,
                  request: args.input as unknown as import('@kite-ai/client').ResumeRunRequest,
                }
              : {
                  kind: 'report',
                  sessionId: args.sessionId,
                  reportCommandId: args.reportCommandId!,
                  request:
                    args.input as unknown as import('@kite-ai/client').ResumeJobReportRequest,
                };
      const saved = await (args.action === 'lookup' ? lookupRecovery : submitRecovery)(intent, {
        client: connection.client,
        write: input.write,
        signal: scopeSignal,
        journal: recoveryJournal,
        waitForRun: false,
      });
      const code = await observe(saved, connection.client, scopeSignal, connection.mode);
      if (input.signal?.aborted) return 130;
      if (closing || input.exitSignal?.aborted) return 2;
      return code;
    }
    if (args.kind === 'job') {
      const saved = await reconcileJob(
        { sessionId: args.sessionId, request: args.input as ReconcileJobRequest },
        { client: connection.client, write: input.write, signal: network.signal },
      );
      input.write(JSON.stringify(saved));
      if (input.signal?.aborted) return 130;
      if (closing || input.exitSignal?.aborted) return 2;
      return saved.exitCode;
    }
    const mutationMethods = new Set([
      'renameSession',
      'deleteSession',
      'forkSession',
      'compressContext',
      'resetCompressionContext',
      'rewind',
      'includeResult',
    ]);
    const client = new Proxy(connection.client, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        if (!mutationMethods.has(String(key))) return value.bind(target);
        return (...parameters: unknown[]) => {
          scopeSignal.throwIfAborted();
          submitted = true;
          return value.apply(target, parameters);
        };
      },
    }) as AgentClient;
    const options = { client, write: input.write, signal: network.signal };
    if (args.kind === 'context' && args.action === 'read') {
      input.write(
        JSON.stringify(
          await getCompleteContext(args.sessionId, args.input as ContextQuery, {
            ...options,
            signal: scopeSignal,
          }),
        ),
      );
      return 0;
    }
    if (input.signal?.aborted) return 130;
    if (closing || input.exitSignal?.aborted) return 2;
    let saved: ContextOutcome | ManagementOutcome;
    if (args.kind === 'context' && args.action === 'rewind')
      saved = await rewindContext(args.sessionId, args.input as SelectContextRequest, options);
    else if (args.kind === 'context' && args.action === 'include')
      saved = await includeHistoricalResult(
        args.sessionId,
        args.executionId!,
        args.input as IncludeResultRequest,
        options,
      );
    else {
      const intent: ManagementIntent =
        args.kind === 'session'
          ? args.action === 'rename'
            ? {
                kind: 'session.rename',
                sessionId: args.sessionId,
                request: args.input as RenameSessionRequest,
              }
            : args.action === 'delete'
              ? {
                  kind: 'session.delete',
                  sessionId: args.sessionId,
                  request: args.input as DeleteSessionRequest,
                }
              : {
                  kind: 'session.fork',
                  sessionId: args.sessionId,
                  request: args.input as ForkSessionRequest,
                }
          : args.action === 'compact'
            ? {
                kind: 'context.compress',
                sessionId: args.sessionId,
                request: args.input as CompressContextRequest,
              }
            : {
                kind: 'context.compression.reset',
                sessionId: args.sessionId,
                request: args.input as ResetCompressionRequest,
              };
      saved = await submitManagement(intent, options);
    }
    for (;;) {
      cancellationReady = saved.status !== 'failed' && saved.status !== 'outcome_unknown';
      if (input.signal?.aborted) cancel();
      input.write(JSON.stringify(saved));
      if (cancelled || input.signal?.aborted) return 130;
      if (closing || input.exitSignal?.aborted) return 2;
      if (saved.status === 'failed') return 1;
      if (saved.status === 'applied') return 0;
      if (saved.status === 'delete_requested') return 2; // durable request is not confirmed group stop
      await Bun.sleep(100);
      saved =
        'intent' in saved
          ? await lookupManagementOutcome(saved.intent, options)
          : await lookupContextOutcome(saved, options);
    }
  } catch (error) {
    if (closing || input.exitSignal?.aborted) return 2;
    if (input.signal?.aborted) return 130;
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', interrupt);
    input.exitSignal?.removeEventListener('abort', exit);
    await cancelPromise;
    interaction?.dispose();
    recoveryJournal?.close();
    recoveryAccess?.lock.release();
    await connection.close();
  }
}
