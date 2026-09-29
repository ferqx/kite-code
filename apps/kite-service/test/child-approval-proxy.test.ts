import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { KiteChildApprovalProxyRecord } from '@kite-ai/runtime-storage-sqlite';
import { followupChildApprovalParentToolCallId } from '@kite-ai/runtime-storage-sqlite';
import {
  classifyChildApprovalRecovery,
  projectChildApprovalProxy,
} from '../src/bootstrap/runtime/subagent/child-approval-proxy';
import { createChildApprovalActionProvider } from '../src/bootstrap/runtime/subagent/child-session-runner';

type Input = Parameters<typeof classifyChildApprovalRecovery>[0];

function fixture(): Input {
  const parentState = createRuntimeHostStateInitialState({
    threadId: 'parent',
    userId: 'user',
    workspace: process.cwd(),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  const childState = createRuntimeHostStateInitialState({
    threadId: 'child',
    userId: 'user',
    workspace: process.cwd(),
    recoveryIdentityKey: 'b'.repeat(64),
  });
  parentState.turn = { turnId: 'parent-run', turnIndex: 1, status: 'active' };
  parentState.resourceBudget = { status: 'active' } as never;
  childState.revision = 12;
  childState.turn = { turnId: 'child-run', turnIndex: 1, status: 'active' };
  childState.childSessionOrigin = {
    parentSessionId: 'parent',
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    childInvocationId: 'child-invocation',
    grantDigest: 'sha256:grant',
  } as never;
  childState.tools.calls = {
    'child-tool': {
      toolCallId: 'child-tool',
      name: 'shell_execute',
      modelMessageId: 'model-message',
      modelInvocationId: 'model-invocation',
      args: { command: 'cat /external' },
      createdAtTurnId: 'child-run',
      status: 'awaiting_approval',
    } as never,
  };
  childState.modelInvocations = {
    'model-invocation': {
      status: 'completed',
      dispatchCertainty: 'attempted',
      responseArtifact: {
        artifactId: 'model-response',
        kind: 'model_response',
        integrityIdentifier: `sha256:${'d'.repeat(64)}`,
        byteLength: 1,
      },
    } as never,
  };
  const approval = {
    scope: 'once',
    cwd: process.cwd(),
    threadId: 'child',
    tool: 'shell_execute',
    command: 'cat /external',
    risk: 'read',
    approvalHash: 'hash',
    summary: 'Read external file',
    reason: 'Outside workspace',
    expectedEffects: ['read external file'],
    grantOptions: ['approve_once', 'same_command'],
    recommendedGrant: 'approve_once',
  } as const;
  childState.approvalGeneration = 2;
  childState.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'child-approval',
    toolCallId: 'child-tool',
    approval,
  } as never;
  childState.pendingApprovals = new Map([
    [
      'child-approval',
      {
        interactionId: 'child-approval',
        toolCallId: 'child-tool',
        generation: 2,
        route: 'user',
        status: 'awaiting_user',
        approval,
      } as never,
    ],
  ]);
  parentState.capabilities.invocations = {
    'parent-invocation': {
      toolCallId: 'parent-tool',
      subagentProviderLifecycle: {
        childInvocationId: 'child-invocation',
        childSession: {
          childThreadId: 'child',
          grantDigest: 'sha256:grant',
        },
      },
    } as never,
  };
  const proxy: KiteChildApprovalProxyRecord = {
    proxyInteractionId: 'proxy-approval',
    parentSessionId: 'parent',
    childThreadId: 'child',
    childInvocationId: 'child-invocation',
    parentToolCallId: 'parent-tool',
    childToolCallId: 'child-tool',
    grantDigest: 'sha256:grant',
    childInteractionId: 'child-approval',
    childGeneration: 2,
    childRequestRevision: 12,
    approvalDigest: `sha256:${'c'.repeat(64)}`,
    status: 'pending',
    decision: null,
    parentCommandId: null,
    parentCommandDigest: null,
    parentDecisionRevision: null,
    childAppliedRevision: null,
  };
  return { parentState, childState, proxy };
}

test('independent child approval recovery distinguishes every durable decision gap', () => {
  const input = fixture();
  expect(classifyChildApprovalRecovery(input)).toEqual({ kind: 'wait_for_parent' });
  expect(
    classifyChildApprovalRecovery({
      ...input,
      proxy: {
        ...input.proxy,
        status: 'decided',
        decision: 'approve_once',
        parentCommandId: 'command',
        parentCommandDigest: 'digest',
        parentDecisionRevision: 1,
      },
    }),
  ).toEqual({ kind: 'apply_parent_decision', decision: 'approve_once' });
  const authorizedChild = {
    ...input.childState,
    tools: {
      ...input.childState.tools,
      calls: {
        ...input.childState.tools.calls,
        'child-tool': {
          ...input.childState.tools.calls['child-tool']!,
          status: 'authorized_queued' as const,
        },
      },
    },
  };
  expect(
    classifyChildApprovalRecovery({
      ...input,
      childState: authorizedChild,
      proxy: {
        ...input.proxy,
        status: 'applied',
        decision: 'approve_once',
        childAppliedRevision: 13,
      },
    }),
  ).toEqual({ kind: 'resume_authorized_tool' });
  const runningChild = {
    ...input.childState,
    tools: {
      ...input.childState.tools,
      calls: {
        ...input.childState.tools.calls,
        'child-tool': {
          ...input.childState.tools.calls['child-tool']!,
          status: 'running' as const,
        },
      },
    },
  };
  expect(
    classifyChildApprovalRecovery({
      ...input,
      childState: runningChild,
      proxy: {
        ...input.proxy,
        status: 'applied',
        decision: 'approve_once',
        childAppliedRevision: 13,
      },
    }),
  ).toEqual({ kind: 'recovery_required', reason: 'child_tool_attempt_in_progress' });
});

test('child approval projection is parent scoped and fails closed on stale lineage', () => {
  const input = fixture();
  const projected = projectChildApprovalProxy(input);
  expect(projected).toMatchObject({
    kind: 'approval',
    interactionId: 'proxy-approval',
    owner: {
      kind: 'subagent_tool',
      subagentId: 'child-invocation',
      parentToolCallId: 'parent-tool',
      toolCallId: 'child-tool',
    },
    grants: ['approve_once'],
  });
  expect(JSON.stringify(projected)).not.toContain('"child"');
  expect(
    classifyChildApprovalRecovery({
      ...input,
      proxy: { ...input.proxy, grantDigest: 'sha256:forged' },
    }),
  ).toEqual({ kind: 'recovery_required', reason: 'child_approval_lineage_changed' });
});

test('completed parent can decide an exact active independent followup approval', async () => {
  const input = fixture();
  const parentState = {
    ...input.parentState,
    turn: { ...input.parentState.turn, status: 'completed' as const },
    resourceBudget: { status: 'completed' as const },
  } as unknown as Input['parentState'];
  const childState = {
    ...input.childState,
    resourceBudget: { status: 'active', runId: 'child-run' },
    childSessionOrigin: {
      ...input.childState.childSessionOrigin,
      terminal: { status: 'completed', cleanupConfirmed: true },
    },
    activeFollowupTurn: {
      sourceSessionId: 'parent',
      submissionId: 'submission',
      targetRunId: 'child-run',
      taskId: 'followup-task',
      grantDigest: `sha256:${'e'.repeat(64)}`,
    },
  } as Input['childState'];
  const proxy = {
    ...input.proxy,
    grantDigest: `sha256:${'e'.repeat(64)}`,
    parentToolCallId: followupChildApprovalParentToolCallId({
      submissionId: 'submission',
      targetRunId: 'child-run',
      sourceToolCallId: 'source-followup-tool',
    }),
  };
  expect(projectChildApprovalProxy({ parentState, childState, proxy })).toMatchObject({
    kind: 'approval',
    owner: { subagentId: 'child-invocation', toolCallId: 'child-tool' },
  });
  expect(classifyChildApprovalRecovery({ parentState, childState, proxy })).toEqual({
    kind: 'wait_for_parent',
  });
  const provider = createChildApprovalActionProvider({
    owner: { listPendingChildApprovalProxies: () => [proxy] } as never,
    parentSessionId: 'parent',
    proxyOwner: {
      waitForDecision: async () => ({
        ...proxy,
        status: 'decided',
        decision: 'approve_once',
        parentCommandId: 'decision',
        parentCommandDigest: 'a'.repeat(64),
        parentDecisionRevision: parentState.revision,
      }),
    },
  });
  const committed: unknown[] = [];
  await provider.requestAction(
    { type: 'request_tool_approval', interactionId: 'child-approval', toolCallId: 'child-tool' },
    childState,
    {
      commit: (action, evidence, revision) => {
        committed.push({ action, evidence, revision });
        return { descriptor: { kind: 'precommitted_interaction_action' } } as never;
      },
    },
  );
  expect(committed).toHaveLength(1);
  const unknownChildState = {
    ...childState,
    childSessionOrigin: {
      ...childState.childSessionOrigin,
      terminal: { status: 'unknown', cleanupConfirmed: false },
    },
    activeFollowupTurn: {
      ...childState.activeFollowupTurn,
      sourceRevision: 42,
      sourceStateDigest: `sha256:${'f'.repeat(64)}`,
    },
    resourceBudget: {
      ...childState.resourceBudget,
      budget: { durationOnlyChildRun: true },
    },
  } as Input['childState'];
  await provider.requestAction(
    { type: 'request_tool_approval', interactionId: 'child-approval', toolCallId: 'child-tool' },
    unknownChildState,
    {
      commit: (action, evidence, revision) => {
        committed.push({ action, evidence, revision });
        return { descriptor: { kind: 'precommitted_interaction_action' } } as never;
      },
    },
  );
  expect(committed).toHaveLength(2);
  expect(
    projectChildApprovalProxy({
      parentState,
      childState,
      proxy: { ...proxy, parentToolCallId: 'followup:forged' },
    }),
  ).toBeNull();
});

test('child tool remains blocked until the exact parent decision is durable', async () => {
  const input = fixture();
  let resolveDecision!: (value: KiteChildApprovalProxyRecord) => void;
  const decision = new Promise<KiteChildApprovalProxyRecord>((resolve) => {
    resolveDecision = resolve;
  });
  const committed: unknown[] = [];
  const provider = createChildApprovalActionProvider({
    owner: { listPendingChildApprovalProxies: () => [input.proxy] } as never,
    parentSessionId: 'parent',
    proxyOwner: { waitForDecision: () => decision },
  });
  const request = provider.requestAction(
    { type: 'request_tool_approval', interactionId: 'child-approval', toolCallId: 'child-tool' },
    input.childState,
    {
      commit: (action, evidence, revision) => {
        committed.push({ action, evidence, revision });
        return { descriptor: { kind: 'precommitted_interaction_action' } } as never;
      },
    },
  );
  await Promise.resolve();
  expect(committed).toHaveLength(0);
  resolveDecision({
    ...input.proxy,
    status: 'decided',
    decision: 'approve_once',
    parentCommandId: 'parent-command',
    parentCommandDigest: 'a'.repeat(64),
    parentDecisionRevision: 1,
  });
  await request;
  expect(committed).toHaveLength(1);
  expect(committed[0]).toMatchObject({
    action: {
      type: 'approve',
      interactionId: 'child-approval',
      generation: 2,
      grant: 'approve_once',
    },
    evidence: { scopeSessionId: 'child', targetSessionId: 'child' },
    revision: 12,
  });
  await expect(
    provider.requestAction(
      { type: 'request_user_input', interactionId: 'other', toolCallId: 'child-tool' },
      input.childState,
      {
        commit: () => {
          throw new Error('must not commit');
        },
      },
    ),
  ).rejects.toThrow('Hidden child Session cannot request');
});

test('recovered decided proxy applies the exact parent decision once', async () => {
  const input = fixture();
  const decided: KiteChildApprovalProxyRecord = {
    ...input.proxy,
    status: 'decided',
    decision: 'reject',
    parentCommandId: 'parent-command',
    parentCommandDigest: 'a'.repeat(64),
    parentDecisionRevision: 1,
  };
  const committed: unknown[] = [];
  const provider = createChildApprovalActionProvider({
    owner: { listPendingChildApprovalProxies: () => [decided] } as never,
    parentSessionId: 'parent',
    proxyOwner: { waitForDecision: async () => decided },
    onProxyOpened: () => {
      throw new Error('Decided proxy must not be reopened.');
    },
  });
  await provider.requestAction(
    { type: 'request_tool_approval', interactionId: 'child-approval', toolCallId: 'child-tool' },
    input.childState,
    {
      commit: (action, evidence, revision) => {
        committed.push({ action, evidence, revision });
        return { descriptor: { kind: 'precommitted_interaction_action' } } as never;
      },
    },
  );
  expect(committed).toHaveLength(1);
  expect(committed[0]).toMatchObject({
    action: { type: 'reject', interactionId: 'child-approval', generation: 2 },
    evidence: { scopeSessionId: 'child', targetSessionId: 'child' },
    revision: 12,
  });
});
