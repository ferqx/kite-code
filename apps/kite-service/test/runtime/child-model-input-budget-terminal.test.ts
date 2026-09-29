import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childThreadIdForToolAttempt } from '@kite-ai/agent-kernel';
import { aiMessage } from '@kite-ai/builtin-runtime/model';
import { SubagentTaskArtifactStore } from '@kite-ai/builtin-runtime/subagent';
import {
  createRuntimeHostStateInitialState,
  LIMITED_RESOURCE_BUDGET_,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { prepareRuntimeEffectForBudget } from '#kite-service/bootstrap/runtime/runtime-effect-dependencies';
import { runStateRuntimeLoop } from '#kite-service/bootstrap/runtime/state-runner';
import { childTerminalResult } from '#kite-service/bootstrap/runtime/subagent/child-session-orchestrator';
import type { AgentConfig } from '#kite-service/config';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { StateHostSessionHarness } from '../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';
import { createMockModel } from '../../../../tests/helpers/mock-model';
import {
  createTestRuntimeEffectExecutor,
  testBuiltinToolCatalog,
} from '../../../../tests/helpers/runtime-model';

test('child model stops before Provider dispatch when only its estimated input fits', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-child-input-budget-'));
  const threadId = childThreadIdForToolAttempt({
    parentSessionId: 'parent-session',
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    attempt: 1,
  });
  const store = openStateStoreForTest(join(root, 'state.sqlite'), { sessionId: threadId });
  const model = createMockModel([{ message: aiMessage({ content: 'must not dispatch' }) }]);
  const config: AgentConfig = {
    apiKey: 'unused',
    baseURL: 'https://example.invalid',
    modelName: 'child-budget-model',
    providerName: 'fixture',
    providerType: 'openai-compatible',
    sandbox: { enabled: false },
    features: { resourceBudget: true, boundedCancellation: true },
  };
  const childToolCeiling = {
    grantDigest: `sha256:${'a'.repeat(64)}`,
    role: 'review' as const,
    allowedTools: ['read_file'],
  };
  const artifactRoot = join(root, 'subagent-tasks');
  mkdirSync(artifactRoot, { mode: 0o700 });
  const delegatedTaskArtifacts = new SubagentTaskArtifactStore({ root: artifactRoot });
  const task = delegatedTaskArtifacts.write({
    owner: {
      parentInvocationId: 'parent-invocation',
      parentAttempt: 1,
      parentToolCallId: 'parent-tool',
      childInvocationId: 'child-invocation',
    },
    task: 'Inspect the workspace.',
  });

  try {
    const now = Date.now();
    const child = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '7'.repeat(64),
      threadId,
      userId: 'test',
      workspace: root,
    });
    const active = reduceRuntimeState(child, {
      type: 'resource_budget.configured',
      runId: 'child-budget-run',
      startedAt: new Date(now - 1_000).toISOString(),
      deadlineAt: new Date(now + 29 * 60_000).toISOString(),
      budget: { ...LIMITED_RESOURCE_BUDGET_, version: 1 },
    });
    if (active.resourceBudget.status !== 'active') throw new Error('Child budget is not active.');
    const childState: RuntimeState = {
      ...active,
      childSessionOrigin: {
        parentSessionId: 'parent-session',
        parentInvocationId: 'parent-invocation',
        parentToolCallId: 'parent-tool',
        attempt: 1,
        childInvocationId: 'child-invocation',
        grantDigest: childToolCeiling.grantDigest,
        taskArtifactRef: task.ref,
        taskArtifactDigest: task.ref.integrityIdentifier,
        taskTextDigest: task.taskDigest,
        taskInputAdmitted: true,
        role: 'review',
        fundingRunId: 'parent-budget-run',
        delegatedReservationId: 'delegated-child-budget',
        delegatedUpperBoundDigest: `sha256:${'d'.repeat(64)}`,
        deadlineAt: active.resourceBudget.deadlineAt,
      },
    };
    const projected = prepareRuntimeEffectForBudget({ type: 'call_model' }, childState, {
      config,
      model,
      builtinToolCatalog: testBuiltinToolCatalog(),
      childToolCeiling,
      delegatedTaskArtifacts,
    });
    if (projected.type !== 'call_model' || !projected.resourceEstimate) {
      throw new Error('Child model Surface has no input estimate.');
    }
    const estimate = projected.resourceEstimate.inputTokens;
    expect(estimate).toBeGreaterThan(0);
    const ceiling = Math.floor(estimate * 1.5);
    expect(ceiling).toBeGreaterThanOrEqual(estimate);
    expect(ceiling).toBeLessThan(estimate * 2);
    const state: RuntimeState = {
      ...childState,
      resourceBudget: {
        ...active.resourceBudget,
        budget: { ...active.resourceBudget.budget, maxRunInputTokens: ceiling },
      },
    };
    const kernel = new StateHostSessionHarness({
      store,
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const events = [] as string[];
    for await (const event of runStateRuntimeLoop(
      kernel,
      createTestRuntimeEffectExecutor({ config, model, childToolCeiling, delegatedTaskArtifacts }),
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      events.push(event.type);
    }

    expect(model.callCount.count).toBe(0);
    expect(events).toContain('run.error');
    expect(events).toContain('turn.aborted');
    expect(events).not.toContain('resource_budget.dispatch_started');
    const persisted = store.loadSnapshot(threadId);
    expect(persisted?.terminalOutcome).toMatchObject({
      status: 'budget_exhausted',
      reasonCode: 'budget_exhausted',
    });
    expect(persisted && childTerminalResult(persisted, '')).toMatchObject({
      ok: false,
      terminalStatus: 'exhausted',
      error: 'budget_exhausted',
    });
    kernel.close();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
