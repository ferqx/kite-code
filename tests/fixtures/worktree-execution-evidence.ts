import assert from 'node:assert/strict';
import type { AgentRuntime } from '@kite-ai/agent';
import type { OperationRef, ToolContext } from '@kite-ai/agent/extensions';
import type { ExecutionRecord, Store } from '@kite-ai/agent/storage';
import { toolFailurePresentation } from '../../packages/agent/src/tool-failure-presentation';
import {
  decodeWorkerRequest,
  digest,
  validateRequest,
} from '../../packages/agent/src/tools/git-worktree/protocol';
import { readWorktreeOutput } from '../../packages/agent/src/tools/git-worktree/read-output';

const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

export type WorktreeEvidenceStore = Pick<
  Store,
  'listExecutions' | 'listExtensionRecords' | 'getExecution' | 'getCommand' | 'listExecutionOutput'
>;

/** Read the original durable records; the foreground Shell preview is never evidence. */
export async function verifyWorktreeExecutionEvidence(
  store: WorktreeEvidenceStore,
  sessionId: string,
  consumedToolContents?: ReadonlySet<string>,
  originalExecutions?: readonly ExecutionRecord[],
) {
  const executions = originalExecutions ?? (await store.listExecutions(sessionId));
  if (!originalExecutions)
    assert(executions.length < 200, 'worktree_execution_directory_incomplete');
  assert(
    executions.every((row) => row.sessionId === sessionId),
    'worktree_foreign_session_execution',
  );
  const tools = executions.filter((row) => row.definitionId === 'git.worktree');
  const records = [];
  let afterKey: string | undefined;
  for (;;) {
    const page = await store.listExtensionRecords({
      sessionId,
      extensionId: 'builtin.shell',
      contentType: 'application/vnd.kite.git-worktree-operation+json',
      limit: 200,
      ...(afterKey ? { afterKey } : {}),
    });
    records.push(...page);
    if (page.length < 200) break;
    assert(page.at(-1)!.key !== afterKey, 'worktree_record_cursor_stalled');
    afterKey = page.at(-1)!.key;
  }
  const referenced: string[] = [];
  const phases: string[] = [];
  for (const record of records) {
    const value = object(record.value);
    const owner = tools.find((tool) => tool.id === value.ownerExecutionId);
    assert(owner, 'worktree_original_owner_missing');
    assert.equal(record.originStoreId, owner.originStoreId);
    const savedSteps = object(value.steps);
    const steps = ['query', 'prepare', 'mutation'].flatMap((name) =>
      savedSteps[name] === undefined ? [] : [savedSteps[name]],
    );
    assert.equal(steps.length, Object.keys(savedSteps).length, 'worktree_unknown_saved_step');
    for (const rawStep of steps) {
      const step = object(rawStep);
      assert(validateRequest(step.request), 'worktree_original_request_invalid');
      const ref = object(step.ref) as unknown as OperationRef;
      assert.deepEqual(Object.keys(ref).sort(), [
        'commandId',
        'executionId',
        'extensionId',
        'key',
        'originStoreId',
        'sessionId',
      ]);
      assert.equal(ref.key, step.operationKey, 'worktree_original_operation_key');
      assert.equal(ref.sessionId, sessionId);
      assert.equal(ref.originStoreId, owner.originStoreId);
      assert.equal(ref.extensionId, 'builtin.shell');
      assert.equal(typeof ref.executionId, 'string');
      const job = await store.getExecution(ref.executionId!);
      assert(job, 'worktree_original_job_missing');
      assert.equal(job.parentExecutionId, owner.id, 'worktree_original_job_parent');
      assert.equal(job.originCommandId, ref.commandId, 'worktree_original_command_id');
      assert.equal(job.cancelWithParent, true);
      assert.equal(job.rootWorkCommandId, owner.rootWorkCommandId);
      assert.equal(job.rootWorkSeq, owner.rootWorkSeq);
      assert.equal(digest(job.input), digest(step.input), 'worktree_original_job_input');
      assert.equal(digest(step.input), step.inputDigest, 'worktree_frozen_input_digest');
      const workerCommand = object(step.input).command;
      assert.equal(typeof workerCommand, 'string');
      const payload = / '([A-Za-z0-9_-]+)'$/.exec(workerCommand as string);
      assert(payload, 'worktree_original_worker_payload_missing');
      assert.equal(
        digest(decodeWorkerRequest(payload[1]!)),
        digest(step.request),
        'worktree_original_worker_request',
      );
      const command = await store.getCommand(ref.commandId);
      assert(command, 'worktree_original_command_missing');
      assert.equal(command.status, 'applied');
      assert.equal(command.kind, 'operation.job');
      assert.equal(command.sessionId, sessionId);
      assert.equal(command.originStoreId, ref.originStoreId);
      assert.equal(command.rootWorkCommandId, owner.rootWorkCommandId);
      assert.equal(command.rootWorkSeq, owner.rootWorkSeq);
      const request = object(command.request);
      assert.equal(request.kind, 'operation.job');
      assert.equal(request.extensionId, ref.extensionId);
      assert.equal(request.operationKey, ref.key);
      assert.equal(request.parentExecutionId, owner.id);
      assert.equal(request.cancellation, 'attached');
      assert.equal(request.definitionId, 'shell.command');
      assert.equal(request.definitionVersion, '1');
      assert.equal(digest(request.input), digest(job.input));
      assert.equal(object(command.receipt).executionId, job.id);
      assert.equal(object(command.receipt).commandId, ref.commandId);
      const output = await readWorktreeOutput(
        ref,
        {
          sessionId,
          operations: {
            get: () => store.getExecution(ref.executionId!),
            readOutput: (
              _ref: OperationRef,
              options: { afterSeq?: string; upperSeq?: string; limit?: number },
            ) => store.listExecutionOutput({ executionId: ref.executionId!, ...options }),
          } as unknown as ToolContext['operations'],
        },
        step.request,
      );
      if (job.status === 'succeeded') {
        assert(output.frame, 'worktree_original_frame_missing');
        const details = object(object(job.result).details);
        assert.equal(details.processTreeStopped, true, 'worktree_process_tree_not_stopped');
        assert.equal(details.groupStopped, true, 'worktree_process_group_not_stopped');
      }
      referenced.push(job.id);
      phases.push(step.request.phase);
    }
    if (steps.length && value.stableResult) {
      const operation = object(object(object(value.stableResult).details).operation);
      assert.equal(operation.ownerExecutionId, owner.id);
      assert.deepEqual(operation.ref, object(steps.at(-1)).ref);
    }
  }
  const jobs = executions.filter(
    (row) =>
      row.definitionId === 'shell.command' &&
      tools.some((tool) => tool.id === row.parentExecutionId),
  );
  assert.equal(new Set(referenced).size, referenced.length, 'worktree_duplicate_job_ref');
  assert.deepEqual(referenced.sort(), jobs.map((job) => job.id).sort(), 'worktree_unrecorded_job');
  if (consumedToolContents)
    for (const tool of tools) {
      const result = object(tool.result);
      assert.equal(typeof result.content, 'string');
      const details = result.details ? object(result.details) : {};
      // Core presents refusals as readable explanations. Verify that original
      // presentation rather than pretending the raw receipt is public prose.
      const presented = toolFailurePresentation({
        result: tool.result as Parameters<typeof toolFailurePresentation>[0]['result'],
        notDispatched: tool.authorization?.dispatched === false,
        humanDenied:
          tool.authorization?.human?.state === 'answered' &&
          tool.authorization.human.decision === 'deny',
        ...(tool.authorization?.dispatched === false && typeof details.reason === 'string'
          ? { reason: details.reason }
          : {}),
      });
      assert(
        consumedToolContents.has(`${tool.callId}\0${presented ?? (result.content as string)}`),
        'worktree_full_result_not_consumed',
      );
    }
  return { tools, jobs, phases };
}

/** Even initialization and Runtime teardown failures must release the fixture HTTP listener. */
export async function closeWorktreeFixture(
  resources: {
    runtime?: Pick<AgentRuntime, 'close'>;
    store?: Pick<Store, 'close'>;
    server?: { stop(closeActiveConnections?: boolean): unknown };
  },
  primaryError?: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    if (resources.runtime) await resources.runtime.close();
    else await resources.store?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await resources.server?.stop(true);
  } catch (error) {
    errors.push(error);
  }
  if (primaryError !== undefined) {
    if (errors.length)
      throw new AggregateError(
        [primaryError, ...errors],
        'worktree_fixture_failed_and_close_failed',
        {
          cause: primaryError,
        },
      );
    throw primaryError;
  }
  if (errors.length) throw new AggregateError(errors, 'worktree_fixture_close_failed');
}

export function worktreeToolContents(
  messages: readonly { role: string; content: unknown; tool_call_id?: string }[],
) {
  return messages.flatMap((message) =>
    message.role === 'tool' &&
    typeof message.content === 'string' &&
    typeof message.tool_call_id === 'string'
      ? [`${message.tool_call_id}\0${message.content}`]
      : [],
  );
}
