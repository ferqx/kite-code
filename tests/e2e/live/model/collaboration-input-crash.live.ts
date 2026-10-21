import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { agentContractSource } from '@kite-ai/agent/sources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { SqliteOperations } from '../../../../packages/agent/src/storage/sqlite/operations';
import { runCrashFixture } from '../../../../packages/agent/test/isolated/recovery/human-input-processing-crash-fixture';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture } from './live-model-fixture';
import { bounded, firstOwnedLine, killOwnedStage, spawnOwnedStage } from './live-owned-process';

export const C04_DECISION_CASE =
  'C04-real-SIGKILL-committed-input-decision-before-queued-business' as const;
export const C04_MODEL_CASE = 'C04-real-SIGKILL-successful-input-Model-before-decision' as const;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function assert(value: unknown, code: string): asserts value {
  if (!value) throw Error(`c04_${code}`);
}
function save(path: string, value: unknown) {
  const temporary = `${path}.pending-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
type Store = Awaited<ReturnType<typeof openSqliteStore>>;
interface Control {
  root: string;
  deadline: number;
  requestLimit: number;
  window?: 'model' | 'decision';
}
const permissions = {
  authorize: async () => ({ allowed: true as const, revision: 'owned-C04-no-business-tools-v1' }),
};
function commandRows(root: string) {
  const db = new Database(join(root, 'data/test/core.db'), { readonly: true, strict: true });
  try {
    const ops = new SqliteOperations(db, true);
    return ops.rows('SELECT * FROM command ORDER BY seq,id').map((row) => ops.command(row));
  } finally {
    db.close();
  }
}
async function facts(store: Store, root: string, ids: Record<string, unknown>) {
  const raw = await store.getCommand(String(ids.rawId));
  const rawReceipt = object(raw?.receipt);
  return {
    metadata: await store.getMetadata(),
    view: await store.getView('s'),
    session: await store.getSession('s'),
    raw,
    processing: await store.getCommand(String(ids.processingId)),
    public: await store.getCommand('input'),
    decision: rawReceipt.decisionCommandId
      ? await store.getCommand(String(rawReceipt.decisionCommandId))
      : null,
    business: rawReceipt.businessCommandId
      ? await store.getCommand(String(rawReceipt.businessCommandId))
      : null,
    commands: commandRows(root),
    ledger: readFileSync(join(root, 'ledger'), 'utf8'),
  };
}
function assertCommittedDecision(
  before: Awaited<ReturnType<typeof facts>>,
  ids: Record<string, unknown>,
) {
  const raw = before.raw!,
    decision = before.decision!,
    business = before.business!;
  const receipt = object(raw?.receipt),
    decisionRequest = object(decision?.request),
    proposal = object(decisionRequest.proposal);
  const models = before.view.executions.filter(
    (row) => row.kind === 'model' && row.runId === ids.runId && row.status === 'succeeded',
  );
  // A genuine read-only progress decision is valid, but misses this queued-work window.
  if (
    raw?.status === 'applied' &&
    receipt.state === 'decided' &&
    receipt.applicationState === 'observed' &&
    receipt.businessCommandId === null &&
    before.business === null &&
    decision?.kind === 'human.input.decision' &&
    decision.status === 'applied' &&
    decision.id === receipt.decisionCommandId &&
    decisionRequest.inputCommandId === raw.id &&
    decisionRequest.inputDigest === raw.requestDigest &&
    models.length === 1 &&
    object(decisionRequest.interpretation).executionId === models[0]!.id &&
    proposal.relation === 'same_work' &&
    proposal.purpose === 'progress' &&
    proposal.targetRootWorkCommandId === 'A' &&
    proposal.selectionEffect === 'keep' &&
    before.commands.filter((command) => command.kind === 'human.input.decision').length === 1 &&
    object(before.public?.receipt).outcome === 'human_input_observed'
  ) {
    throw Error(
      'branch_not_reached_natural_interpretation_progress_observation_no_queued_business',
    );
  }
  assert(
    raw?.status === 'applied' &&
      receipt.state === 'decided' &&
      receipt.applicationState === 'queued' &&
      receipt.runId === undefined &&
      decision?.kind === 'human.input.decision' &&
      decision.status === 'applied' &&
      decision.id === receipt.decisionCommandId &&
      decisionRequest.inputCommandId === raw.id &&
      decisionRequest.inputDigest === raw.requestDigest &&
      models.length === 1 &&
      object(decisionRequest.interpretation).executionId === models[0]!.id &&
      proposal.relation === 'same_work' &&
      proposal.purpose === 'work' &&
      proposal.targetRootWorkCommandId === 'A' &&
      business?.id === receipt.businessCommandId &&
      business.kind === 'input.follow_up' &&
      business.status === 'accepted' &&
      business.rootWorkCommandId === 'A' &&
      object(business.receipt).outcome === 'human_business_queued' &&
      object(business.receipt).runId === null &&
      object(business.receipt).decisionCommandId === decision.id &&
      object(business.receipt).inputCommandId === raw.id &&
      before.commands.filter((command) => command.kind === 'human.input.decision').length === 1 &&
      !before.view.runs.some((run) => run.originCommandId === business.id),
    'original_committed_decision_exact_raw_successful_Model_and_queued_business_no_Run',
  );
}
function assertCommittedApplication(
  before: Awaited<ReturnType<typeof facts>>,
  after: Awaited<ReturnType<typeof facts>>,
) {
  const applied = object(after.business?.receipt);
  assert(
    isDeepStrictEqual(before.decision, after.decision),
    'committed_original_decision_whole_record_immutable',
  );
  assert(
    before.business &&
      after.business &&
      after.business.status === 'applied' &&
      isDeepStrictEqual(
        { ...before.business, status: after.business.status, receipt: after.business.receipt },
        after.business,
      ) &&
      applied.outcome === 'input_applied' &&
      applied.humanInputCommandId === before.raw!.id &&
      applied.decisionCommandId === before.decision!.id &&
      typeof applied.runId === 'string' &&
      typeof applied.messageId === 'string',
    'same_original_queued_business_identity_request_digest_exact_once_applied',
  );
  assert(
    isDeepStrictEqual(
      {
        ...before.raw,
        receipt: {
          ...object(before.raw!.receipt),
          applicationState: 'applied',
          runId: applied.runId,
          messageId: applied.messageId,
        },
      },
      after.raw,
    ),
    'decided_raw_all_fields_immutable_except_exact_original_business_application_receipt',
  );
}
function stableInspector(value: unknown) {
  const copy = structuredClone(object(value));
  delete copy.snapshotCursor;
  return copy;
}
async function phase(name: 'hot' | 'cold' | 'resume', root: string) {
  const control = read(join(root, 'control.json')) as unknown as Control;
  assert(control.root === root && Date.now() < control.deadline, 'owned_root_and_global_deadline');
  const window = control.window ?? 'model';
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let store: Store | undefined;
  if (name === 'cold') {
    // This process has no configured Model port, live fixture factory, credential resolution, or recovery call.
    store = await openSqliteStore({ ...profile, mode: 'readonly' });
    try {
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        permissions,
      });
      const ids = read(join(root, 'boundary.json'));
      const before = await facts(store, root, ids);
      save(join(root, 'cold-before.json'), before);
      assert(
        before.metadata.storeId === ids.storeId &&
          before.session?.ownerGeneration === ids.generation,
        'same_original_Store_and_generation',
      );
      if (window === 'decision') assertCommittedDecision(before, ids);
      else
        assert(
          object(before.raw?.receipt).state === 'pending' && !before.decision && !before.business,
          'raw_pending_no_durable_decision_or_business',
        );
      assert(
        object(before.raw?.receipt).processingCommandId === ids.processingId,
        'raw_original_processing_binding',
      );
      const processingRun = before.view.runs.find((run) => run.id === ids.runId);
      assert(
        processingRun?.isActive && processingRun.originCommandId === ids.processingId,
        'original_processing_Run_still_active_after_SIGKILL',
      );
      const interpretations = before.view.executions.filter(
        (row) => row.kind === 'model' && row.runId === ids.runId && row.status === 'succeeded',
      );
      assert(
        interpretations.length === 1 && interpretations[0]!.status === 'succeeded',
        'exactly_one_original_successful_interpretation_Model',
      );
      if (window === 'model')
        assert(
          !before.commands.some((command) => command.kind === 'human.input.decision'),
          'zero_decision_rows_before_commit_window',
        );
      const hot = read(join(root, 'hot-provider.json'));
      const actualRequests = hot.requests as ModelRequest[];
      const outputs = [],
        inputs = [];
      for (const request of actualRequests) {
        const execution = await store.getExecution(request.requestId);
        assert(
          execution?.kind === 'model' &&
            ['succeeded', 'failed', 'cancelled'].includes(execution.status),
          'all_hot_actual_Models_terminal_with_failures_retained_before_kill',
        );
        const scope = {
          expectedStoreId: before.metadata.storeId,
          sessionId: 's',
          subjectId: 'owner',
          executionId: execution.id,
        };
        const input = await runtime.readModelInput(scope);
        const visible = structuredClone(request);
        for (const message of visible.messages)
          delete (message as { continuation?: unknown }).continuation;
        assert(
          isDeepStrictEqual(input.request, visible),
          'full_original_actual_Input_native_inspector',
        );
        inputs.push(input);
        if (execution.status === 'succeeded') {
          const output = await runtime.readModelOutput(scope);
          assert(output.output.complete, 'complete_original_successful_Output_native_inspector');
          outputs.push(output);
        }
      }
      const interpretation = interpretations[0]!;
      const input = inputs.find((item) => item.executionId === interpretation.id)!;
      const output = outputs.find((item) => item.executionId === interpretation.id)!;
      assert(
        input.request.tools.length === 0 &&
          input.request.messages.some((message) =>
            message.content.includes('Original input identity:'),
          ),
        'real_original_interpretation_request_tools_empty',
      );
      const traces = object(read(join(root, 'hot-streams.json')).traces);
      assert(
        actualRequests.every((request) => {
          const trace = object(traces[request.requestId]);
          const execution = before.view.executions.find((row) => row.id === request.requestId);
          return (
            trace.closed === true &&
            (execution?.status !== 'succeeded' || (trace.finish === true && trace.eof === true))
          );
        }),
        'all_real_hot_SDK_attempts_closed_finish_and_EOF_before_kill',
      );
      const parsed = JSON.parse(output.output.content) as Record<string, unknown>;
      if (
        !(
          parsed.relation === 'same_work' &&
          parsed.purpose === 'work' &&
          parsed.target_root_work_command_id === 'A' &&
          parsed.input_command_id === before.raw!.id &&
          parsed.input_digest === before.raw!.requestDigest
        )
      )
        throw Error('branch_not_reached_natural_interpretation_not_original_A_work');
      await runtime.getCommand('input');
      await runtime.getExecution(interpretation.id);
      await runtime.getView('s');
      const after = await facts(store, root, ids);
      assert(
        isDeepStrictEqual(before, after),
        'cold_readonly_all_facts_cursor_owner_unchanged_zero_dispatch',
      );
      const canonical = await saveLiveCanonicalModelEvidence({
        runtime,
        store,
        requests: actualRequests,
        root: join(root, 'cold-canonical'),
        subjectId: 'owner',
      });
      assert(canonical.complete, 'cold_complete_original_Model_inspectors_retained');
      save(join(root, 'cold-evidence.json'), {
        before,
        after,
        inputs,
        outputs,
        interpretationId: interpretation.id,
        interpretationProposal: parsed,
        canonical,
        configuredProviderFactories: 0,
        ModelPorts: 0,
        providerAttempts: 0,
      });
      process.stdout.write(
        `${JSON.stringify({ phase: name, coldZeroProvider: true, originalSuccessfulInterpretation: interpretation.id })}\n`,
      );
    } finally {
      if (runtime) await runtime.close();
      else await store.close();
    }
    return;
  }
  const used =
    name === 'resume' ? (read(join(root, 'hot-provider.json')).wire as unknown[]).length : 0;
  const fixture = await createLiveModelFixture({
    requestLimit: control.requestLimit - used,
    timeoutMs: control.deadline - Date.now(),
    observe(state) {
      save(join(root, `${name}-provider.json`), {
        ...state,
        phase: name,
        policy:
          'pre-fetch durable intent; status0 preserved as unknown/failed, no synthetic response',
      });
    },
  });
  assert(
    object(fixture.metadata.settings).maxOutputTokens === 4096 &&
      object(fixture.metadata.settings).reasoningEffort === 'medium',
    'original_4096_medium_no_config_override',
  );
  if (name === 'resume')
    assert(
      isDeepStrictEqual(fixture.metadata, read(join(root, 'hot-provider.json')).metadata),
      'same_configured_Model_protocol_and_preset',
    );
  const traces: Record<string, { finish: boolean; eof: boolean; closed: boolean }> = {};
  const blockedModelAttempts: unknown[] = [];
  const model: ModelAdapter = {
    ...(fixture.model.describeRequest
      ? { describeRequest: fixture.model.describeRequest.bind(fixture.model) }
      : {}),
    async *stream(request, context) {
      if (name === 'resume') {
        const ids = read(join(root, 'boundary.json'));
        const execution = await store!.getExecution(request.requestId);
        if (
          execution?.runId === ids.runId ||
          request.messages.some((message) => message.content.includes('Original input identity:'))
        ) {
          blockedModelAttempts.push({ request, execution });
          save(join(root, 'blocked-original-reinterpretation.json'), blockedModelAttempts);
          throw Error('c04_new_Model_cannot_replace_original_successful_interpretation');
        }
      }
      const trace = { finish: false, eof: false, closed: false };
      traces[request.requestId] = trace;
      try {
        for await (const event of fixture.model.stream(request, context)) {
          if (event.type === 'finish') trace.finish = true;
          yield event;
        }
        trace.eof = true;
      } finally {
        trace.closed = true;
        save(join(root, `${name}-streams.json`), { traces });
      }
    },
  };
  const sources = { capture: async () => [agentContractSource(root)] };
  const binding = (): RunConfiguration => ({
    model,
    modelId: fixture.modelId,
    snapshot: { original: 'immutable A' },
    sources,
    permissions,
    toolIds: [],
  });
  if (name === 'hot') {
    // Reuse the original owner's exact Proxy interception: before decideHumanInput()
    // for model, after its real commit for decision, following a successful model_proposal.
    // Keep the owner interception and IDs; use explicit natural work only for decision.
    await runCrashFixture(
      root,
      window,
      {
        model,
        modelId: fixture.modelId,
        sources,
        permissions,
        resolveRunConfiguration: async () => binding(),
      },
      window === 'decision'
        ? '原工作 A 需要追加一项新的有限文本分析：说明二分查找要求输入有序的原因，并给出一个新例子，生成这次新增的业务结果。这不是询问 A 的已有进度、状态或历史结果；请实际完成这项新分析后给出说明。'
        : undefined,
    );
    return;
  }
  store = await openSqliteStore(profile);
  let currentBindings = 0,
    recoveryBindings = 0;
  try {
    const ids = read(join(root, 'boundary.json'));
    const cold = read(join(root, 'cold-evidence.json'));
    const original = await facts(store, root, ids);
    if (window === 'decision') assertCommittedDecision(original, ids);
    save(join(root, 'resume-before.json'), original);
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      permissions,
      resolveRunConfiguration: async () => {
        currentBindings++;
        throw Error('c04_current_binding_must_not_replace_original_A');
      },
      resolveRecoveryRunConfiguration: async ({ run }) => {
        recoveryBindings++;
        const sealedRuns = (object(cold.before).view as typeof original.view).runs;
        const originalA = sealedRuns.find((entry) => entry.originCommandId === 'A');
        const sealed = sealedRuns.find((entry) => entry.id === run.id);
        assert(
          originalA &&
            sealed &&
            (run.id === ids.runId || run.id === originalA.id) &&
            run.originStoreId === ids.storeId &&
            run.sessionId === 's' &&
            run.originCommandId === sealed.originCommandId &&
            run.rootWorkCommandId === sealed.rootWorkCommandId &&
            run.rootWorkSeq === sealed.rootWorkSeq &&
            isDeepStrictEqual(run.configuration, sealed.configuration) &&
            object(object(originalA.configuration).snapshot).original === 'immutable A',
          'recovery_binding_exact_original_A_manifest',
        );
        return binding();
      },
    });
    await runtime.getView('s');
    assert(
      currentBindings === 0 &&
        recoveryBindings === 0 &&
        fixture.wire.length === 0 &&
        isDeepStrictEqual(original, await facts(store, root, ids)),
      'pre_resume_observation_zero_binding_Provider_or_Store_change',
    );
    const intent = {
      expectedStoreId: String(ids.storeId),
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'explicit-resume-original-processing',
      runId: String(ids.runId),
      expectedOwnerGeneration: String(ids.generation),
    };
    const resumed = await runtime.resumeRun(intent);
    await runtime.waitForCommand('input', { timeoutMs: control.deadline - Date.now() });
    await runtime.waitForCommand(String(ids.processingId), {
      timeoutMs: control.deadline - Date.now(),
    });
    const decidedRaw = await store.getCommand(String(ids.rawId));
    const originalBusinessId = object(decidedRaw?.receipt).businessCommandId;
    assert(typeof originalBusinessId === 'string', 'original_durable_business_Command_identified');
    await runtime.waitForCommand(originalBusinessId, {
      timeoutMs: Math.max(1, control.deadline - Date.now()),
    });
    while (runtime.getLifecycleState().busy) {
      assert(Date.now() < control.deadline, 'global_deadline_waiting_original_recovery_cleanup');
      await Bun.sleep(10);
    }
    const after = await facts(store, root, ids);
    if (window === 'decision') assertCommittedApplication(original, after);
    const originalModel = (object(cold.before).view as typeof original.view).executions.find(
      (row) => row.id === cold.interpretationId,
    )!;
    const processingModels = after.view.executions.filter(
      (row) => row.kind === 'model' && row.runId === ids.runId,
    );
    assert(
      isDeepStrictEqual(
        processingModels,
        original.view.executions.filter((row) => row.kind === 'model' && row.runId === ids.runId),
      ) &&
        processingModels.some(
          (row) => row.id === originalModel.id && isDeepStrictEqual(row, originalModel),
        ),
      'original_successful_interpretation_Model_id_result_revision_unchanged_no_second_Model',
    );
    assert(
      after.view.runs.find((run) => run.id === ids.runId)?.status === 'completed' &&
        isDeepStrictEqual(
          after.view.runs.find((run) => run.id === ids.runId)?.configuration,
          original.view.runs.find((run) => run.id === ids.runId)?.configuration,
        ),
      'same_processing_Run_config_completed_normally',
    );
    assert(
      original.view.executions.every((row) =>
        isDeepStrictEqual(
          row,
          after.view.executions.find((current) => current.id === row.id),
        ),
      ),
      'all_original_terminal_Model_facts_including_failed_attempts_unchanged',
    );
    assert(
      isDeepStrictEqual(original.public?.request, after.public?.request) &&
        original.public?.requestDigest === after.public?.requestDigest,
      'original_public_input_request_digest_unchanged',
    );
    const raw = after.raw!,
      decision = after.decision!,
      business = after.business!;
    assert(
      raw.id === ids.rawId &&
        raw.requestDigest === original.raw!.requestDigest &&
        isDeepStrictEqual(raw.request, original.raw!.request) &&
        object(raw.receipt).state === 'decided',
      'original_raw_input_identity_digest_body_preserved',
    );
    assert(
      decision?.kind === 'human.input.decision' &&
        decision.status === 'applied' &&
        object(object(decision.request).interpretation).executionId === originalModel.id &&
        object(decision.request).inputCommandId === raw.id &&
        object(decision.request).inputDigest === raw.requestDigest,
      'unique_durable_decision_references_original_successful_Model_and_input',
    );
    const proposal = object(object(decision.request).proposal);
    assert(
      proposal.relation === 'same_work' &&
        proposal.purpose === 'work' &&
        proposal.targetRootWorkCommandId === 'A',
      'decision_exact_original_A_work_not_new_work_or_reinterpretation',
    );
    const businessRuns = after.view.runs.filter((run) => run.originCommandId === business?.id);
    const businessRun = businessRuns[0];
    if (window === 'decision')
      assert(
        isDeepStrictEqual(
          businessRun?.configuration,
          object(original.decision!.receipt).configuration,
        ),
        'original_queued_business_sealed_A_configuration_exact',
      );
    assert(
      business &&
        business.id === originalBusinessId &&
        businessRuns.length === 1 &&
        object(after.public?.receipt).runId === businessRun?.id &&
        businessRun?.originCommandId === business.id &&
        businessRun.rootWorkCommandId === 'A' &&
        businessRun.status === 'completed',
      'unique_business_Run_actual_completion_along_original_A',
    );
    assert(
      after.commands.filter((command) => command.kind === 'human.input').length === 1 &&
        after.commands.filter((command) => command.kind === 'human.input.decision').length === 1 &&
        after.view.runs.filter((run) => run.originCommandId === ids.processingId).length === 1 &&
        after.view.runs.length === 3,
      'one_raw_one_decision_one_processing_Run_one_business_successor',
    );
    assert(
      currentBindings === 0 &&
        recoveryBindings > 0 &&
        blockedModelAttempts.length === 0 &&
        after.view.executions.every((row) => row.kind === 'model'),
      'no_current_binding_no_Tools_Job_or_business_effect',
    );
    const originalARun = original.view.runs.find((run) => run.originCommandId === 'A')!;
    assert(
      isDeepStrictEqual(
        originalARun,
        after.view.runs.find((run) => run.id === originalARun.id),
      ),
      'original_completed_A_Run_unchanged',
    );
    const scope = {
      expectedStoreId: String(ids.storeId),
      sessionId: 's',
      subjectId: 'owner',
      executionId: originalModel.id,
    };
    const originalInput = await runtime.readModelInput(scope),
      originalOutput = await runtime.readModelOutput(scope);
    const coldInput = (cold.inputs as unknown[]).find(
        (item) => object(item).executionId === originalModel.id,
      ),
      coldOutput = (cold.outputs as unknown[]).find(
        (item) => object(item).executionId === originalModel.id,
      );
    assert(
      isDeepStrictEqual(stableInspector(originalInput), stableInspector(coldInput)) &&
        isDeepStrictEqual(stableInspector(originalOutput), stableInspector(coldOutput)),
      'original_full_Model_Input_Output_hash_bytes_body_unchanged',
    );
    const actualInputs = [],
      outputs = [];
    for (const request of fixture.requests) {
      const execution = await store.getExecution(request.requestId);
      assert(
        execution?.runId === businessRun.id &&
          execution.rootWorkCommandId === 'A' &&
          ['succeeded', 'failed'].includes(execution.status),
        'all_resume_actual_Provider_requests_only_new_business_A',
      );
      const fullScope = { ...scope, executionId: execution.id };
      const input = await runtime.readModelInput(fullScope);
      const output =
        execution.status === 'succeeded' ? await runtime.readModelOutput(fullScope) : undefined;
      const visible = structuredClone(request);
      for (const message of visible.messages)
        delete (message as { continuation?: unknown }).continuation;
      assert(
        isDeepStrictEqual(input.request, visible) &&
          traces[execution.id]?.closed &&
          (!output ||
            (output.output.complete && traces[execution.id]?.eof && traces[execution.id]?.finish)),
        'full_actual_business_Input_Output_finish_EOF',
      );
      actualInputs.push(input);
      if (output) outputs.push(output);
    }
    assert(
      fixture.requests.length > 0 && outputs.length > 0,
      'real_new_business_Model_not_fabricated_completion',
    );
    const beforeReplay = {
      facts: await facts(store, root, ids),
      wire: fixture.wire.length,
      recoveryBindings,
      currentBindings,
    };
    assert(
      (await runtime.resumeRun(intent)).id === resumed.id,
      'same_original_resume_Command_returned',
    );
    assert(
      isDeepStrictEqual(beforeReplay, {
        facts: await facts(store, root, ids),
        wire: fixture.wire.length,
        recoveryBindings,
        currentBindings,
      }),
      'same_resume_replay_zero_Provider_cursor_owner_decision_Run_or_binding_change',
    );
    const canonical = await saveLiveCanonicalModelEvidence({
      runtime,
      store,
      requests: fixture.requests,
      root: join(root, 'resume-canonical'),
      subjectId: 'owner',
    });
    assert(canonical.complete, 'full_resume_business_canonical_saved');
    save(join(root, 'resume-evidence.json'), {
      intent,
      resumed,
      original,
      after,
      originalInput,
      originalOutput,
      actualInputs,
      outputs,
      canonical,
      recoveryBindings,
      currentBindings,
      replayAllUnchanged: true,
    });
    process.stdout.write(
      `${JSON.stringify({ phase: name, originalInterpretationPreserved: true })}\n`,
    );
  } finally {
    if (runtime) await runtime.close();
    else await store.close();
  }
}
export async function runC04ModelCrash(output: string, window: 'model' | 'decision' = 'model') {
  assert(process.platform !== 'win32', 'SIGKILL_only_Unix_scope');
  assert(
    isAbsolute(output) && !existsSync(output) && !existsSync(`${output}.workspace`),
    'new_absolute_output',
  );
  mkdirSync(`${output}.workspace`, { mode: 0o700 });
  const root = realpathSync(`${output}.workspace`);
  mkdirSync(join(root, 'cold-canonical'), { mode: 0o700 });
  mkdirSync(join(root, 'resume-canonical'), { mode: 0o700 });
  writeFileSync(join(root, 'ledger'), '', { mode: 0o600 });
  const control = { root, deadline: Date.now() + 600000, requestLimit: 40, window };
  save(join(root, 'control.json'), control);
  const code = liveCodeEvidence(),
    script = fileURLToPath(import.meta.url),
    owned = new Set<ReturnType<typeof spawnOwnedStage>>(),
    stages: unknown[] = [];
  let status: 'passed' | 'failed' | 'inconclusive' = 'inconclusive',
    failure: string | undefined;
  try {
    const hot = spawnOwnedStage(script, 'hot', root);
    owned.add(hot);
    const ready = await firstOwnedLine(hot, control.deadline - Date.now());
    if (ready.stageFailed) {
      const originalStageExitCode = await bounded(
        hot.exited,
        Math.min(30000, Math.max(1, control.deadline - Date.now())),
      );
      stages.push({ phase: 'hot', originalStageExitCode });
      throw Error(String(ready.failure));
    }
    assert(
      typeof ready.storeId === 'string' &&
        typeof ready.rawId === 'string' &&
        typeof ready.processingId === 'string' &&
        typeof ready.runId === 'string' &&
        typeof ready.generation === 'string',
      'original_fixture_exact_model_boundary',
    );
    save(join(root, 'boundary.json'), { ...ready, ownedPid: hot.pid });
    stages.push({ phase: 'hot', boundary: ready, kill: await killOwnedStage(hot) });
    const hotObservation = readFileSync(join(root, 'hot-provider.json'), 'utf8');
    assert(
      (read(join(root, 'hot-provider.json')).wire as unknown[]).length < 40,
      'real_hot_HTTP_under_aggregate_budget',
    );
    for (const name of ['cold', 'resume'] as const) {
      assert(Date.now() < control.deadline, 'global_600second_budget_before_phase');
      const child = spawnOwnedStage(script, name, root);
      owned.add(child);
      const result = await firstOwnedLine(child, control.deadline - Date.now());
      stages.push(result);
      const originalStageExitCode = await bounded(
        child.exited,
        Math.min(30000, Math.max(1, control.deadline - Date.now())),
      );
      if (result.stageFailed) {
        stages.push({ phase: name, originalStageExitCode });
        throw Error(String(result.failure));
      }
      assert(originalStageExitCode === 0, 'owned_phase_clean_exit');
      if (name === 'cold')
        assert(
          readFileSync(join(root, 'hot-provider.json'), 'utf8') === hotObservation &&
            !existsSync(join(root, 'cold-provider.json')),
          'cold_zero_Provider_observer_mutation',
        );
    }
    status = 'passed';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    status = failure.startsWith('c04_') ? 'failed' : 'inconclusive';
  } finally {
    let cleanupConfirmed = true;
    const cleanupErrors: string[] = [];
    for (const child of owned)
      if (child.exitCode === null && child.signalCode === null)
        try {
          stages.push({ cleanupOwnedKill: await killOwnedStage(child) });
        } catch (error) {
          cleanupConfirmed = false;
          cleanupErrors.push(String(error));
        }
    for (const child of owned)
      save(join(root, `owned-${child.pid}-stderr.json`), {
        pid: child.pid,
        exitCode: child.exitCode,
        signal: child.signalCode,
        stderr: await new Response(child.stderr).text(),
      });
    const observations = ['hot', 'resume'].flatMap((name) =>
      existsSync(join(root, `${name}-provider.json`))
        ? [
            {
              phase: name,
              file: `${name}-provider.json`,
              ...read(join(root, `${name}-provider.json`)),
            },
          ]
        : [],
    );
    const providerAttempts = observations.reduce(
      (sum, item) => sum + (object(item).wire as unknown[]).length,
      0,
    );
    const endCode = liveCodeEvidence();
    if (existsSync(join(root, 'blocked-original-reinterpretation.json'))) {
      status = 'failed';
      failure = 'c04_new_Model_attempt_to_replace_original_success';
    }
    if (!isDeepStrictEqual(code, endCode)) {
      status = 'failed';
      failure = 'c04_source_drift';
    }
    if (!cleanupConfirmed || providerAttempts > 40) {
      status = 'failed';
      failure ??= 'c04_cleanup_or_aggregate_budget_violation';
    }
    save(output, {
      caseId: window === 'model' ? C04_MODEL_CASE : C04_DECISION_CASE,
      window,
      status,
      failure,
      code,
      endCode,
      providerAttempts,
      requestLimit: 40,
      timeoutMs: 600000,
      stages,
      providerEvidence: observations.map((item) => ({
        phase: item.phase,
        file: item.file,
        sha256: hash(readFileSync(join(root, item.file), 'utf8')),
        attempts: (object(item).wire as unknown[]).length,
      })),
      sourceSha256: hash(readFileSync(script, 'utf8')),
      cleanupConfirmed,
      cleanupErrors,
      originalStoreArtifactsRetained: true,
      semanticReviewRequired: true,
      scope:
        window === 'model'
          ? 'Only real successful input interpretation Model before durable decision; original owner runCrashFixture model window. No committed-decision/queued-business, ordinary Service/GUI, default approval-policy, child/OSJob or cross-platform qualification.'
          : 'Only original owner decision window: actual committed same-A decision and queued business before processing settles; SIGKILL, cold readonly zero Provider and exact original processing recovery. Current-control changes, all other contract52 windows, ordinary Service/GUI/default approvals/child/OSJob/cross-platform remain not_run.',
      cost: 'unknown',
    });
  }
  return { status, output, root };
}
if (import.meta.main) {
  assert(process.env.KITE_RUN_LIVE_INPUT_CRASH === '1', 'explicit_test_artifact_opt_in_required');
  const [name, value, selectedWindow] = process.argv.slice(2);
  assert(value && isAbsolute(value), 'absolute_phase_root_or_output');
  if (name === 'hot' || name === 'cold' || name === 'resume') {
    try {
      await phase(name, value);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      save(join(value, `${name}-failure.json`), {
        phase: name,
        failure,
        stack: error instanceof Error ? error.stack : null,
      });
      process.stdout.write(`${JSON.stringify({ phase: name, stageFailed: true, failure })}\n`);
      process.exitCode = failure.startsWith('c04_') ? 1 : 2;
    }
  } else {
    assert(name === 'run', 'run_output_argument');
    assert(
      selectedWindow === undefined || selectedWindow === 'model' || selectedWindow === 'decision',
      'known_independent_crash_window',
    );
    const result = await runC04ModelCrash(
      value,
      selectedWindow as 'model' | 'decision' | undefined,
    );
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
  }
}
