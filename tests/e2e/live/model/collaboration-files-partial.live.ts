import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json, ToolDefinition } from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

const id = 'F02-X-success-Y-conflict-then-explicit-fresh-baseline' as const;
export type LiveFilesPartialCaseId = typeof id;
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveFilesPartialCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  semanticReviewRequired: true;
}
const object = (value: unknown): Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
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
        abort = () => reject(Error('live_files_partial_aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(reason: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.reason = reason;
    this.point = point;
  }
}
/** Real Files operations; explicit owned allow only. Caller retains 40 physical HTTP / 600s cap. */
export async function runLiveFilesPartial(options: Options): Promise<{ cases: Result[] }> {
  if (options.caseIds && !options.caseIds.includes(id)) return { cases: [] };
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || existsSync(options.evidenceRoot))
  )
    throw Error('live_files_partial_evidence_root_invalid');
  options.signal.throwIfAborted();
  if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(
    options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-files-partial-')),
  );
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const keep = `keep-${randomUUID()}-🪁`;
  const initialX = `A=0\r\nkeep=${keep}\r\n`;
  const initialY = `A=0\r\nB=0\r\nkeep=${keep}\r\n`;
  const xPublished = initialX.replace('A=0', 'A=1');
  const yBPublished = initialY.replace('B=0', 'B=1');
  const yRecovered = yBPublished.replace('A=0', 'A=1');
  writeFileSync(join(workspace, 'X.ini'), initialX, { mode: 0o600 });
  writeFileSync(join(workspace, 'Y.ini'), initialY, { mode: 0o600 });
  const aMarker = `A_ROLE_${randomUUID()}`;
  const bMarker = `B_ROLE_${randomUUID()}`;
  const allowB = gate(),
    bPublished = gate();
  const branchSignal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
  const checks: Result['checks'] = {};
  const stages: Record<string, unknown> = {};
  const firstRequest = options.requests().length;
  let status: Result['status'] = 'inconclusive',
    reason: Result['reason'],
    failurePoint: string | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let files: ReturnType<typeof createWorkspaceFiles> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let storeClosed = false,
    auxiliariesClosed = false;
  let phase: 'initial' | 'explicit-followup' = 'initial';
  const roles = new Map<string, 'A' | 'B'>();
  const reads: {
    role: 'A' | 'B';
    sessionId: string;
    runId: string;
    executionId: string;
    path: string;
    input: Json;
    result: Json;
    baseline: Json;
    completeContentMatchesBeforeBytes: boolean;
    ordinal: number;
    phase: 'initial' | 'explicit-followup';
  }[] = [];
  const writes: {
    role: 'A' | 'B';
    sessionId: string;
    runId: string;
    executionId: string;
    path: string;
    input: Json;
    result: Json;
    success: boolean;
    conflict: boolean;
    before: string;
    after: string;
    ordinal: number;
    phase: 'initial' | 'explicit-followup';
  }[] = [];
  let ordinal = 0;
  const assert = (value: unknown, point: string) => {
    checks[point] = Boolean(value);
    if (!value) throw new Boundary('oracle_violation', point);
  };
  const branch = (value: unknown, point: string) => {
    if (!value) throw new Boundary('branch_not_reached', point);
  };
  async function until<T>(read: () => Promise<T | undefined>, point: string) {
    const end = Date.now() + 90_000;
    for (;;) {
      options.signal.throwIfAborted();
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
      await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), options.signal);
    }
  }
  const closeAuxiliaries = async () => {
    if (auxiliariesClosed) return;
    const results = await Promise.allSettled([files?.close(), locks?.close()]);
    if (results.some((result) => result.status === 'rejected'))
      throw Error('live_files_partial_aux_close_failed');
    auxiliariesClosed = true;
  };
  try {
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const owned = store;
    const expectedStoreId = (await owned.getMetadata()).storeId;
    files = createWorkspaceFiles({ root: workspace });
    locks = createWorkspaceSerialLocks(profile);
    // No checkpoint capture is installed: these original unmodified leaf definitions
    // have no serial/slot reservation. Gate before real IO therefore holds no shared lock.
    const originals = createFileTools(files).filter((tool) =>
      ['files.read', 'files.edit'].includes(tool.id),
    );
    assert(
      originals.length === 2 && originals.every((tool) => !tool.resources),
      'gated_original_file_tools_have_no_shared_resource_reservation',
    );
    const tools: ToolDefinition[] = originals.map((tool) => ({
      ...tool,
      async execute(input, context) {
        const args = object(input);
        const role = roles.get(context.sessionId);
        branch(
          role && context.runId && context.sessionId !== 'root',
          'real_child_file_actor_not_identified',
        );
        const path = typeof args.path === 'string' ? files!.relativePath(args.path) : '';
        branch(path === 'X.ini' || path === 'Y.ini', 'model_file_path_outside_assignment');
        const currentRole = role!;
        if (tool.id === 'files.edit' && phase === 'initial') {
          if (currentRole === 'B')
            await wait(allowB.promise, AbortSignal.any([branchSignal, context.signal]));
          if (currentRole === 'A' && path === 'Y.ini')
            await wait(bPublished.promise, AbortSignal.any([branchSignal, context.signal]));
        }
        const before = readFileSync(join(workspace, path));
        const result = await tool.execute(input, context);
        const after = readFileSync(join(workspace, path));
        if (tool.id === 'files.read' && result.outcome === 'succeeded') {
          let body: Record<string, Json> = {};
          try {
            body = object(JSON.parse(result.content));
          } catch {
            /* No baseline means this branch stays unqualified. */
          }
          if (body.baseline)
            reads.push({
              role: currentRole,
              sessionId: context.sessionId,
              runId: context.runId!,
              executionId: context.executionId,
              path,
              input: structuredClone(input),
              result: structuredClone(result) as unknown as Json,
              baseline: structuredClone(body.baseline),
              completeContentMatchesBeforeBytes:
                body.content === before.toString('utf8') &&
                object(body.baseline).hash === hash(before) &&
                object(body.baseline).size === before.byteLength,
              ordinal: ++ordinal,
              phase,
            });
        } else if (tool.id === 'files.edit') {
          writes.push({
            role: currentRole,
            sessionId: context.sessionId,
            runId: context.runId!,
            executionId: context.executionId,
            path,
            input: structuredClone(input),
            result: structuredClone(result) as unknown as Json,
            success: result.outcome === 'succeeded',
            conflict:
              result.outcome === 'failed' &&
              object(result.details).code === 'file_baseline_conflict',
            before: hash(before),
            after: hash(after),
            ordinal: ++ordinal,
            phase,
          });
        }

        return result;
      },
    }));
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      stream(request, context) {
        return (async function* () {
          const execution = await owned.getExecution(request.requestId);
          if (execution && execution.sessionId !== 'root' && !roles.has(execution.sessionId)) {
            const text = request.messages.map((message) => message.content).join('\n');
            if (text.includes(aMarker)) roles.set(execution.sessionId, 'A');
            else if (text.includes(bMarker)) roles.set(execution.sessionId, 'B');
          }
          yield* options.model.stream(request, {
            signal: AbortSignal.any([context.signal, options.signal]),
          });
        })();
      },
    };
    const permissions = {
      async authorize(request: {
        kind: string;
        definitionId: string;
        sessionId: string;
        input: Json;
      }) {
        const args = object(request.input);
        const allowed =
          request.kind !== 'tool' ||
          request.definitionId.startsWith('task.') ||
          (request.sessionId !== 'root' &&
            ['files.read', 'files.edit'].includes(request.definitionId) &&
            ['X.ini', 'Y.ini'].includes(
              typeof args.path === 'string' ? files!.relativePath(args.path) : '',
            ));
        return {
          allowed,
          revision: 'explicit-owned-files-partial-1',
          ...(allowed ? {} : { reason: 'live_target_out_of_scope' }),
        };
      },
    };
    const afterTurn = {
      async authorize() {
        return { allowed: true as const, revision: 'explicit-owned-files-partial-1' };
      },
    };
    const task = createTaskExtension({
      roles: [
        {
          id: 'worker',
          configurationId: 'worker',
          description: 'Real two-file partial-result editor; report exact individual outcomes.',
        },
      ],
    });
    const rootToolIds = [
      ...tools.map((tool) => tool.id),
      ...task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
    ];
    const rootBinding = (): RunConfiguration => ({
      model,
      modelId: options.modelId,
      toolIds: rootToolIds,
      snapshot: { kind: 'owned-files-partial', version: 1 },
      permissions,
      afterTurn,
    });
    runtime = createRuntime({
      store: owned,
      model,
      modelId: options.modelId,
      modelConcurrency: 4,
      artifacts: createArtifactStore({ profile, store: owned }),
      workspaceSerialLocks: locks,
      extensions: [task, { id: 'live.files-partial', version: '1', apiMajor: 1, tools }],
      permissions,
      afterTurn,
      resolveRunConfiguration: async () => rootBinding(),
      resolveRecoveryRunConfiguration: async ({ run }) => {
        const saved = object(run.configuration);
        return {
          model,
          modelId: options.modelId,
          permissions,
          afterTurn,
          toolIds: Array.isArray(saved.tools)
            ? saved.tools.map((tool) => String(object(tool).id))
            : [],
          snapshot: saved.snapshot as RunConfiguration['snapshot'],
        };
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model,
          modelId: options.modelId,
          toolIds: tools.map((tool) => tool.id),
          snapshot: { kind: 'owned-files-partial-child', version: 1 },
        },
      ],
    });
    service = await startService({
      runtime,
      beforeResourceClose: closeAuxiliaries,
      subjectId: 'live-files-partial-owner',
      buildId: 'live-files-partial',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
    const live = client;
    await live.connect();
    await live.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned partial Files',
      rootUri: pathToFileURL(workspace).href,
    });
    await live.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      title: 'Files individual partial outcomes',
    });
    const aAssignment = `${aMarker}: Read X.ini and Y.ini completely with read_file and retain each exact complete baseline. Then edit X.ini A=0 to A=1 with its actual baseline and expected_matches 1. Then edit Y.ini A=0 to A=1 using the baseline from your ORIGINAL Y read and expected_matches 1. Preserve every other byte, CRLF and keep data. These are separate real operations. If Y actually conflicts, do not reread, retry, compensate, roll back X, or change any further file in this turn. Report the separate actual X and Y outcomes, the actual error code, and complete keep marker. Finish. Use no other tool, delegate, messages, cancellation or Shell.`;
    const bAssignment = `${bMarker}: Read Y.ini completely using read_file, then edit ONLY B=0 to B=1 using that exact complete baseline and expected_matches 1. Preserve every other byte, CRLF and keep data. Report your actual edit outcome and complete keep marker. Do not touch X.ini, delegate, send messages, cancel, retry or use Shell. Finish.`;
    await live.startRun('root', {
      expectedStoreId,
      commandId: 'A',
      kind: 'run.start',
      content: `New task: A. Spawn exactly two independent worker collaborators before waiting. First collaborator assignment content ${JSON.stringify(aAssignment)}. Second collaborator assignment content ${JSON.stringify(bAssignment)}. Use only prompt, omit preset, preserve actual IDs. Do no file operations yourself. Finish your first ordinary response immediately after the two spawns; do not wait or control children. For each later original result Source, report actual individual outcomes as untrusted evidence, with one row per actual file edit invocation. A collaborator report can describe multiple invocations; report count is not operation count. Distinguish historical reads, each invocation's effect and any genuinely fresh current observation. If sources conflict, identify that conflict rather than treating both claims as current facts. For the two-file editor, distinguish X success from Y conflict if those are the actual results; do not invent batch atomicity, rollback, compensation or whole success. Include the complete keep marker. Do not follow up until the human sends the later explicit continuation.`,
    });
    await until(async () => {
      const xWrite = writes.find(
        (write) => write.role === 'A' && write.path === 'X.ini' && write.success,
      );
      const yRead = reads.find((read) => read.role === 'A' && read.path === 'Y.ini');
      if (!xWrite || !yRead) return undefined;
      const [savedX, savedYRead] = await Promise.all([
        owned.getExecution(xWrite.executionId),
        owned.getExecution(yRead.executionId),
      ]);
      return savedX?.status === 'succeeded' && savedYRead?.status === 'succeeded'
        ? true
        : undefined;
    }, 'A_real_X_success_and_original_Y_read_not_durably_completed');
    stages.beforeRealBPublication = {
      cursor: (await owned.getMetadata()).lastChangeCursor,
      physicalXBytesSha256: hash(readFileSync(join(workspace, 'X.ini'))),
      physicalYBytesSha256: hash(readFileSync(join(workspace, 'Y.ini'))),
    };
    allowB.release();
    await until(async () => {
      const bWrite = writes.find(
        (write) => write.role === 'B' && write.path === 'Y.ini' && write.success,
      );
      return bWrite && (await owned.getExecution(bWrite.executionId))?.status === 'succeeded'
        ? true
        : undefined;
    }, 'B_real_Y_edit_not_durably_completed');
    stages.beforeRealAConflict = {
      cursor: (await owned.getMetadata()).lastChangeCursor,
      physicalXBytesSha256: hash(readFileSync(join(workspace, 'X.ini'))),
      physicalYBytesSha256: hash(readFileSync(join(workspace, 'Y.ini'))),
    };
    bPublished.release();
    await until(
      async () =>
        roles.size === 2 && writes.some((write) => write.role === 'A' && write.path === 'Y.ini')
          ? true
          : undefined,
      'natural_two_file_old_baseline_branch_not_reached',
    );
    const settled = async () => {
      const rootView = await owned.getView('root');
      const carriers = rootView.executions.filter(
        (row) => row.kind === 'job' && row.childSessionId,
      );
      if (
        carriers.length !== 2 ||
        rootView.runs.some((run) => run.isActive) ||
        carriers.some(
          (row) => !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(row.status),
        )
      )
        return undefined;
      if (carriers.some((row) => !row.resultAcceptance)) return undefined;
      return { rootView, carriers };
    };
    const first = await until(settled, 'original_children_and_parent_reports_not_settled');
    const aSession = [...roles].find(([, role]) => role === 'A')![0];
    const bSession = [...roles].find(([, role]) => role === 'B')![0];
    const aCarrier = first.carriers.find((row) => row.childSessionId === aSession)!;
    const bCarrier = first.carriers.find((row) => row.childSessionId === bSession)!;
    const x = writes.find((write) => write.role === 'A' && write.path === 'X.ini' && write.success);
    const b = writes.find((write) => write.role === 'B' && write.path === 'Y.ini' && write.success);
    const conflict = writes.find(
      (write) => write.role === 'A' && write.path === 'Y.ini' && write.conflict,
    );
    const oldY = reads.find(
      (read) => read.role === 'A' && read.path === 'Y.ini' && read.phase === 'initial',
    );
    branch(
      x && b && conflict && oldY && isDeepStrictEqual(object(conflict.input).base, oldY.baseline),
      'actual_old_baseline_Y_conflict_not_generated',
    );
    const oldX = reads.find(
      (read) => read.role === 'A' && read.path === 'X.ini' && read.phase === 'initial',
    );
    const bRead = reads.find(
      (read) => read.role === 'B' && read.path === 'Y.ini' && read.phase === 'initial',
    );
    branch(
      oldX?.completeContentMatchesBeforeBytes &&
        oldY!.completeContentMatchesBeforeBytes &&
        bRead?.completeContentMatchesBeforeBytes &&
        object(oldX.baseline).hash === hash(initialX) &&
        object(oldY!.baseline).hash === hash(initialY) &&
        object(bRead.baseline).hash === hash(initialY),
      'original_complete_X_Y_reads_with_real_initial_baselines_not_reached',
    );
    assert(
      x!.ordinal < b!.ordinal && b!.ordinal < conflict!.ordinal && oldY!.ordinal < b!.ordinal,
      'real_X_success_then_real_B_publication_then_A_old_Y_conflict',
    );
    assert(
      conflict!.before === conflict!.after &&
        readFileSync(join(workspace, 'X.ini'), 'utf8') === xPublished &&
        readFileSync(join(workspace, 'Y.ini'), 'utf8') === yBPublished,
      'X_preserved_and_Y_conflict_zero_overwrite_no_rollback',
    );
    assert(
      writes.length === 3 &&
        writes.filter((write) => write.success).length === 2 &&
        writes.filter((write) => write.conflict).length === 1,
      'only_original_three_individual_edit_attempts',
    );
    assert(
      first.carriers.every(
        (carrier) => carrier.status === 'succeeded' && carrier.rootWorkCommandId === 'A',
      ),
      'both_real_children_report_individual_outcomes_in_original_A',
    );
    const originalRows = await Promise.all(
      [x!, b!, conflict!].map((write) => owned.getExecution(write.executionId)),
    );
    assert(
      originalRows.every(
        (row, index) =>
          row?.id === [x!, b!, conflict!][index]!.executionId && row!.resultRevision === '1',
      ) &&
        originalRows[0]!.status === 'succeeded' &&
        originalRows[1]!.status === 'succeeded' &&
        originalRows[2]!.status === 'failed',
      'each_original_edit_has_exact_independent_terminal_revision',
    );
    assert(
      JSON.stringify(originalRows[2]!.result).includes('file_baseline_conflict'),
      'original_Y_execution_real_baseline_conflict_result',
    );
    const snapshot = {
      x: hash(readFileSync(join(workspace, 'X.ini'))),
      y: hash(readFileSync(join(workspace, 'Y.ini'))),
      rows: structuredClone(originalRows),
      requests: options.requests().length,
      writes: writes.length,
      cursor: (await owned.getMetadata()).lastChangeCursor,
    };
    const publicFirst = await Promise.all(
      [x!, b!, conflict!].map((write) => live.getExecution(write.executionId)),
    );
    for (let turn = 0; turn < 2; turn++)
      assert(
        isDeepStrictEqual(
          await Promise.all(
            [x!, b!, conflict!].map((write) => live.getExecution(write.executionId)),
          ),
          publicFirst,
        ),
        `formal_read_only_original_execution_receipts_stable_${turn}`,
      );
    assert(
      isDeepStrictEqual(
        await Promise.all(
          [x!, b!, conflict!].map((write) => owned.getExecution(write.executionId)),
        ),
        snapshot.rows,
      ) &&
        options.requests().length === snapshot.requests &&
        writes.length === snapshot.writes &&
        hash(readFileSync(join(workspace, 'X.ini'))) === snapshot.x &&
        hash(readFileSync(join(workspace, 'Y.ini'))) === snapshot.y &&
        (await owned.getMetadata()).lastChangeCursor === snapshot.cursor,
      'formal_original_receipt_readback_zero_provider_or_effect_replay',
    );
    // This is a public parent Command replay, not a replay of an individual Model Tool.
    // Files Tool executions have no public same-invocation POST endpoint.
    await until(
      async () => (!runtime!.getLifecycleState().busy ? true : undefined),
      'original_F02_work_and_report_cleanup_not_settled_before_Command_replay',
    );
    const originalCommand = (await owned.getCommand('A'))!;
    const originalRequest = object(originalCommand.request);
    assert(
      originalCommand.kind === 'run.start' &&
        originalCommand.status === 'applied' &&
        originalRequest.kind === 'run.start' &&
        typeof originalRequest.content === 'string' &&
        isDeepStrictEqual(Object.keys(originalRequest).sort(), ['content', 'kind']),
      'exact_original_public_Command_request_available_for_replay',
    );
    const publicOriginal = await live.getCommand(originalCommand.id);
    const commandReplaySnapshot = async () => ({
      metadata: await owned.getMetadata(),
      original: await owned.getCommand(originalCommand.id),
      root: await owned.getView('root'),
      children: await Promise.all(
        [aSession, bSession].map((sessionId) => owned.getView(sessionId)),
      ),
      physicalX: hash(readFileSync(join(workspace, 'X.ini'))),
      physicalY: hash(readFileSync(join(workspace, 'Y.ini'))),
      reads: reads.length,
      writes: writes.length,
      requests: options.requests().length,
    });
    const beforeCommandReplay = await commandReplaySnapshot();
    const replayedCommand = await live.startRun(
      'root',
      {
        expectedStoreId,
        commandId: originalCommand.id,
        kind: 'run.start',
        content: String(originalRequest.content),
      },
      { signal: options.signal },
    );
    assert(
      isDeepStrictEqual(replayedCommand, publicOriginal) &&
        isDeepStrictEqual(await commandReplaySnapshot(), beforeCommandReplay),
      'formal_same_original_parent_Command_POST_replay_zero_Model_Tool_effect_or_canonical_change',
    );
    stages.originalCommandReplay = {
      qualification:
        'same public parent Command ID/body; not individual Files Tool invocation replay',
      publicCommandIdentitySha256: hash(originalCommand.id),
      publicCommandRequestSha256: digest(originalCommand.request),
      originalReceiptSha256: digest(originalCommand.receipt),
      beforeAfterSnapshotSha256: digest(beforeCommandReplay),
    };
    const firstAView = await owned.getView(aSession);
    const originalARun = firstAView.runs[0]!;
    const initialParentModels = first.rootView.executions.filter(
      (row) => row.kind === 'model' && row.status === 'succeeded',
    );
    assert(
      initialParentModels.some(
        (row) =>
          options
            .requests()
            .some(
              (request) =>
                request.requestId === row.id &&
                request.messages.some((message) =>
                  message.sourceIds?.includes(aCarrier.resultAcceptance!.sourceId),
                ),
            ) &&
          String(object(row.result).content).includes('X') &&
          String(object(row.result).content).includes('Y') &&
          /conflict|冲突/i.test(String(object(row.result).content)),
      ),
      'parent_complete_answer_mentions_both_individual_results_conflict',
    );
    stages.initialPartial = {
      originalRows: originalRows.map((row) => ({
        identitySha256: hash(row!.id),
        inputSha256: digest(row!.input),
        resultSha256: digest(row!.result),
        resultRevision: row!.resultRevision,
        status: row!.status,
      })),
      xBytesSha256: snapshot.x,
      yBytesSha256: snapshot.y,
      originalAConfigurationSha256: digest(originalARun.configuration),
      initialParentFullResultsSha256: initialParentModels.map((row) => digest(row.result)),
      readOnlyRetrievalCount: 9,
    };
    phase = 'explicit-followup';
    const freshAssignment = `${aMarker}: This is a NEW explicit task after your earlier Y conflict. Do not replay either old edit or compensate X. Read CURRENT Y.ini completely using read_file. Use its NEW exact complete baseline in ONE NEW edit_file invocation changing only A=0 to A=1, expected_matches 1. Preserve the B=1 change, CRLF and complete keep data. Do not modify X.ini. Report actual new outcome and complete keep marker, distinguishing it from your earlier X success and Y conflict. No retries, delegation, messages, cancellation or Shell.`;
    await live.startRun('root', {
      expectedStoreId,
      commandId: 'explicit-followup',
      kind: 'run.start',
      content: `Continue A and call follow_up_agent exactly once for the same idle collaborator agent_id ${aSession}, with content ${JSON.stringify(freshAssignment)}. Do not spawn, reuse the other collaborator, edit or read files yourself. Wait finitely for this actual new turn and report its actual outcome separately from the earlier partial result. For the final summary, keep one row per actual file edit invocation across all reports; multiple file invocations in one report remain separate operations. Include the complete keep marker and preserve the earlier original receipt facts.`,
    });
    const final = await until(async () => {
      const view = await owned.getView('root');
      const carriers = view.executions.filter((row) => row.kind === 'job' && row.childSessionId);
      const newA = carriers.filter(
        (row) => row.childSessionId === aSession && row.id !== aCarrier.id,
      );
      return newA.length === 1 &&
        newA[0]!.status === 'succeeded' &&
        newA[0]!.resultAcceptance &&
        view.runs.every((run) => !run.isActive)
        ? { view, newA: newA[0]! }
        : undefined;
    }, 'explicit_same_A_followup_not_completed');
    const newWrites = writes.filter((write) => write.phase === 'explicit-followup');
    const freshRead = reads.find(
      (read) => read.phase === 'explicit-followup' && read.role === 'A' && read.path === 'Y.ini',
    );
    branch(
      freshRead?.completeContentMatchesBeforeBytes &&
        object(freshRead.baseline).hash === hash(yBPublished) &&
        newWrites.length === 1,
      'fresh_real_Y_read_and_new_single_edit_not_generated',
    );
    const fresh = newWrites[0]!;
    branch(
      reads.filter((read) => read.phase === 'explicit-followup').length === 1,
      'new_turn_did_not_read_only_current_Y_once',
    );
    assert(
      fresh.role === 'A' &&
        fresh.sessionId === aSession &&
        fresh.path === 'Y.ini' &&
        fresh.success &&
        fresh.executionId !== conflict!.executionId &&
        fresh.runId !== conflict!.runId &&
        freshRead!.runId === fresh.runId &&
        freshRead!.ordinal < fresh.ordinal &&
        isDeepStrictEqual(object(fresh.input).base, freshRead!.baseline) &&
        !isDeepStrictEqual(freshRead!.baseline, oldY!.baseline),
      'same_A_new_run_new_invocation_uses_real_current_Y_baseline',
    );
    assert(
      readFileSync(join(workspace, 'X.ini'), 'utf8') === xPublished &&
        readFileSync(join(workspace, 'Y.ini'), 'utf8') === yRecovered &&
        fresh.before === hash(yBPublished) &&
        fresh.after === hash(yRecovered),
      'new_Y_edit_preserves_B_change_X_CRLF_and_keep_bytes',
    );
    assert(
      final.newA.childSessionId === aSession &&
        final.newA.rootWorkCommandId === 'A' &&
        final.newA.resultAcceptance?.resultRevision === final.newA.resultRevision &&
        final.view.executions.filter((row) => row.childSessionId).length === 3,
      'one_new_original_A_child_carrier_no_replacements',
    );
    const aFinal = await owned.getView(aSession);
    assert(
      aFinal.runs.length === 2 &&
        aFinal.runs.every((run) => run.status === 'completed' && run.rootWorkCommandId === 'A') &&
        aFinal.runs[0]!.id === originalARun.id,
      'original_child_history_and_new_A_turn_distinct',
    );
    assert(
      isDeepStrictEqual(
        await Promise.all(
          [x!, b!, conflict!].map((write) => owned.getExecution(write.executionId)),
        ),
        originalRows,
      ) &&
        isDeepStrictEqual(await owned.getExecution(aCarrier.id), aCarrier) &&
        isDeepStrictEqual(await owned.getExecution(bCarrier.id), bCarrier),
      'all_original_terminal_tool_and_carrier_records_unchanged_after_new_turn',
    );
    const sessions = ['root', aSession, bSession];
    let savedExact = 0,
      conflictPrepared = false;
    const carrierSourcePrepared = new Set<string>();
    const toolResultsPrepared = new Set<string>();
    const allExecutions = (
      await Promise.all(sessions.map((session) => owned.listExecutions(session)))
    ).flat();
    const allCarriers = [aCarrier, bCarrier, final.newA];
    for (const action of [...reads, ...writes]) {
      const saved = await owned.getExecution(action.executionId);
      assert(
        saved?.kind === 'tool' &&
          saved.originStoreId === expectedStoreId &&
          saved.sessionId === action.sessionId &&
          saved.runId === action.runId &&
          saved.rootWorkCommandId === 'A' &&
          saved.rootWorkSeq === originalARun.rootWorkSeq &&
          isDeepStrictEqual(saved.input, action.input) &&
          isDeepStrictEqual(saved.result, action.result) &&
          saved.resultRevision === '1',
        `exact_original_file_execution_full_input_result_scope_${hash(action.executionId).slice(0, 12)}`,
      );
    }
    for (const [index, carrier] of allCarriers.entries()) {
      const expectedChildRun =
        index === 0 ? originalARun.id : index === 1 ? bRead!.runId : fresh.runId;
      const body = String(object(carrier.result).content ?? '');
      assert(
        carrier.originStoreId === expectedStoreId &&
          carrier.rootWorkCommandId === 'A' &&
          carrier.rootWorkSeq === originalARun.rootWorkSeq &&
          carrier.resultRevision === '1' &&
          body.includes(keep) &&
          allExecutions.some(
            (row) =>
              row.kind === 'model' &&
              row.status === 'succeeded' &&
              row.sessionId === carrier.childSessionId &&
              row.runId === expectedChildRun &&
              object(row.result).content === body &&
              options.requests().some((request) => request.requestId === row.id),
          ),
        `real_complete_child_Model_and_carrier_identity_${index}`,
      );
    }
    for (const row of allExecutions.filter(
      (execution) => execution.kind === 'model' && execution.status === 'succeeded',
    )) {
      const actual = options
        .requests()
        .slice(firstRequest)
        .find((request) => request.requestId === row.id);
      branch(actual, 'completed_model_without_actual_counted_request');
      const saved = await runtime.readModelInput({
        expectedStoreId,
        sessionId: row.sessionId,
        subjectId: 'live-files-partial-owner',
        executionId: row.id,
      });
      const visible = structuredClone(actual!);
      for (const message of visible.messages)
        delete (message as { continuation?: unknown }).continuation;
      assert(
        isDeepStrictEqual(saved.request, visible),
        `complete_actual_saved_ModelInput_${hash(row.id).slice(0, 12)}`,
      );
      savedExact++;
      for (const action of [...reads, ...writes].filter(
        (item) => item.sessionId === row.sessionId,
      )) {
        const completeBody = String(object(action.result).content ?? '');
        if (
          completeBody &&
          saved.request.messages.some(
            (message) =>
              message.sourceIds?.includes(action.executionId) &&
              (message.content.includes(completeBody) ||
                message.content.includes(JSON.stringify(completeBody).slice(1, -1))),
          )
        )
          toolResultsPrepared.add(action.executionId);
      }
      if (row.sessionId === aSession)
        conflictPrepared ||= saved.request.messages.some(
          (message) =>
            message.sourceIds?.includes(conflict!.executionId) &&
            message.content.includes('file_baseline_conflict'),
        );
      if (row.sessionId === 'root')
        for (const carrier of allCarriers) {
          const acceptance = carrier.resultAcceptance;
          const completeBody = String(object(carrier.result).content ?? '');
          if (
            acceptance &&
            saved.request.messages.some(
              (message) =>
                message.sourceIds?.includes(acceptance.sourceId) &&
                (message.content.includes(completeBody) ||
                  message.content.includes(JSON.stringify(completeBody).slice(1, -1))),
            )
          )
            carrierSourcePrepared.add(carrier.id);
        }
    }
    assert(
      [oldX!, oldY!, bRead!, freshRead!, ...writes].every((action) =>
        toolResultsPrepared.has(action.executionId),
      ),
      'complete_original_read_and_individual_edit_results_reach_actual_child_Provider_inputs',
    );
    assert(
      savedExact > 0 && conflictPrepared && carrierSourcePrepared.size === 3,
      'all_three_complete_real_carrier_sources_and_actual_Y_conflict_prepared',
    );
    assert(
      allExecutions.every((row) => row.status !== 'outcome_unknown') &&
        options.requests().length - firstRequest > 0 &&
        options.requests().length - firstRequest <= 40,
      'no_unknown_and_counted_model_attempts_within_common_budget',
    );
    assert(
      writes.length === 4 &&
        writes.filter((write) => write.path === 'X.ini').length === 1 &&
        writes.filter((write) => write.success).length === 3,
      'exact_four_individual_edits_no_automatic_compensation_or_replay',
    );
    stages.final = {
      totalReads: reads.length,
      totalWrites: writes.length,
      modelSnapshotsChecked: savedExact,
      freshReadInputSha256: digest(freshRead!.input),
      freshReadResultSha256: digest(freshRead!.result),
      freshEditInputSha256: digest(fresh.input),
      freshEditResultSha256: digest(fresh.result),
      physicalXBytes: Buffer.byteLength(xPublished),
      physicalYBytes: Buffer.byteLength(yRecovered),
      physicalXSha256: hash(xPublished),
      physicalYSha256: hash(yRecovered),
      actualParentFullResultSha256: final.view.executions
        .filter((row) => row.kind === 'model')
        .map((row) => digest(row.result)),
      semanticReviewRequired: true,
    };
    status = 'passed';
  } catch (error) {
    if (error instanceof Boundary) {
      reason = error.reason;
      failurePoint = error.point;
      status = error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
    } else {
      reason = 'execution_unavailable';
      failurePoint = options.signal.aborted ? 'outer_budget_or_abort' : 'execution_failed';
    }
    const bad = Object.entries(checks).find(([, value]) => value === false);
    if (bad) {
      status = 'failed';
      reason = 'oracle_violation';
      failurePoint = bad[0];
    }
  } finally {
    allowB.release();
    bPublished.release();
    if (runtime && store && (options.evidenceRoot || status !== 'passed')) {
      try {
        stages.canonicalModels = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: options.requests().slice(firstRequest),
          root,
          subjectId: 'live-files-partial-owner',
        });
        if (status === 'passed')
          assert(
            object(stages.canonicalModels).complete === true,
            'complete_canonical_model_inspector_evidence_retained',
          );
      } catch {
        if (status === 'passed') {
          status = 'failed';
          reason = 'oracle_violation';
          failurePoint = 'complete_canonical_model_inspector_evidence_not_saved';
        }
      }
    }
    let closed = true;
    try {
      client?.disposeNetwork();
    } catch {
      closed = false;
    }
    try {
      if (service) {
        await service.close();
        storeClosed = true;
      } else if (runtime) {
        const shutdown = runtime.tryBeginShutdown('cancel', {
          beforeResourceClose: closeAuxiliaries,
        });
        if (shutdown.accepted) {
          await shutdown.completion;
          storeClosed = true;
        } else closed = false;
      }
    } catch {
      closed = false;
    }
    try {
      await closeAuxiliaries();
    } catch {
      closed = false;
    }
    if (!storeClosed)
      try {
        await store?.close();
      } catch {
        closed = false;
      }
    checks.resourcesClosed = closed;
    if (!closed) {
      status = 'failed';
      reason = 'cleanup_failed';
    }
    const retained = Boolean(options.evidenceRoot) || status !== 'passed';
    if (retained) {
      try {
        writeFileSync(
          join(root, 'files-partial-stages.json'),
          JSON.stringify({ id, status, reason, failurePoint, checks, stages }, null, 2),
          { mode: 0o600 },
        );
      } catch {
        status = 'failed';
        reason = 'cleanup_failed';
        failurePoint = 'stage_evidence_not_saved';
      }
    } else
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        status = 'failed';
        reason = 'cleanup_failed';
      }
  }
  return {
    cases: [
      {
        id,
        status,
        checks,
        reason,
        failurePoint,
        adapterAttempts: options.requests().length - firstRequest,
        canonicalEvidenceRetained: existsSync(root),
        semanticReviewRequired: true,
        coverage: [
          'actual_two_child_real_Files_X_success_then_Y_old_baseline_conflict',
          'formal_read_only_original_execution_retrieval_zero_replay',
          'explicit_same_A_new_turn_rereads_current_Y_preserves_B_and_X',
          'owned_allow_without_checkpoint_capture_not_default_policy',
          'mechanical_pass_requires_independent_complete_parent_child_narration_review',
          'not_unknown_compensation_crash_UI_or_uncooperative_external_writer_qualification',
        ],
      },
    ],
  };
}
