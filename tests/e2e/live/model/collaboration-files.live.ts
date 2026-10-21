import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension, Json, ToolDefinition } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';

export interface LiveCollaborationFilesOptions {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests: () => readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
export interface LiveCollaborationFilesResult {
  id: 'F01';
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  canonicalEvidenceRetained: boolean;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
}
function record(value: unknown): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function wait(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(Error('live_collaboration_file_barrier_aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Actual Files CAS and real-model recovery, using an explicitly owned allowed fixture, not default policy qualification. */
export async function runLiveCollaborationFiles(
  options: LiveCollaborationFilesOptions,
): Promise<{ cases: LiveCollaborationFilesResult[] }> {
  if (options.caseIds && !options.caseIds.includes('F01')) return { cases: [] };
  if (options.evidenceRoot && !isAbsolute(options.evidenceRoot))
    throw Error('live_collaboration_evidence_root_invalid');
  options.signal.throwIfAborted();
  let ownedRoot: string | undefined;
  let storeResource: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let filesResource: ReturnType<typeof createWorkspaceFiles> | undefined;
  let locksResource: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let runtimeResource: ReturnType<typeof createRuntime> | undefined;
  let serviceResource: Awaited<ReturnType<typeof startService>> | undefined;
  let clientResource: ReturnType<typeof createClient> | undefined;
  let storeClose: Promise<void> | undefined;
  let filesClose: Promise<void> | undefined;
  let locksClose: Promise<void> | undefined;
  let runtimeClose: Promise<void> | undefined;
  let serviceClose: Promise<void> | undefined;
  const closeStore = () => (storeClose ??= Promise.resolve().then(() => storeResource?.close()));
  const closeFiles = () => (filesClose ??= Promise.resolve().then(() => filesResource?.close()));
  const closeLocks = () => (locksClose ??= Promise.resolve().then(() => locksResource?.close()));
  const closeAuxiliary = async () => {
    const results = await Promise.allSettled([closeFiles(), closeLocks()]);
    if (results.some((result) => result.status === 'rejected'))
      throw Error('live_collaboration_files_cleanup_failed');
  };
  const closeOwner = () => {
    if (serviceResource) {
      serviceClose ??= Promise.resolve().then(() => serviceResource!.close());
      return serviceClose;
    }
    if (runtimeResource) {
      runtimeClose ??= Promise.resolve().then(() => {
        const shutdown = runtimeResource!.tryBeginShutdown('cancel', {
          beforeResourceClose: closeAuxiliary,
        });
        if (!shutdown.accepted) throw Error('live_collaboration_files_shutdown_rejected');
        return shutdown.completion;
      });
      return runtimeClose;
    }
    return closeStore();
  };
  const bothRead = gate();
  const published = gate();
  const checks: Record<string, boolean | number> = {};
  let status: LiveCollaborationFilesResult['status'] = 'inconclusive';
  let reason: LiveCollaborationFilesResult['reason'];
  let canonicalEvidenceRetained = false;
  const startRequests = options.requests().length;
  try {
    if (options.evidenceRoot) {
      mkdirSync(options.evidenceRoot, { mode: 0o700 });
      ownedRoot = options.evidenceRoot;
    } else ownedRoot = mkdtempSync(join(tmpdir(), 'kite-live-files-cas-'));
    const root = realpathSync(ownedRoot);
    ownedRoot = root;
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const path = 'shared.ini';
    const keep = `KEEP_${crypto.randomUUID()}_🪁`;
    const initial = `A=0\r\nB=0\r\nkeep=${keep}\r\n`;
    const expected = Buffer.from(initial.replace('A=0', 'A=1').replace('B=0', 'B=1'));
    const target = join(workspace, path);
    writeFileSync(target, initial, { mode: 0o600 });
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    storeResource = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
    });
    const actualStore = storeResource;
    const store = new Proxy(actualStore, {
      get(target, key) {
        if (key === 'close') return closeStore;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    filesResource = createWorkspaceFiles({ root: workspace });
    const files = filesResource;
    locksResource = createWorkspaceSerialLocks(profile);
    const locks = locksResource;
    const barrierSignal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]);
    const initialReads = new Map<string, { baseline: Json; executionId: string }>();
    const reads: {
      sessionId: string;
      executionId: string;
      baseline: Json;
      afterConflict: boolean;
    }[] = [];
    const writes: {
      sessionId: string;
      executionId: string;
      input: Json;
      usedInitialBaseline: boolean;
      conflict: boolean;
      success: boolean;
      zeroOverwrite: boolean;
    }[] = [];
    const conflicted = new Set<string>();
    let firstWriter: string | undefined;
    let publishedFirst = false;
    let firstPublicationExact = false;
    const actualTools = createFileTools(files).filter((tool) =>
      ['files.read', 'files.write', 'files.edit'].includes(tool.id),
    );
    const tools: ToolDefinition[] = actualTools.map((tool) => ({
      ...tool,
      async execute(input, context) {
        const args = record(input);
        if (tool.id === 'files.read') {
          const result = await tool.execute(input, context);
          if (
            context.sessionId !== 'root' &&
            args.path === path &&
            result.outcome === 'succeeded'
          ) {
            let body: Record<string, Json> = {};
            try {
              body = record(JSON.parse(result.content));
            } catch {
              /* Missing baseline cannot establish this CAS branch. */
            }
            if (body.baseline) {
              const read = {
                sessionId: context.sessionId,
                executionId: context.executionId,
                baseline: structuredClone(body.baseline),
                afterConflict: conflicted.has(context.sessionId),
              };
              reads.push(read);
              if (!initialReads.has(context.sessionId)) initialReads.set(context.sessionId, read);
              if (initialReads.size === 2) bothRead.release();
            }
          }
          return result;
        }
        if (!firstWriter) firstWriter = context.sessionId;
        const isFirst = writes.length === 0;
        await wait(bothRead.promise, AbortSignal.any([context.signal, barrierSignal]));
        if (context.sessionId !== firstWriter)
          await wait(published.promise, AbortSignal.any([context.signal, barrierSignal]));
        const before = readFileSync(target);
        const observed = {
          sessionId: context.sessionId,
          executionId: context.executionId,
          input: structuredClone(input),
          usedInitialBaseline: isDeepStrictEqual(
            args.base,
            initialReads.get(context.sessionId)?.baseline,
          ),
          conflict: false,
          success: false,
          zeroOverwrite: false,
        };
        writes.push(observed);
        const result = await tool.execute(input, context);
        const after = readFileSync(target);
        observed.success = result.outcome === 'succeeded';
        observed.conflict =
          result.outcome === 'failed' && record(result.details).code === 'file_baseline_conflict';
        observed.zeroOverwrite = before.equals(after);
        if (observed.conflict) conflicted.add(context.sessionId);
        if (isFirst && observed.success) {
          publishedFirst = true;
          firstPublicationExact =
            after.equals(Buffer.from(initial.replace('A=0', 'A=1'))) ||
            after.equals(Buffer.from(initial.replace('B=0', 'B=1')));
          published.release();
        }
        return result;
      },
    }));
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      stream(request, context) {
        return options.model.stream(request, {
          signal: AbortSignal.any([context.signal, options.signal]),
        });
      },
    };
    const task = createTaskExtension({
      roles: [
        {
          id: 'worker',
          configurationId: 'worker',
          description:
            'Edit only the assigned field using actual file baseline and preserve other content.',
        },
      ],
    });
    const fileExtension: Extension = { id: 'live.files-cas', version: '1', apiMajor: 1, tools };
    runtimeResource = createRuntime({
      store,
      model,
      modelId: options.modelId,
      modelConcurrency: 3,
      workspaceSerialLocks: locks,
      artifacts: createArtifactStore({ profile, store }),
      extensions: [task, fileExtension],
      permissions: {
        async authorize(request) {
          const owned =
            request.kind !== 'tool' ||
            request.definitionId.startsWith('task.') ||
            (request.sessionId !== 'root' &&
              ['files.read', 'files.write', 'files.edit'].includes(request.definitionId) &&
              record(request.input).path === path);
          return {
            allowed: owned,
            revision: 'explicit-owned-live-files-cas-1',
            ...(owned ? {} : { reason: 'live_target_out_of_scope' }),
          };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: tools.map((tool) => tool.id),
          snapshot: {},
        },
      ],
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'explicit-owned-live-files-cas-1' };
        },
      },
    });
    const runtime = runtimeResource;
    const expectedStoreId = (await store.getMetadata()).storeId;
    // Public Session enumeration includes roots only. Discover actual descendants
    // through their persisted carrier edges and validate every original scope.
    async function treeSessions() {
      const rootSession = await store.getSession('root');
      if (
        (await store.getMetadata()).storeId !== expectedStoreId ||
        !rootSession ||
        rootSession.parentSessionId !== null ||
        rootSession.rootSessionId !== 'root' ||
        rootSession.workspaceId !== 'w'
      )
        throw Error('live_collaboration_root_relation_invalid');
      const currentWorkspace = await store.getWorkspace(rootSession.workspaceId);
      if (!currentWorkspace || currentWorkspace.rootUri !== pathToFileURL(workspace).href)
        throw Error('live_collaboration_workspace_relation_invalid');
      const sessions = [rootSession];
      const seen = new Set([rootSession.id]);
      for (let index = 0; index < sessions.length; index++) {
        const parent = sessions[index]!;
        for (const carrier of await store.listExecutions(parent.id)) {
          if (!carrier.childSessionId) continue;
          const child = await store.getSession(carrier.childSessionId);
          if (
            !child ||
            child.id === parent.id ||
            child.parentSessionId !== parent.id ||
            child.rootSessionId !== rootSession.id ||
            child.workspaceId !== rootSession.workspaceId ||
            carrier.sessionId !== parent.id ||
            carrier.originStoreId !== expectedStoreId
          )
            throw Error('live_collaboration_child_relation_invalid');
          if (seen.has(child.id)) continue;
          if (sessions.length >= 64) throw Error('live_collaboration_tree_observation_limit');
          seen.add(child.id);
          sessions.push(child);
        }
      }
      return sessions;
    }
    serviceResource = await startService({
      beforeResourceClose: closeAuxiliary,
      runtime,
      subjectId: 'live-owner',
      buildId: 'live-files-cas',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    const service = serviceResource;
    clientResource = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
    const client = clientResource;
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'synthetic',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      title: 'Explicit live Files CAS test',
    });
    const leaf = (field: 'A' | 'B') =>
      `Read ${path} using read_file and save the complete baseline. Change ONLY ${field}=0 to ${field}=1 using edit_file with that exact baseline, old_text ${field}=0, new_text ${field}=1, expected_matches 1. Preserve every other byte including CRLF and random keep data. If your actual write conflicts, reread the current file and use its NEW complete baseline for a NEW invocation that preserves the other editor's change. Do not invent baselines, overwrite another field, or use Shell. Report the actual final result.`;
    const request = {
      kind: 'run.start' as const,
      content: `New task: Create exactly two worker collaborators using spawn_agent, before waiting. Worker A: ${leaf('A')} Worker B: ${leaf('B')} Do not read or write files yourself. Use wait_agent_events to collect their real results, and report completion only after both are actually finished.`,
    };
    await client.startRun('root', { expectedStoreId, commandId: 'work', ...request });
    const end = Date.now() + 150_000;
    for (;;) {
      options.signal.throwIfAborted();
      const sessions = await treeSessions();
      const executions = (
        await Promise.all(sessions.map((session) => store.listExecutions(session.id)))
      ).flat();
      const views = await Promise.all(sessions.map((session) => client.getView(session.id)));
      if (
        sessions.length >= 3 &&
        views.every((view) => view.runs.every((run) => !run.isActive)) &&
        executions
          .filter((execution) => execution.kind === 'job' && execution.childSessionId)
          .every((execution) =>
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status),
          )
      )
        break;
      if (Date.now() >= end) break;
      await Bun.sleep(25);
    }
    const sessions = await treeSessions();
    const executions = (
      await Promise.all(sessions.map((session) => store.listExecutions(session.id)))
    ).flat();
    const views = await Promise.all(sessions.map((session) => client.getView(session.id)));
    const carriers = executions.filter(
      (execution) => execution.kind === 'job' && execution.childSessionId,
    );
    const conflicts = writes.filter((write) => write.conflict);
    const conflict = conflicts[0];
    const retry = conflict
      ? writes.find(
          (write) =>
            write.sessionId === conflict.sessionId &&
            write.success &&
            write.executionId !== conflict.executionId,
        )
      : undefined;
    const retryRead = conflict
      ? reads.find((read) => read.sessionId === conflict.sessionId && read.afterConflict)
      : undefined;
    checks.realModelRequests = options.requests().length - startRequests;
    checks.exactTwoChildren =
      sessions.length === 3 &&
      sessions
        .filter((session) => session.id !== 'root')
        .every((session) => session.parentSessionId === 'root');
    checks.twoOriginalBaselines =
      initialReads.size === 2 &&
      isDeepStrictEqual(
        [...initialReads.values()][0]?.baseline,
        [...initialReads.values()][1]?.baseline,
      );
    checks.firstPhysicalPublication = publishedFirst && firstPublicationExact;
    checks.conflicts = conflicts.length;
    checks.actualOldBaselineConflict = !!conflict?.usedInitialBaseline;
    checks.conflictZeroOverwrite = !!conflict?.zeroOverwrite;
    checks.realFreshReadAfterConflict =
      !!retryRead &&
      !isDeepStrictEqual(retryRead.baseline, initialReads.get(retryRead.sessionId)?.baseline);
    checks.newInvocationFreshBaseline =
      !!retry && !!retryRead && isDeepStrictEqual(record(retry.input).base, retryRead.baseline);
    checks.finalBytesExact = readFileSync(target).equals(expected);
    checks.successfulWrites = writes.filter((write) => write.success).length;
    checks.noUnknown = executions.every((execution) => execution.status !== 'outcome_unknown');
    checks.settled =
      views.every((view) => view.runs.every((run) => !run.isActive)) &&
      carriers.length === 2 &&
      carriers.every((carrier) => carrier.status === 'succeeded');
    const modelExecutions = executions.filter(
      (execution) => execution.kind === 'model' && execution.status === 'succeeded',
    );
    checks.realModelSessions = new Set(
      modelExecutions.map((execution) => execution.sessionId),
    ).size;
    let snapshotsExact = true;
    let conflictPrepared = false;
    const adopted = new Set<string>();
    for (const execution of modelExecutions) {
      const observed = options
        .requests()
        .slice(startRequests)
        .find((request) => request.requestId === execution.id);
      const saved = await runtime.readModelInput({
        expectedStoreId,
        sessionId: execution.sessionId,
        subjectId: 'live-owner',
        executionId: execution.id,
      });
      if (!observed) {
        snapshotsExact = false;
        continue;
      }
      const visible = structuredClone(observed);
      for (const message of visible.messages)
        delete (message as { continuation?: unknown }).continuation;
      snapshotsExact &&= isDeepStrictEqual(saved.request, visible);
      if (conflict && execution.sessionId === conflict.sessionId)
        conflictPrepared ||= saved.request.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.sourceIds?.includes(conflict.executionId) &&
            message.content.includes('file_baseline_conflict'),
        );
      if (execution.sessionId === 'root')
        for (const carrier of carriers)
          if (
            carrier.resultAcceptance &&
            saved.request.messages.some((message) =>
              message.sourceIds?.includes(carrier.resultAcceptance!.sourceId),
            )
          )
            adopted.add(carrier.id);
    }
    checks.allSavedSnapshotsExact = snapshotsExact && modelExecutions.length > 0;
    checks.actualConflictPrepared = conflictPrepared;
    checks.bothSourcesPrepared = adopted.size === 2;
    if (!conflict?.usedInitialBaseline || !checks.twoOriginalBaselines || !checks.settled)
      reason = 'branch_not_reached';
    else {
      const passed =
        checks.exactTwoChildren &&
        checks.firstPhysicalPublication &&
        checks.conflicts === 1 &&
        checks.conflictZeroOverwrite &&
        checks.realFreshReadAfterConflict &&
        checks.newInvocationFreshBaseline &&
        checks.finalBytesExact &&
        checks.successfulWrites === 2 &&
        checks.noUnknown &&
        checks.realModelSessions === 3 &&
        checks.allSavedSnapshotsExact &&
        checks.actualConflictPrepared &&
        checks.bothSourcesPrepared;
      status = passed ? 'passed' : 'failed';
      if (!passed) reason = 'oracle_violation';
    }
  } catch {
    reason = 'execution_unavailable';
  } finally {
    bothRead.release();
    published.release();
    let cleanupFailed = false;
    try {
      clientResource?.disposeNetwork();
    } catch {
      cleanupFailed = true;
    }
    try {
      await closeOwner();
    } catch {
      cleanupFailed = true;
    }
    // Always attempt both independent resources, even after an owner's failure.
    // Their memoized promises also serve the runtime's beforeResourceClose hook.
    try {
      await closeAuxiliary();
    } catch {
      cleanupFailed = true;
    }
    checks.resourcesClosed = !cleanupFailed;
    if (cleanupFailed) {
      status = 'failed';
      reason = 'cleanup_failed';
    }
    canonicalEvidenceRetained =
      !!ownedRoot && status !== 'passed' && (!!options.evidenceRoot || cleanupFailed);
    if (ownedRoot && !canonicalEvidenceRetained) {
      try {
        rmSync(ownedRoot, { recursive: true, force: true });
      } catch {
        status = 'failed';
        reason = 'cleanup_failed';
        checks.rootRemoved = false;
        canonicalEvidenceRetained = true;
      }
    }
  }
  return {
    cases: [
      {
        id: 'F01',
        status,
        checks,
        coverage: [
          'actual_files_cas',
          'real_two_child_model_decisions',
          'owned_allowed_fixture_not_default_policy',
          'exact_crlf_random_keep_bytes',
          'no_same_mtime_or_inode_variant',
        ],
        canonicalEvidenceRetained,
        ...(reason ? { reason } : {}),
      },
    ],
  };
}
