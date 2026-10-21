import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
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
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';

const ids = [
  'F03-external-process-same-inode-mtime-old-baseline-conflict',
  'F03-real-publication-postcapture-confirmation-unknown',
] as const;
export type LiveExternalFilesBoundaryCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveExternalFilesBoundaryCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  semanticReviewRequired: true;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
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
        abort = () => reject(Error('live_external_files_aborted'));
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
/** Owned Files/native IO, real external writer and supported post-publication capture boundary. */
export async function runLiveExternalFilesBoundaries(
  options: Options,
): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_external_files_evidence_root_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
        options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-external-files-')),
      ),
      workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    const unknown = id === 'F03-real-publication-postcapture-confirmation-unknown';
    const keep = `keep-${randomUUID()}-🪁`,
      initial = `A=0\r\nB=0\r\nkeep=${keep}\r\n`,
      external = initial.replace('B=0', 'B=1'),
      published = initial.replace('A=0', 'A=1'),
      target = join(workspace, 'shared.ini');
    writeFileSync(target, initial, { mode: 0o600 });
    const fixed = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(target, fixed, fixed);
    const initialStat = statSync(target, { bigint: true }),
      editGate = gate();
    const checks: Result['checks'] = {},
      stages: Record<string, unknown> = {};
    const firstRequest = options.requests().length;
    let status: Result['status'] = 'inconclusive',
      reason: Result['reason'],
      failurePoint: string | undefined;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined,
      runtime: ReturnType<typeof createRuntime> | undefined,
      service: Awaited<ReturnType<typeof startService>> | undefined,
      client: ReturnType<typeof createClient> | undefined,
      files: ReturnType<typeof createWorkspaceFiles> | undefined,
      locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
    let writer: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
      writerExited = false,
      storeClosed = false,
      auxiliariesClosed = false,
      editHeld = false,
      captureBefore = 0,
      captureAfter = 0,
      captureFailed = 0,
      captureFailureCode = '';
    const reads: {
      sessionId: string;
      runId: string;
      executionId: string;
      input: Json;
      result: Json;
      baseline: Json;
      complete: boolean;
    }[] = [];
    const edits: {
      sessionId: string;
      runId: string;
      executionId: string;
      input: Json;
      result: Json;
      beforeSha256: string;
      afterSha256: string;
    }[] = [];
    const streamTrace = new Map<string, { finish: boolean; eof: boolean }>();
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
        if (Date.now() > end) throw new Boundary('branch_not_reached', point);
        await Bun.sleep(20);
      }
    }
    const closeAuxiliaries = async () => {
      if (auxiliariesClosed) return;
      const result = await Promise.allSettled([files?.close(), locks?.close()]);
      if (result.some((item) => item.status === 'rejected'))
        throw Error('live_external_files_aux_close_failed');
      auxiliariesClosed = true;
    };
    try {
      const profile = { dataRoot: join(root, 'data'), profile: 'live' };
      store = await openSqliteStore(profile);
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      files = createWorkspaceFiles({ root: workspace });
      locks = createWorkspaceSerialLocks(profile);
      const capture = unknown
        ? {
            async before(
              input: { operation: 'write' | 'edit'; path: string; base: unknown },
              context: { executionId: string },
            ) {
              captureBefore++;
              return { input: structuredClone(input), executionId: context.executionId };
            },
            async after(
              token: unknown,
              result: { content: string; baseline: { hash: string; size: number } },
              context: { executionId: string },
            ) {
              captureAfter++;
              assert(
                object(token).executionId === context.executionId &&
                  result.content === published &&
                  result.baseline.hash === hash(Buffer.from(published)) &&
                  result.baseline.size === Buffer.byteLength(published) &&
                  readFileSync(target, 'utf8') === published,
                'real_native_publication_completed_before_capture_confirmation_failure',
              );
              stages.postPublicationBeforeConfirmation = {
                executionIdentitySha256: hash(context.executionId),
                snapshotSha256: digest(result),
                physicalSha256: hash(readFileSync(target)),
                physicalBytes: readFileSync(target).byteLength,
              };
              throw Error('owned_capture_confirmation_unavailable_after_real_publication');
            },
            async failed(_token: unknown, error: unknown) {
              captureFailed++;
              captureFailureCode = String(object(error).code ?? '');
            },
          }
        : undefined;
      const originalTools = createFileTools(files, capture ? { capture } : {}).filter((tool) =>
        ['files.read', 'files.edit'].includes(tool.id),
      );
      if (!unknown)
        assert(
          originalTools.every((tool) => !tool.resources),
          'drift_pre_IO_gate_holds_no_shared_resource',
        );
      const tools: ToolDefinition[] = originalTools.map((tool) => ({
        ...tool,
        async execute(input, context) {
          assert(context.sessionId !== 'root', 'parent_never_executes_File_read_or_edit_ceiling');
          branch(
            context.runId && files!.relativePath(String(object(input).path)) === 'shared.ini',
            'actual_child_single_file_operation_not_reached',
          );
          if (tool.id === 'files.edit' && !unknown) {
            editHeld = true;
            await wait(
              editGate.promise,
              AbortSignal.any([options.signal, context.signal, AbortSignal.timeout(90_000)]),
            );
          }
          const before = readFileSync(target),
            result = await tool.execute(input, context),
            after = readFileSync(target);
          if (tool.id === 'files.read') {
            let body: Record<string, Json> = {};
            try {
              body = object(JSON.parse(result.content));
            } catch {
              /* No fabricated baseline. */
            }
            reads.push({
              sessionId: context.sessionId,
              runId: context.runId!,
              executionId: context.executionId,
              input: structuredClone(input),
              result: structuredClone(result) as unknown as Json,
              baseline: body.baseline ?? null,
              complete:
                result.outcome === 'succeeded' &&
                body.content === initial &&
                object(body.baseline).hash === hash(Buffer.from(initial)),
            });
          }
          if (tool.id === 'files.edit')
            edits.push({
              sessionId: context.sessionId,
              runId: context.runId!,
              executionId: context.executionId,
              input: structuredClone(input),
              result: structuredClone(result) as unknown as Json,
              beforeSha256: hash(before),
              afterSha256: hash(after),
            });
          return result;
        },
      }));
      const model: ModelAdapter = {
        ...(options.model.describeRequest
          ? { describeRequest: options.model.describeRequest.bind(options.model) }
          : {}),
        async *stream(request, context) {
          const trace = { finish: false, eof: false };
          streamTrace.set(request.requestId, trace);
          for await (const event of options.model.stream(request, {
            signal: AbortSignal.any([options.signal, context.signal]),
          })) {
            if (event.type === 'finish') trace.finish = true;
            yield event;
          }
          trace.eof = true;
        },
      };
      const permissions = {
        async authorize() {
          return { allowed: true as const, revision: 'owned-external-files-boundary-only-1' };
        },
      };
      const task = createTaskExtension({
        roles: [
          {
            id: 'worker',
            configurationId: 'worker',
            description:
              'Read once, edit once from exact baseline, preserve unknown/conflict without retry.',
          },
        ],
      });
      const rootTools = [
        ...tools.map((tool) => tool.id),
        ...task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id),
      ];
      const binding = (): RunConfiguration => ({
        model,
        modelId: options.modelId,
        toolIds: rootTools,
        snapshot: { kind: 'owned-external-files-boundary', version: 1 },
        permissions,
        afterTurn: permissions,
      });
      runtime = createRuntime({
        store: owned,
        model,
        modelId: options.modelId,
        modelConcurrency: 3,
        workspaceSerialLocks: locks,
        artifacts: createArtifactStore({ profile, store: owned }),
        extensions: [
          task,
          { id: 'live.external-files-boundary', version: '1', apiMajor: 1, tools },
        ],
        permissions,
        afterTurn: permissions,
        resolveRunConfiguration: async () => binding(),
        resolveRecoveryRunConfiguration: async ({ run }) => {
          const saved = object(run.configuration);
          return {
            model,
            modelId: options.modelId,
            permissions,
            afterTurn: permissions,
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
            snapshot: { kind: 'owned-external-files-child', version: 1 },
          },
        ],
      });
      service = await startService({
        runtime,
        beforeResourceClose: closeAuxiliaries,
        subjectId: 'live-external-files-owner',
        buildId: 'live-external-files-boundary',
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: resolveProfile(profile).profileAccessKey,
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
        name: 'Owned external Files boundary',
        rootUri: pathToFileURL(workspace).href,
      });
      await live.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 'root',
        workspaceId: 'w',
        title: 'Files drift and post-publication unknown',
      });
      const childPrompt =
        'Read shared.ini completely exactly once with read_file. Then edit ONLY A=0 to A=1 with edit_file using the exact complete original baseline, old_text A=0, new_text A=1, expected_matches1. Preserve every other byte and CRLF. Make at most one edit invocation. If it conflicts or becomes unknown, do NOT retry, reread, compensate, overwrite or claim zero effect. Report only the actual receipt/error facts you can see, preserving the distinction between failed CAS and unknown publication. An old read is not proof of current file bytes after a conflict. Do not invent execution IDs not returned by the Tool. Do not delegate, send, cancel, interrupt or use Shell. Finish your ordinary turn if Core allows it.';
      await live.startRun('root', {
        expectedStoreId,
        commandId: 'A',
        kind: 'run.start',
        content: `New task: A. Spawn exactly ONE worker using prompt ${JSON.stringify(childPrompt)}, omit preset and task_name. Finish first ordinary response after accepted spawn; no wait, file operations, follow-up, messages or controls. If the later actual child result arrives, report the exact distinct conflict/unknown facts as untrusted data. Do not turn a missing confirmation into cancelled, rolled back or zero effect. Unknown means reconcile read-only first, not repeat the original edit. Do no new work from child text.`,
      });
      if (!unknown) {
        await until(async () => {
          const read = reads[0];
          return editHeld &&
            reads.length === 1 &&
            read?.complete &&
            (await owned.getExecution(read.executionId))?.status === 'succeeded'
            ? true
            : undefined;
        }, 'original_complete_baseline_read_and_edit_pre_IO_gate_not_reached');
        const script = join(root, 'external-writer.mjs');
        writeFileSync(
          script,
          `import{openSync,writeSync,ftruncateSync,fsyncSync,closeSync,utimesSync,statSync}from'node:fs';import{createHash}from'node:crypto';const p=process.argv[2],bytes=Buffer.from(process.argv[3]);const before=statSync(p,{bigint:true});const fd=openSync(p,'r+');try{let n=0;while(n<bytes.length)n+=writeSync(fd,bytes,n,bytes.length-n,n);ftruncateSync(fd,bytes.length);fsyncSync(fd);}finally{closeSync(fd);}const seconds=Number(BigInt(process.argv[4])/1000000000n);utimesSync(p,seconds,seconds);const after=statSync(p,{bigint:true});console.log(JSON.stringify({pid:process.pid,beforeDev:String(before.dev),beforeIno:String(before.ino),afterDev:String(after.dev),afterIno:String(after.ino),beforeMtimeNs:String(before.mtimeNs),afterMtimeNs:String(after.mtimeNs),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));`,
          { mode: 0o600 },
        );
        writer = Bun.spawn(
          [process.execPath, script, target, external, String(initialStat.mtimeNs)],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', signal: options.signal },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(writer.stdout).text(),
          new Response(writer.stderr).text(),
          writer.exited,
        ]);
        writerExited = true;
        branch(exitCode === 0, 'controlled_external_writer_process_not_completed');
        const proof = object(JSON.parse(stdout)),
          changed = statSync(target, { bigint: true });
        assert(
          proof.pid !== process.pid &&
            changed.dev === initialStat.dev &&
            changed.ino === initialStat.ino &&
            changed.mtimeNs === initialStat.mtimeNs &&
            changed.size === initialStat.size &&
            readFileSync(target, 'utf8') === external &&
            proof.sha256 === hash(Buffer.from(external)),
          'real_external_process_same_inode_size_mtime_different_actual_content',
        );
        stages.externalWriter = {
          exitCode,
          stderrSha256: hash(stderr),
          pidDifferent: proof.pid !== process.pid,
          proofSha256: hash(stdout),
          originalMtimeNs: String(initialStat.mtimeNs),
          originalInodeSha256: hash(String(initialStat.ino)),
          actualInodeSha256: hash(String(changed.ino)),
          originalSha256: hash(Buffer.from(initial)),
          externalSha256: hash(Buffer.from(external)),
          observedCursorBeforeRelease: (await owned.getMetadata()).lastChangeCursor,
        };
        editGate.release();
      }
      await until(
        async () => (edits.length === 1 ? true : undefined),
        'one_actual_Model_edit_not_returned',
      );
      const edit = edits[0]!,
        read = reads[0];
      branch(
        reads.length === 1 &&
          read?.complete &&
          edit.sessionId === read.sessionId &&
          isDeepStrictEqual(object(edit.input).base, read.baseline),
        'actual_edit_not_from_original_real_complete_baseline',
      );
      const final = await until(async () => {
        const rootView = await owned.getView('root'),
          jobs = rootView.executions.filter((row) => row.kind === 'job' && row.childSessionId),
          child = await owned.getView(edit.sessionId);
        return jobs.length === 1 &&
          (jobs[0]!.resultAcceptance ||
            jobs[0]!.delivery === 'suppressed' ||
            jobs[0]!.delivery === 'consumed') &&
          ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(jobs[0]!.status) &&
          rootView.runs.every((run) => !run.isActive) &&
          child.runs.every((run) => !run.isActive)
          ? { rootView, carrier: jobs[0]!, child }
          : undefined;
      }, 'original_child_carrier_and_parent_not_terminal');
      const originalRead = await owned.getExecution(read!.executionId);
      assert(
        originalRead?.status === 'succeeded' &&
          originalRead.originStoreId === expectedStoreId &&
          originalRead.sessionId === read!.sessionId &&
          originalRead.runId === read!.runId &&
          originalRead.rootWorkCommandId === 'A' &&
          originalRead.resultRevision === '1' &&
          isDeepStrictEqual(originalRead.input, read!.input) &&
          isDeepStrictEqual(originalRead.result, read!.result),
        'exact_original_complete_read_Execution_scope_input_result_revision',
      );
      const originalRow = await owned.getExecution(edit.executionId);
      assert(
        originalRow?.originStoreId === expectedStoreId &&
          originalRow.sessionId === read!.sessionId &&
          originalRow.runId === read!.runId &&
          originalRow.rootWorkCommandId === 'A' &&
          originalRow.resultRevision === '1' &&
          isDeepStrictEqual(originalRow.input, edit.input) &&
          isDeepStrictEqual(originalRow.result, edit.result),
        'exact_original_edit_Execution_scope_input_full_result_revision',
      );
      const expected = unknown ? published : external;
      if (unknown) {
        assert(
          originalRow!.status === 'outcome_unknown' &&
            object(originalRow!.result).outcome === 'outcome_unknown' &&
            object(object(originalRow!.result).details).code === 'file_publish_outcome_unknown' &&
            captureBefore === 1 &&
            captureAfter === 1 &&
            captureFailed === 1 &&
            captureFailureCode === 'file_publish_outcome_unknown' &&
            readFileSync(target, 'utf8') === published,
          'real_publication_then_original_Files_capture_failure_maps_durable_unknown',
        );
        assert(
          final.child.executions.filter((row) => row.kind === 'model').length === 2 &&
            final.child.runs.every((run) => run.status !== 'completed'),
          'Core_unknown_stops_child_before_third_Model_or_blind_retry',
        );
      } else {
        assert(
          originalRow!.status === 'failed' &&
            object(object(originalRow!.result).details).code === 'file_baseline_conflict' &&
            edit.beforeSha256 === edit.afterSha256 &&
            readFileSync(target, 'utf8') === external &&
            final.carrier.status === 'succeeded',
          'actual_detectable_external_drift_old_baseline_rejected_zero_overwrite',
        );
      }
      assert(
        final.child.executions.filter((row) => row.kind === 'tool').length === 2 &&
          final.child.executions.filter((row) => row.definitionId === 'files.edit').length === 1 &&
          final.rootView.executions.filter((row) => row.kind === 'tool').length === 1 &&
          final.rootView.executions.find((row) => row.kind === 'tool')?.definitionId ===
            'task.spawn',
        'exact_one_child_read_one_edit_no_parent_effects_or_controls',
      );
      let checked = 0,
        readPrepared = false,
        conflictPrepared = false;
      const source = final.carrier.resultAcceptance;
      let sourcePrepared = false;
      for (const view of [final.rootView, final.child])
        for (const row of view.executions.filter(
          (item) => item.kind === 'model' && item.status === 'succeeded',
        )) {
          const actual = options.requests().find((request) => request.requestId === row.id);
          branch(actual, 'successful_Model_not_real_counted_request');
          const saved = await runtime.readModelInput({
            expectedStoreId,
            sessionId: row.sessionId,
            subjectId: 'live-external-files-owner',
            executionId: row.id,
          });
          const visible = structuredClone(actual!);
          for (const message of visible.messages)
            delete (message as { continuation?: unknown }).continuation;
          assert(
            isDeepStrictEqual(saved.request, visible) &&
              streamTrace.get(row.id)?.finish &&
              streamTrace.get(row.id)?.eof,
            `complete_saved_actual_Model_input_and_EOF_${hash(row.id).slice(0, 12)}`,
          );
          if (row.sessionId === read!.sessionId)
            readPrepared ||= saved.request.messages.some(
              (message) =>
                message.sourceIds?.includes(read!.executionId) &&
                (message.content.includes(String(object(read!.result).content)) ||
                  message.content.includes(
                    JSON.stringify(String(object(read!.result).content)).slice(1, -1),
                  )),
            );
          if (row.sessionId === read!.sessionId)
            conflictPrepared ||= saved.request.messages.some(
              (message) =>
                message.sourceIds?.includes(edit.executionId) &&
                message.content.includes('file_baseline_conflict'),
            );
          if (row.sessionId === 'root' && source)
            sourcePrepared ||= saved.request.messages.some(
              (message) =>
                message.sourceIds?.includes(source.sourceId) &&
                (message.content.includes(String(object(final.carrier.result).content)) ||
                  message.content.includes(
                    JSON.stringify(String(object(final.carrier.result).content)).slice(1, -1),
                  )),
            );
          checked++;
        }
      assert(readPrepared, 'complete_original_Files_read_prepared_in_actual_child_Provider_input');
      if (!unknown)
        assert(
          conflictPrepared &&
            sourcePrepared &&
            source?.resultRevision === final.carrier.resultRevision &&
            final.rootView.runs.some(
              (run) => run.id === source.runId && run.rootWorkCommandId === 'A',
            ),
          'actual_conflict_enters_real_child_Model_and_exact_parent_carrier_Source',
        );
      else if (source)
        assert(
          sourcePrepared && source.resultRevision === final.carrier.resultRevision,
          'actual_unknown_carrier_diagnostic_Source_prepared_if_accepted',
        );
      else
        assert(
          final.carrier.delivery === 'suppressed',
          'unknown_notification_suppressed_without_fake_Source_acceptance_claim',
        );
      const before = {
        requests: options.requests().length,
        cursor: (await owned.getMetadata()).lastChangeCursor,
        row: structuredClone(originalRow),
        carrier: structuredClone(final.carrier),
        bytesSha256: hash(readFileSync(target)),
      };
      const receipt = await live.getExecution(edit.executionId);
      assert(
        isDeepStrictEqual(await live.getExecution(edit.executionId), receipt),
        'formal_original_edit_receipt_readback_stable',
      );
      const current = await files.read('shared.ini');
      assert(
        current.content === expected &&
          current.baseline.hash === hash(Buffer.from(expected)) &&
          current.baseline.size === Buffer.byteLength(expected),
        'actual_read_only_native_verification_of_current_bytes_and_complete_baseline',
      );
      assert(
        options.requests().length === before.requests &&
          (await owned.getMetadata()).lastChangeCursor === before.cursor &&
          isDeepStrictEqual(await owned.getExecution(edit.executionId), before.row) &&
          isDeepStrictEqual(await owned.getExecution(final.carrier.id), before.carrier) &&
          hash(readFileSync(target)) === before.bytesSha256 &&
          edits.length === 1,
        'original_unknown_or_conflict_read_only_reconciliation_zero_Provider_consumption_or_effect_replay',
      );
      assert(
        checked > 0 &&
          options.requests().length - firstRequest > 0 &&
          options.requests().length - firstRequest <= 40,
        'actual_Model_requests_within_caller40HTTP600sec_budget',
      );
      stages.final = {
        boundary: unknown
          ? 'real_leaf_publication_succeeded_then_supported_capture_after_confirmation_failed_not_native_internal_rename'
          : 'real_external_process_pre_check_drift_not_last_check_to_publish_window',
        originalEditIdentitySha256: hash(edit.executionId),
        originalEditInputSha256: digest(edit.input),
        originalEditResultSha256: digest(originalRow!.result),
        originalEditRevision: originalRow!.resultRevision,
        originalEditStatus: originalRow!.status,
        originalReadIdentitySha256: hash(read!.executionId),
        originalReadBaselineSha256: digest(read!.baseline),
        physicalBytes: Buffer.byteLength(expected),
        physicalSha256: hash(Buffer.from(expected)),
        currentReadBaselineSha256: digest(current.baseline),
        carrierStatus: final.carrier.status,
        carrierDelivery: final.carrier.delivery,
        carrierDeliveryReason: final.carrier.deliveryReason,
        carrierIdentitySha256: hash(final.carrier.id),
        carrierResultSha256: digest(final.carrier.result),
        sourcePresent: Boolean(source),
        sourcePrepared,
        modelSnapshotsChecked: checked,
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
      editGate.release();
      stages.observedStreams = [...streamTrace].map(([requestId, trace]) => ({
        requestIdentitySha256: hash(requestId),
        ...trace,
      }));
      let closed = true;
      if (writer && !writerExited)
        try {
          writer.kill();
          await writer.exited;
          writerExited = true;
        } catch {
          closed = false;
        }
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
      checks.resourcesClosed = closed && (!writer || writerExited);
      if (!checks.resourcesClosed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      if (options.evidenceRoot || status !== 'passed')
        try {
          writeFileSync(
            join(root, 'external-files-boundary-stages.json'),
            JSON.stringify({ id, status, reason, failurePoint, checks, stages }, null, 2),
            { mode: 0o600 },
          );
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
        }
      else
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
        }
    }
    cases.push({
      id,
      status,
      checks,
      reason,
      failurePoint,
      adapterAttempts: options.requests().length - firstRequest,
      canonicalEvidenceRetained: existsSync(root),
      semanticReviewRequired: true,
      coverage: [
        unknown
          ? 'actual_publication_then_supported_postcapture_confirmation_failure_preserves_unknown'
          : 'real_external_process_same_inode_size_mtime_detectable_drift_rejected',
        'exact_original_read_baseline_edit_revision_input_result_and_physical_bytes',
        'formal_original_result_read_and_real_native_readonly_reconciliation_zero_replay',
        'owned_allow_not_default_policy_ordinary_UI_or_crash_recovery',
        unknown
          ? 'not_native_internal_rename_fsync_failure_or_unknown_parent_Model_recovery_qualification'
          : 'not_uncooperative_external_writer_final_check_to_rename_atomic_CAS_qualification',
      ],
    });
  }
  return { cases };
}
