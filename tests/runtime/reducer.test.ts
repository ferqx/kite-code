import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { classifyFailure } from '../../src/core/runtime/failures';
import { reduceRuntimeState as reduceCanonicalRuntimeState } from '../../src/core/runtime/reducer';
import type { RuntimeState } from '../../src/core/runtime/state';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
} from '../../src/core/runtime/state';
import { normalizeCurrentToolOutcomeEventV1 } from '../../src/core/runtime/tool-outcome-events';
import type { AgentPlan, AgentPlanStep, ToolApprovalPayload } from '../../src/protocol/events';
import type { SuspendedSubagentSnapshot } from '../../src/protocol/subagent';

// ── 测试辅助函数 / Test helpers ──

function reduceRuntimeState(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  return reduceCanonicalRuntimeState(
    state,
    normalizeCurrentToolOutcomeEventV1(event, state, '2026-08-11T00:00:00.000Z'),
  );
}

function makePlan(name: string = 'Test Plan', steps: string[] = ['step 1', 'step 2']): AgentPlan {
  const planSteps: AgentPlanStep[] = steps.map((step) => ({
    step,
    status: 'pending' as const,
  }));
  return {
    name,
    description: 'A test plan for unit testing',
    status: 'pending',
    steps: planSteps,
  };
}

function makeInitialState(overrides?: Partial<RuntimeState>): RuntimeState {
  const base = createInitialRuntimeState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/tmp/test',
  });
  if (!overrides) return base;
  return { ...base, ...overrides };
}

function makeSuspendedSubagentSnapshot(
  overrides?: Partial<SuspendedSubagentSnapshot>,
): SuspendedSubagentSnapshot {
  return {
    subagentId: 'subagent-1',
    role: 'code',
    task: 'Update the runtime state',
    messages: [],
    toolCallCount: 1,
    steps: [],
    blockedTool: {
      toolCallId: 'nested-tool-1',
      toolName: 'shell_execute',
      args: { command: 'pwd' },
      command: 'pwd',
    },
    ...overrides,
  };
}

function queueTaskCall(state: RuntimeState, toolCallId = 'task-1'): RuntimeState {
  return reduceRuntimeState(state, {
    type: 'tool.queued',
    toolCallId,
    name: 'task',
    args: { task: 'Update the runtime state' },
  });
}

function makeToolApproval(command: string): ToolApprovalPayload {
  return {
    scope: 'once',
    cwd: '/tmp/test',
    threadId: 'thread-1',
    tool: 'shell_execute',
    command,
    risk: 'execute_code',
    approvalHash: 'approval-hash',
    summary: `Run ${command}`,
    reason: 'approval required',
    expectedEffects: [],
    grantOptions: ['approve_once'],
    recommendedGrant: 'approve_once',
  };
}

describe('reduceRuntimeState — capability bindings', () => {
  test('persists the current catalog revision and replaces old bindings atomically', () => {
    const state = makeInitialState();
    const next = reduceRuntimeState(state, {
      type: 'capability.bindings_issued',
      catalogRevision: 'catalog-2',
      bindings: [
        {
          bindingId: 'binding-2',
          capabilityId: 'mcp:fixture/read',
          capabilityRevision: 'tool-2',
          exposedToolName: 'mcp__fixture__read',
          schemaDigest: 'schema-2',
          issuedForTurnId: state.turn.turnId,
        },
      ],
    });
    expect(next.capabilities.catalogRevision).toBe('catalog-2');
    expect(next.capabilities.bindings['binding-2']?.capabilityRevision).toBe('tool-2');
    expect(next).not.toBe(state);
  });

  test('persists a one-shot search and consumes it with finite disclosures', () => {
    const state = makeInitialState();
    const searched = reduceRuntimeState(state, {
      type: 'capability.search_completed',
      result: {
        searchId: 'search-1',
        query: 'publish release',
        catalogRevision: 'catalog-1',
        requestedAtTurnId: state.turn.turnId,
        candidates: [
          {
            candidateRef: 'candidate-1',
            capabilityId: 'skill:release',
            capabilityRevision: 'skill-r1',
            kind: 'skill',
            displayName: 'release',
            providerType: 'skill',
            providerId: 'release',
          },
        ],
      },
    });
    const disclosed = reduceRuntimeState(searched, {
      type: 'capability.bindings_issued',
      catalogRevision: 'catalog-1',
      bindings: [],
      disclosures: [
        {
          capabilityId: 'skill:release',
          capabilityRevision: 'skill-r1',
          issuedForTurnId: state.turn.turnId,
        },
      ],
      searchId: 'search-1',
    });

    expect(searched.capabilities.pendingSearch?.searchId).toBe('search-1');
    expect(disclosed.capabilities.pendingSearch).toBeUndefined();
    expect(disclosed.capabilities.disclosures['skill:release']).toEqual({
      capabilityId: 'skill:release',
      capabilityRevision: 'skill-r1',
      issuedForTurnId: state.turn.turnId,
    });
  });

  test('projects a durable capability invocation without raw arguments or result content', () => {
    const state = makeInitialState();
    const recorded = reduceRuntimeState(state, {
      type: 'capability.invocation_recorded',
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'revision-1',
      argumentsDigest: 'arguments-digest',
      authorizationDigest: 'approval-digest',
      effectiveEffectsDigest: 'effects-digest',
      effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
      recordedAt: '2026-07-14T00:00:00.000Z',
    });
    const started = reduceRuntimeState(recorded, {
      type: 'capability.execution_started',
      invocationId: 'invocation-1',
      startedAt: '2026-07-14T00:00:01.000Z',
    });
    const finished = reduceRuntimeState(started, {
      type: 'capability.execution_succeeded',
      invocationId: 'invocation-1',
      resultDigest: 'result-digest',
      evidenceDigest: 'evidence-digest',
      externalReferences: ['resource://fixture/1'],
      finishedAt: '2026-07-14T00:00:02.000Z',
    });

    expect(finished.capabilities.invocations['invocation-1']).toEqual({
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'revision-1',
      argumentsDigest: 'arguments-digest',
      authorizationDigest: 'approval-digest',
      effectiveEffectsDigest: 'effects-digest',
      status: 'succeeded',
      recordedAt: '2026-07-14T00:00:00.000Z',
      startedAt: '2026-07-14T00:00:01.000Z',
      finishedAt: '2026-07-14T00:00:02.000Z',
      resultDigest: 'result-digest',
      evidenceDigest: 'evidence-digest',
      externalReferences: ['resource://fixture/1'],
    });
  });

  test('marks an uncompleted recorded invocation unknown during recovery projection', () => {
    const state = reduceRuntimeState(makeInitialState(), {
      type: 'capability.invocation_recorded',
      invocationId: 'invocation-unknown',
      toolCallId: 'tool-unknown',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'revision-1',
      argumentsDigest: 'arguments-digest',
      authorizationDigest: 'approval-digest',
      effectiveEffectsDigest: 'effects-digest',
      effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
      recordedAt: '2026-07-14T00:00:00.000Z',
    });
    const recovered = reduceRuntimeState(state, {
      type: 'capability.execution_unknown',
      invocationId: 'invocation-unknown',
      reason: 'provider result was not persisted',
      finishedAt: '2026-07-14T00:00:03.000Z',
    });
    expect(recovered.capabilities.invocations['invocation-unknown']).toMatchObject({
      status: 'unknown',
      error: 'provider result was not persisted',
      finishedAt: '2026-07-14T00:00:03.000Z',
    });
  });
});

function uuidPattern() {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
}
/** Replicate sanitizeStepId from reducer.ts for digest computation parity. */
function sanitizeStepId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'step'
  );
}

/** Convert AgentPlan to the minimal shape needed by computePlanStructuralDigest. */
function planToDigestInput(plan: AgentPlan) {
  return {
    title: plan.name.slice(0, 120),
    bodyMarkdown: plan.description,
    steps: plan.steps.map((s) => ({
      id: sanitizeStepId(s.step),
      title: s.step.slice(0, 160),
      status: 'pending' as const,
    })),
  };
}

/** Build a PlanDocument-compatible object from an AgentPlan for test state construction. */
function makePlanDoc(
  plan: AgentPlan,
  overrides?: {
    planId?: string;
    version?: number;
    structuralDigest?: string;
    createdAtTurnId?: string;
    updatedAtTurnId?: string;
  },
) {
  return {
    planId: overrides?.planId ?? 'test-plan-id',
    version: overrides?.version ?? 1,
    title: plan.name.slice(0, 120),
    bodyMarkdown: plan.description,
    steps: plan.steps.map((s) => ({
      id: sanitizeStepId(s.step),
      title: s.step.slice(0, 160),
      status: (s.status === 'completed'
        ? 'completed'
        : s.status === 'in_progress'
          ? 'in_progress'
          : 'pending') as 'pending' | 'in_progress' | 'completed' | 'skipped',
    })),
    structuralDigest:
      overrides?.structuralDigest ?? computePlanStructuralDigest(planToDigestInput(plan)),
    createdAtTurnId: overrides?.createdAtTurnId ?? 'turn-0',
    updatedAtTurnId: overrides?.updatedAtTurnId ?? 'turn-0',
  };
}

function makeV2PlanDoc(plan: AgentPlan, overrides?: Parameters<typeof makePlanDoc>[1]) {
  return {
    ...makePlanDoc(plan, overrides),
    planSchemaVersion: 2 as const,
    completionEvidence: {
      schemaVersion: 1 as const,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
  };
}

function attachPlanReviewInteraction(
  state: RuntimeState,
  plan: AgentPlan,
  planSummary = 'Review this plan',
): RuntimeState {
  if (state.planning.kind !== 'awaiting_review') {
    throw new Error('Expected an awaiting plan review');
  }
  const { document, interactionId, exitToolCallId } = state.planning;
  return {
    ...state,
    interactions: {
      kind: 'awaiting_review',
      interactionId,
      toolCallId: exitToolCallId,
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan,
      planSummary,
    },
  };
}

function planReviewIdentity(state: RuntimeState) {
  if (state.interactions.kind !== 'awaiting_review') {
    throw new Error('Expected an active plan review interaction');
  }
  return {
    interactionId: state.interactions.interactionId,
    toolCallId: state.interactions.toolCallId,
    planId: state.interactions.planId,
    version: state.interactions.version,
    structuralDigest: state.interactions.structuralDigest,
  };
}

// ── 方案生命周期 / Plan lifecycle ──

describe('reduceRuntimeState — plan lifecycle', () => {
  // 验证 plan.review_requested 从'none'状态创建 awaiting_review
  test('plan.review_requested creates awaiting_review from none', () => {
    const state = makeInitialState();
    const plan = makePlan('My Plan', ['do a', 'do b']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-1',
      toolCallId: 'call-1',
      plan,
      planSummary: 'A plan to do a then b',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('awaiting_review');
    if (next.planning.kind === 'awaiting_review') {
      expect(next.planning.document.planId).toMatch(uuidPattern());
      expect(next.planning.document.version).toBe(1);
      expect(next.planning.document.title).toBe(plan.name);
      expect(next.planning.document.bodyMarkdown).toBe(plan.description);
      expect(next.planning.document.steps).toHaveLength(plan.steps.length);
      expect(next.planning.document.structuralDigest).toBe(
        computePlanStructuralDigest(planToDigestInput(plan)),
      );
      expect(next.planning.interactionId).toBe('inter-1');
      expect(next.planning.exitToolCallId).toBe('call-1');
    }
    expect(next.interactions.kind).toBe('awaiting_review');
    if (next.interactions.kind === 'awaiting_review') {
      expect(next.interactions.interactionId).toBe('inter-1');
      expect(next.interactions.toolCallId).toBe('call-1');
      expect(next.interactions.plan).toBe(plan);
      expect(next.interactions.planSummary).toBe('A plan to do a then b');
    }
  });

  test('plan.review_requested inherits the saved draft version', () => {
    const draftPlan = makePlan('Draft Plan', ['x', 'y']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'planning_draft',
        document: makePlanDoc(draftPlan, { planId: 'existing-plan-id', version: 3 }),
      },
    };
    const newPlan = makePlan('Draft Plan V2', ['x', 'y', 'z']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-2',
      toolCallId: 'call-2',
      plan: newPlan,
      planSummary: 'Updated plan',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('awaiting_review');
    if (next.planning.kind === 'awaiting_review') {
      expect(next.planning.document.planId).toBe('existing-plan-id');
      expect(next.planning.document.version).toBe(3);
      expect(next.planning.document.title).toBe(newPlan.name);
    }
  });

  test('V2 review replay rejects substituted content under the saved identity', () => {
    const trustedPlan = makePlan('Trusted Plan', ['trusted step']);
    const document = makeV2PlanDoc(trustedPlan, {
      planId: 'trusted-plan-id',
      version: 7,
    });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: { kind: 'planning_draft', document },
    };
    const substitutedPlan = makePlan('Substituted Plan', ['malicious step']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'substituted-review',
      toolCallId: 'substituted-review-tool',
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan: substitutedPlan,
      planSummary: 'Substituted content under a trusted identity',
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 review replay keeps the Artifact saved with the trusted draft', () => {
    const trustedPlan = makePlan('Trusted Plan', ['trusted step']);
    const baseDocument = makeV2PlanDoc(trustedPlan, {
      planId: 'trusted-plan-id',
      version: 7,
    });
    const trustedArtifact = {
      artifactId: 'trusted-plan-id:v7',
      taskId: 'trusted-task',
      planId: baseDocument.planId,
      version: baseDocument.version,
      fileName: 'v7.md',
      relativePath: 'plans/trusted-task/trusted-plan-id/v7.md',
      displayPath: '/trusted/v7.md',
      structuralDigest: baseDocument.structuralDigest,
      byteLength: 100,
    };
    const document = { ...baseDocument, artifact: trustedArtifact };
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: { kind: 'planning_draft', document },
    };
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'substituted-artifact-review',
      toolCallId: 'substituted-artifact-tool',
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan: trustedPlan,
      planSummary: 'Trusted content with a substituted Artifact reference',
      artifact: {
        ...trustedArtifact,
        taskId: 'substituted-task',
        relativePath: 'plans/substituted-task/trusted-plan-id/v7.md',
        displayPath: '/substituted/v7.md',
      },
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('awaiting_review');
    if (next.planning.kind === 'awaiting_review') {
      expect(next.planning.document.artifact).toBe(trustedArtifact);
    }
    expect(next.interactions.kind).toBe('awaiting_review');
    if (next.interactions.kind === 'awaiting_review') {
      expect(next.interactions.artifact).toBe(trustedArtifact);
    }
  });

  test('plan.review_requested preserves the revision draft version', () => {
    const revPlan = makePlan('Rev Plan', ['a']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'planning_draft',
        document: makePlanDoc(revPlan, { planId: 'rev-plan-id', version: 5 }),
        revisionFeedback: 'too vague',
      },
    };
    const newPlan = makePlan('Rev Plan V2', ['a', 'b']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-3',
      toolCallId: 'call-3',
      plan: newPlan,
      planSummary: 'Revised plan',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('awaiting_review');
    if (next.planning.kind === 'awaiting_review') {
      expect(next.planning.document.planId).toBe('rev-plan-id');
      expect(next.planning.document.version).toBe(5);
      expect(next.planning.document.title).toBe(newPlan.name);
    }
  });

  // 验证 plan.approved 将 awaiting_review 转为 approved
  test('plan.approved transitions awaiting_review to approved', () => {
    const plan = makePlan('Approval Plan', ['step 1']);
    const structuralHash = computePlanStructuralDigest(planToDigestInput(plan));
    const state = attachPlanReviewInteraction(
      {
        ...makeInitialState(),
        planning: {
          kind: 'awaiting_review',
          document: makePlanDoc(plan, { planId: 'plan-99', version: 2 }),
          interactionId: 'inter-99',
          exitToolCallId: 'call-99',
        },
      },
      plan,
    );
    const event: RuntimeEvent = {
      type: 'plan.approved',
      ...planReviewIdentity(state),
      executionMode: 'auto',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('executing');
    if (next.planning.kind === 'executing') {
      expect(next.planning.document.planId).toBe('plan-99');
      expect(next.planning.document.version).toBe(2);
      expect(next.planning.document.title).toBe(plan.name);
      expect(next.planning.document.bodyMarkdown).toBe(plan.description);
      expect(next.planning.document.steps).toHaveLength(plan.steps.length);
      expect(next.planning.document.structuralDigest).toBe(structuralHash);
      expect(next.planning.approvedAtTurnId).toBe(state.turn.turnId);
      expect(next.planning.executionMode).toBe('auto');
    }
    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 plan.approved 在非 awaiting_review 状态时为 no-op（保留原有 plan）
  test('plan.approved is no-op when plan is not awaiting_review', () => {
    const state = makeInitialState(); // planning.kind === 'building_without_plan'
    const event: RuntimeEvent = {
      type: 'plan.approved',
      interactionId: 'inter-99',
      executionMode: 'accept_edits',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('building_without_plan');
    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 plan.revision_requested 转为 needs_revision
  test('plan.revision_requested transitions to needs_revision', () => {
    const plan = makePlan('Needs Fix', ['bad step']);
    const state = attachPlanReviewInteraction(
      {
        ...makeInitialState(),
        planning: {
          kind: 'awaiting_review',
          document: makePlanDoc(plan, { planId: 'plan-fix', version: 1 }),
          interactionId: 'inter-fix',
          exitToolCallId: 'call-fix',
        },
      },
      plan,
    );
    const event: RuntimeEvent = {
      type: 'plan.revision_requested',
      ...planReviewIdentity(state),
      feedback: 'Please add more detail to step 1',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('planning_draft');
    if (next.planning.kind === 'planning_draft') {
      expect(next.planning.document.planId).toBe('plan-fix');
      expect(next.planning.document.version).toBe(1);
      expect(next.planning.document.title).toBe(plan.name);
      expect(next.planning.document.bodyMarkdown).toBe(plan.description);
      expect(next.planning.document.steps).toHaveLength(plan.steps.length);
      expect(next.planning.revisionFeedback).toBe('Please add more detail to step 1');
    }
    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 plan.rejected 重置 plan 为 none
  test('plan.rejected keeps a draft and clears interactions', () => {
    const plan = makePlan('Rejected Plan', ['doom']);
    const state = attachPlanReviewInteraction(
      {
        ...makeInitialState(),
        planning: {
          kind: 'awaiting_review',
          document: makePlanDoc(plan, { planId: 'plan-doom', version: 1 }),
          interactionId: 'inter-doom',
          exitToolCallId: 'call-doom',
        },
      },
      plan,
    );
    const event: RuntimeEvent = {
      type: 'plan.rejected',
      ...planReviewIdentity(state),
      reason: 'Not what I want',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('planning_draft');
    if (next.planning.kind === 'planning_draft') {
      expect(next.planning.revisionFeedback).toBe('Not what I want');
      expect(next.planning.document).toBeDefined();
    }
    expect(next.interactions.kind).toBe('idle');
  });

  test('approval.rejected ignores a mismatched tool identity', () => {
    const state = makeInitialState();
    state.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'approval-mismatch',
      toolCallId: 'expected-tool',
      approval: {
        scope: 'once',
        cwd: '/tmp',
        threadId: 'thread-1',
        tool: 'shell_execute',
        command: 'pwd',
        risk: 'execute_code',
        approvalHash: 'mismatch',
        summary: 'inspect',
        reason: 'test',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    };

    const next = reduceRuntimeState(state, {
      type: 'approval.rejected',
      interactionId: 'approval-mismatch',
      toolCallId: 'other-tool',
      reason: 'Rejected by user.',
    });

    expect(next).toBe(state);
  });
});

// ── 工具生命周期 / Tool lifecycle ──

describe('reduceRuntimeState — tool lifecycle', () => {
  // 验证 tool.queued 将工具入队
  test('tool.queued adds tool call to queue with queued status', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.queued',
      toolCallId: 'tool-1',
      name: 'shell_execute',
      args: { command: 'echo hello' },
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual(['tool-1']);
    expect(next.tools.calls['tool-1']).toBeDefined();
    const call = next.tools.calls['tool-1']!;
    expect(call.toolCallId).toBe('tool-1');
    expect(call.name).toBe('shell_execute');
    expect(call.args).toEqual({ command: 'echo hello' });
    expect(call.status).toBe('queued');
    expect(call.createdAtTurnId).toBe(state.turn.turnId);
  });

  test('replayed tool.queued is idempotent and preserves a terminal call', () => {
    let state = reduceRuntimeState(makeInitialState(), {
      type: 'tool.queued',
      toolCallId: 'tool-replay',
      name: 'read_file',
      args: { path: 'a.ts' },
    });
    state = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'tool-replay',
      name: 'read_file',
      result: { ok: true, command: '', exitCode: 0, stdout: 'ok', stderr: '' },
    });

    const replayed = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-replay',
      name: 'read_file',
      args: { path: 'a.ts' },
    });

    expect(replayed).toBe(state);
    expect(replayed.tools.queue).toEqual([]);
    expect(replayed.tools.calls['tool-replay']!.status).toBe('succeeded');
  });

  // 验证 tool.started 从队列移到活跃列表并设为 running
  test('tool.started moves tool from queue to active with running status', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-1': {
            toolCallId: 'tool-1',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'ls' },
            status: 'queued',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: ['tool-1'],
        active: [],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.started',
      toolCallId: 'tool-1',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual([]);
    expect(next.tools.active).toEqual(['tool-1']);
    expect(next.tools.calls['tool-1']!.status).toBe('running');
  });

  test('legacy tool.execution_ready keeps a preflighted shell call queued', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'shell-ready': {
            toolCallId: 'shell-ready',
            modelMessageId: 'parallel-shell-model',
            name: 'shell_execute',
            args: { command: 'pwd' },
            status: 'queued',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: ['shell-ready'],
        active: [],
      },
    };

    const next = reduceRuntimeState(state, {
      type: 'tool.execution_ready',
      toolCallId: 'shell-ready',
    });

    expect(next.tools.calls['shell-ready']?.status).toBe('approved');
    expect(next.tools.queue).toEqual(['shell-ready']);
    expect(next.tools.active).toEqual([]);
  });

  // 验证 tool.started 对不存在的 toolCallId 静默忽略
  test('tool.started is no-op for unknown toolCallId', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.started',
      toolCallId: 'nonexistent',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual([]);
    expect(next.tools.active).toEqual([]);
    expect(next.tools.calls).toEqual({});
    // 不可变：应该返回原引用（因为没有修改）
    expect(next.tools).toBe(state.tools);
  });

  // 验证 tool.finished 设置 succeeded 并移除活跃
  test('tool.finished sets succeeded status and removes from active', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-2': {
            toolCallId: 'tool-2',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'pwd' },
            status: 'running',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: [],
        active: ['tool-2'],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'tool-2',
      name: 'test-tool',
      result: {
        ok: true,
        command: 'pwd',
        exitCode: 0,
        stdout: '/home/user\n',
        stderr: '',
      },
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.active).toEqual([]);
    const call = next.tools.calls['tool-2']!;
    expect(call.status).toBe('succeeded');
    expect(call.result).toBeDefined();
    expect(call.result!.ok).toBe(true);
    expect(call.result!.exitCode).toBe(0);
    expect(call.result!.summary).toContain('pwd');
  });

  test('parallel sibling results keep assistant declaration order when completion reverses', () => {
    let state = makeInitialState();
    for (const [ordinal, toolCallId] of ['read-first', 'read-second'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'model-parallel',
        ordinal,
        name: 'read_file',
        args: { path: `${toolCallId}.txt` },
        status: 'running',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.active.push(toolCallId);
    }
    const finish = (toolCallId: string): RuntimeEvent => ({
      type: 'tool.finished',
      toolCallId,
      name: 'read_file',
      result: {
        ok: true,
        command: '',
        exitCode: 0,
        stdout: toolCallId,
        stderr: '',
      },
    });

    state = reduceRuntimeState(state, finish('read-second'));
    state = reduceRuntimeState(state, finish('read-first'));

    expect(
      state.transcript.messages
        .filter((message) => message.kind === 'tool')
        .map((message) => [message.toolCallId, message.ordinal]),
    ).toEqual([
      ['read-first', 0],
      ['read-second', 1],
    ]);
  });

  test('tool.finished removes an unstarted interactive tool from queue', () => {
    let state = reduceRuntimeState(makeInitialState(), {
      type: 'tool.queued',
      toolCallId: 'ask-1',
      name: 'ask_user',
      args: {},
    });
    state = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'ask-1',
      name: 'ask_user',
      result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
    });

    expect(state.tools.queue).toEqual([]);
    expect(state.tools.calls['ask-1']!.status).toBe('succeeded');
  });

  test('tool.finished with ok:false records failed rather than succeeded', () => {
    let state = reduceRuntimeState(makeInitialState(), {
      type: 'tool.queued',
      toolCallId: 'failed-1',
      name: 'shell_execute',
      args: { command: 'false' },
    });
    state = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'failed-1',
      name: 'shell_execute',
      result: { ok: false, command: 'false', exitCode: 1, stdout: '', stderr: 'failed' },
    });

    expect(state.tools.calls['failed-1']!.status).toBe('failed');
  });

  test('cancelled ask_user completion clears its active user-input interaction', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'ask-1': {
            toolCallId: 'ask-1',
            modelMessageId: 'model-1',
            name: 'ask_user',
            args: { question: 'q' },
            status: 'awaiting_user_input',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: [],
        active: [],
      },
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'input-1',
        toolCallId: 'ask-1',
        request: { question: 'q', options: [], allow_free_text: true },
      },
    };

    const next = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'ask-1',
      name: 'ask_user',
      result: {
        ok: false,
        command: '',
        exitCode: -1,
        stdout: 'Cancelled',
        stderr: 'Cancelled by user.',
      },
    });

    expect(next.interactions).toEqual({ kind: 'idle' });
    expect(next.tools.calls['ask-1']!.status).toBe('failed');
  });

  // 验证 tool.finished 对不存在的 toolCallId 静默忽略
  test('tool.finished is no-op for unknown toolCallId', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'nonexistent',
      name: 'test-tool',
      result: { ok: false, command: 'x', exitCode: 1, stdout: '', stderr: 'err' },
    };

    const next = reduceRuntimeState(state, event);

    expect(next).toEqual(state);
  });

  // 验证 tool.failed 设置 failed 状态和错误信息
  test('tool.failed sets failed status with error message', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-3': {
            toolCallId: 'tool-3',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'rm -rf /' },
            status: 'running',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: [],
        active: ['tool-3'],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.failed',
      toolCallId: 'tool-3',
      error: 'permission denied',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.active).toEqual([]);
    expect(next.tools.calls['tool-3']!.status).toBe('failed');
    expect(next.tools.calls['tool-3']!.error).toBe('permission denied');
    expect(next.tools.calls['tool-3']!.result).toBeUndefined();
  });

  // 验证 tool.rejected 移除队列和活跃列表，设置 rejected 状态
  test('tool.rejected removes from queue/active and sets rejected status', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-4': {
            toolCallId: 'tool-4',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'sudo rm -rf /' },
            status: 'queued',
            createdAtTurnId: 'turn-0',
          },
          'tool-5': {
            toolCallId: 'tool-5',
            modelMessageId: '',
            name: 'write_file',
            args: { path: '/etc/hosts', content: 'x' },
            status: 'queued',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: ['tool-4', 'tool-5'],
        active: [],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.rejected',
      toolCallId: 'tool-4',
      reason: 'destructive operation denied',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual(['tool-5']);
    expect(next.tools.active).toEqual([]);
    expect(next.tools.calls['tool-4']!.status).toBe('rejected');
    expect(next.tools.calls['tool-5']!.status).toBe('queued'); // 其他工具不受影响
  });

  // 验证 tool.rejected 对不存在记录的工具也能从队列中移除
  test('tool.rejected removes from queue even when call record is absent', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {},
        queue: ['ghost-tool'],
        active: [],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.rejected',
      toolCallId: 'ghost-tool',
      reason: 'blocked by policy',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual([]);
    expect(next.tools.calls).toEqual({});
  });

  test('returns a phase deferral as structured planning guidance to the model', () => {
    const queued = reduceRuntimeState(makeInitialState(), {
      type: 'tool.queued',
      toolCallId: 'verify-later',
      name: 'shell_execute',
      args: { command: 'bun run typecheck', description: 'Type-check the project' },
    });

    const next = reduceRuntimeState(queued, {
      type: 'tool.rejected',
      toolCallId: 'verify-later',
      reason: 'Deferred shell_execute until building phase.',
      failure: classifyFailure('phase_deferred', 'Deferred shell_execute until building phase.'),
    });

    expect(next.tools.calls['verify-later']).toMatchObject({
      status: 'rejected',
      failure: { kind: 'phase_deferred' },
    });
    expect(JSON.parse(String(next.transcript.messages.at(-1)?.content))).toEqual({
      ok: false,
      deferred: true,
      reason: 'phase_constraint',
      until_phase: 'building',
      tool: 'shell_execute',
      arguments: {
        command: 'bun run typecheck',
        description: 'Type-check the project',
      },
      next_step:
        'Do not retry or request approval while planning. Preserve this command in the plan execution or verification section, then invoke it only after plan approval changes the phase to building.',
    });
  });

  test('returns a phase denial as actionable planning guidance to the model', () => {
    const queued = reduceRuntimeState(makeInitialState(), {
      type: 'tool.queued',
      toolCallId: 'edit-after-plan',
      name: 'edit_file',
      args: {
        path: 'src/example.ts',
        old_string: 'const before = true;',
        new_string: 'const after = true;',
      },
    });
    const reason =
      'Plan mode is read-only. No file was edited. Describe the intended change in the plan and apply it after plan approval.';

    const next = reduceRuntimeState(queued, {
      type: 'tool.rejected',
      toolCallId: 'edit-after-plan',
      reason,
      failure: classifyFailure('phase_denied', reason),
    });

    expect(next.tools.calls['edit-after-plan']).toMatchObject({
      status: 'rejected',
      failure: { kind: 'phase_denied' },
    });
    expect(JSON.parse(String(next.transcript.messages.at(-1)?.content))).toEqual({
      ok: false,
      rejected: true,
      reason: 'phase_constraint',
      phase: 'planning',
      tool: 'edit_file',
      arguments: {
        path: 'src/example.ts',
        old_string: 'const before = true;',
        new_string: 'const after = true;',
      },
      message: reason,
      next_step:
        'Do not retry or request approval while planning. Use read-only inspection capabilities and preserve the intended implementation in the plan for execution after plan approval.',
    });
  });

  // 验证 tool.progress 不修改 state
  test('tool.cancelled clears its interaction and is idempotent', () => {
    let state = reduceRuntimeState(makeInitialState(), {
      type: 'tool.queued',
      toolCallId: 'tool-cancel',
      name: 'shell_execute',
      args: { command: 'bun test' },
    });
    state = reduceRuntimeState(state, {
      type: 'approval.requested',
      interactionId: 'approval-cancel',
      toolCallId: 'tool-cancel',
      approval: makeToolApproval('bun test'),
    });

    const cancelled = reduceRuntimeState(state, {
      type: 'tool.cancelled',
      toolCallId: 'tool-cancel',
      reason: 'Cancelled by user.',
    });
    const replayed = reduceRuntimeState(cancelled, {
      type: 'tool.cancelled',
      toolCallId: 'tool-cancel',
      reason: 'Cancelled by user.',
    });

    expect(cancelled.interactions).toEqual({ kind: 'idle' });
    expect(cancelled.tools.calls['tool-cancel']!.status).toBe('cancelled');
    expect(cancelled.tools.queue).toEqual([]);
    expect(cancelled.transcript.messages.filter((message) => message.kind === 'tool')).toHaveLength(
      1,
    );
    expect(replayed).toEqual(cancelled);
  });

  test('tool.progress does not modify state', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.progress',
      toolCallId: 'tool-1',
      chunk: 'hello\n',
      stream: 'stdout',
    };

    const next = reduceRuntimeState(state, event);

    expect(next).toEqual(state);
  });
});

describe('reduceRuntimeState — suspended subagents', () => {
  test('subagent.suspended saves a snapshot for an existing task without changing its status', () => {
    const snapshot = makeSuspendedSubagentSnapshot();
    const state = queueTaskCall(makeInitialState());

    const next = reduceRuntimeState(state, {
      type: 'subagent.suspended',
      toolCallId: 'task-1',
      snapshot,
    });

    expect(next).toMatchObject({
      suspendedSubagents: { 'task-1': snapshot },
    });
    expect(next.tools.calls['task-1']!.status).toBe('queued');
  });

  test('subagent.suspended replaces the existing snapshot for the same task call', () => {
    const firstSnapshot = makeSuspendedSubagentSnapshot();
    const replacementSnapshot = makeSuspendedSubagentSnapshot({
      subagentId: 'subagent-2',
      blockedTool: {
        toolCallId: 'nested-tool-2',
        toolName: 'shell_execute',
        args: { command: 'git status' },
        command: 'git status',
      },
    });
    const suspended = reduceRuntimeState(queueTaskCall(makeInitialState()), {
      type: 'subagent.suspended',
      toolCallId: 'task-1',
      snapshot: firstSnapshot,
    });

    const next = reduceRuntimeState(suspended, {
      type: 'subagent.suspended',
      toolCallId: 'task-1',
      snapshot: replacementSnapshot,
    });

    expect(next).toMatchObject({
      suspendedSubagents: { 'task-1': replacementSnapshot },
    });
  });

  test('subagent.approval_deferred requeues a running suspended sibling', () => {
    const snapshot = makeSuspendedSubagentSnapshot();
    const running = reduceRuntimeState(queueTaskCall(makeInitialState()), {
      type: 'tool.started',
      toolCallId: 'task-1',
    });
    const suspended = reduceRuntimeState(running, {
      type: 'subagent.suspended',
      toolCallId: 'task-1',
      snapshot,
    });

    const next = reduceRuntimeState(suspended, {
      type: 'subagent.approval_deferred',
      toolCallId: 'task-1',
    });

    expect(next.tools.calls['task-1']!.status).toBe('queued');
    expect(next.tools.queue).toContain('task-1');
    expect(next.tools.active).not.toContain('task-1');
    expect(next.suspendedSubagents['task-1']).toEqual(snapshot);
  });

  test('subagent.suspended ignores an unknown or non-task tool call', () => {
    const snapshot = makeSuspendedSubagentSnapshot();
    const withNonTask = reduceRuntimeState(makeInitialState(), {
      type: 'tool.queued',
      toolCallId: 'shell-1',
      name: 'shell_execute',
      args: { command: 'pwd' },
    });

    const unknown = reduceRuntimeState(withNonTask, {
      type: 'subagent.suspended',
      toolCallId: 'missing-task',
      snapshot,
    });
    const nonTask = reduceRuntimeState(withNonTask, {
      type: 'subagent.suspended',
      toolCallId: 'shell-1',
      snapshot,
    });

    expect(unknown).not.toHaveProperty('suspendedSubagents.missing-task');
    expect(nonTask).not.toHaveProperty('suspendedSubagents.shell-1');
  });

  test.each([
    [
      'tool.finished',
      { name: 'task', result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' } },
    ],
    ['tool.failed', { error: 'failed' }],
    ['tool.rejected', { reason: 'rejected' }],
    ['tool.cancelled', { reason: 'cancelled' }],
  ] as const)('%s clears the suspended snapshot for its task call', (type, details) => {
    const snapshot = makeSuspendedSubagentSnapshot();
    const suspended = reduceRuntimeState(queueTaskCall(makeInitialState()), {
      type: 'subagent.suspended',
      toolCallId: 'task-1',
      snapshot,
    });

    const next = reduceRuntimeState(suspended, {
      type,
      toolCallId: 'task-1',
      ...details,
    } as RuntimeEvent);

    expect(next).toMatchObject({ suspendedSubagents: {} });
  });

  test('approval.rejected clears the suspended snapshot for its task call', () => {
    const snapshot = makeSuspendedSubagentSnapshot();
    const suspended = reduceRuntimeState(queueTaskCall(makeInitialState()), {
      type: 'subagent.suspended',
      toolCallId: 'task-1',
      snapshot,
    });
    const awaitingApproval: RuntimeState = {
      ...suspended,
      tools: {
        ...suspended.tools,
        calls: {
          ...suspended.tools.calls,
          'task-1': {
            ...suspended.tools.calls['task-1']!,
            status: 'awaiting_approval',
          },
        },
      },
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'task-1',
        approval: makeToolApproval('pwd'),
      },
    };

    const next = reduceRuntimeState(awaitingApproval, {
      type: 'approval.rejected',
      interactionId: 'approval-1',
      toolCallId: 'task-1',
      reason: 'Cancelled by user.',
    });

    expect(next.suspendedSubagents).toEqual({});
    expect(next.tools.calls['task-1']?.status).toBe('rejected');
    expect(next.interactions).toEqual({ kind: 'idle' });
  });

  test('tool.finished clears only the matching stale task approval interaction and legacy marker', () => {
    const snapshot = makeSuspendedSubagentSnapshot();
    const state = {
      ...queueTaskCall(makeInitialState()),
      interactions: {
        kind: 'awaiting_tool_approval' as const,
        interactionId: 'approval-1',
        toolCallId: 'task-1',
        approval: makeToolApproval('pwd'),
      },
      suspendedSubagents: { 'task-1': snapshot },
      legacyUnrecoverableSubagentApproval: {
        toolCallId: 'task-1',
        subagentId: snapshot.subagentId,
        reason: 'legacy approval cannot be resumed',
      },
    };

    const next = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'task-1',
      name: 'task',
      result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
    });

    expect(next.interactions).toEqual({ kind: 'idle' });
    expect(next).not.toHaveProperty('legacyUnrecoverableSubagentApproval');
    expect(next).toMatchObject({ suspendedSubagents: {} });
  });

  test('tool.finished leaves an unrelated approval interaction and legacy marker intact', () => {
    const snapshot = makeSuspendedSubagentSnapshot();
    const state = {
      ...queueTaskCall(makeInitialState()),
      interactions: {
        kind: 'awaiting_tool_approval' as const,
        interactionId: 'approval-2',
        toolCallId: 'other-task',
        approval: makeToolApproval('git status'),
      },
      suspendedSubagents: { 'task-1': snapshot },
      legacyUnrecoverableSubagentApproval: {
        toolCallId: 'other-task',
        subagentId: 'subagent-other',
        reason: 'legacy approval cannot be resumed',
      },
    };

    const next = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'task-1',
      name: 'task',
      result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
    });

    expect(next.interactions).toEqual(state.interactions);
    expect(next).toMatchObject({
      legacyUnrecoverableSubagentApproval: state.legacyUnrecoverableSubagentApproval,
      suspendedSubagents: {},
    });
  });
});

// ── 交互状态 / Interaction state ──

describe('reduceRuntimeState — interaction state', () => {
  // 验证 user_input.requested 设置 awaiting_user_input 交互
  test('user_input.requested sets awaiting_user_input interaction', () => {
    const state = makeInitialState();
    const requestPayload = {
      question: 'Which file should I edit?',
      options: [{ id: '1', label: 'file A' }],
      allow_free_text: true,
    };
    const event: RuntimeEvent = {
      type: 'user_input.requested',
      interactionId: 'ui-1',
      toolCallId: 'ask-1',
      request: requestPayload,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('awaiting_user_input');
    if (next.interactions.kind === 'awaiting_user_input') {
      expect(next.interactions.interactionId).toBe('ui-1');
      expect(next.interactions.toolCallId).toBe('ask-1');
      expect(next.interactions.request).toBe(requestPayload);
    }
  });

  // 验证 user_input.answered 清除交互回 idle
  test('user_input.answered clears interaction back to idle', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'ui-1',
        toolCallId: 'ask-1',
        request: {
          question: 'Q?',
          options: [],
          allow_free_text: true,
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'user_input.answered',
      interactionId: 'ui-1',
      toolCallId: 'ask-1',
      answer: 'file A',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('idle');
  });

  test('user_input.cancelled requires both interaction and tool identity', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'ui-1',
        toolCallId: 'ask-1',
        request: { question: 'Q?', options: [], allow_free_text: true },
      },
    };
    expect(
      reduceRuntimeState(state, {
        type: 'user_input.cancelled',
        interactionId: 'ui-1',
        toolCallId: 'ask-other',
        reason: 'user_cancelled',
      }),
    ).toBe(state);
    expect(
      reduceRuntimeState(state, {
        type: 'user_input.cancelled',
        interactionId: 'ui-1',
        toolCallId: 'ask-1',
        reason: 'user_cancelled',
      }).interactions.kind,
    ).toBe('idle');
  });

  test('a mismatched user_input answer cannot resolve the active interaction', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'ui-original',
        toolCallId: 'ask-1',
        request: { question: 'Q?', options: [], allow_free_text: true },
      },
    };

    const next = reduceRuntimeState(state, {
      type: 'user_input.answered',
      interactionId: 'ui-replayed',
      toolCallId: 'ask-1',
      answer: 'answer',
    });

    expect(next).toBe(state);
  });

  // 验证 approval.requested 设置 awaiting_tool_approval 交互
  test('approval.requested sets awaiting_tool_approval interaction', () => {
    const state = makeInitialState();
    const approvalPayload = {
      scope: 'once' as const,
      cwd: '/tmp',
      threadId: 'thread-1',
      tool: 'shell_execute',
      command: 'npm install',
      risk: 'execute_code' as const,
      approvalHash: 'abc123',
      summary: 'Run npm install in /tmp',
      reason: 'Model wants to install dependencies',
      expectedEffects: ['Installs npm packages'],
      grantOptions: ['approve_once' as const],
      recommendedGrant: 'approve_once' as const,
    };
    const event: RuntimeEvent = {
      type: 'approval.requested',
      interactionId: 'approval-1',
      toolCallId: 'tool-10',
      approval: approvalPayload,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('awaiting_tool_approval');
    if (next.interactions.kind === 'awaiting_tool_approval') {
      expect(next.interactions.interactionId).toBe('approval-1');
      expect(next.interactions.toolCallId).toBe('tool-10');
      expect(next.interactions.approval).toBe(approvalPayload);
    }
  });

  // 验证 approval.granted 清除交互回 idle
  test('approval.granted clears interaction back to idle', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'tool-10',
        approval: {
          scope: 'once',
          cwd: '/tmp',
          threadId: 'thread-1',
          tool: 'shell_execute',
          command: 'npm install',
          risk: 'execute_code' as const,
          approvalHash: 'abc',
          summary: 'install',
          reason: 'need deps',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'approval.granted',
      interactionId: 'approval-1',
      toolCallId: 'tool-10',
      grant: 'approve_once',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 approval.rejected 清除交互回 idle
  test('approval.rejected clears interaction back to idle', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-2',
        toolCallId: 'tool-11',
        approval: {
          scope: 'once',
          cwd: '/tmp',
          threadId: 'thread-1',
          tool: 'shell_execute',
          command: 'rm -rf /',
          risk: 'destructive' as const,
          approvalHash: 'xyz',
          summary: 'delete all',
          reason: 'cleanup',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'approval.rejected',
      interactionId: 'approval-2',
      toolCallId: 'tool-11',
      reason: 'too dangerous',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('idle');
  });
});

// ── 不可变性 / Immutability ──

describe('reduceRuntimeState — immutability', () => {
  // 验证 reduce 不修改原始状态
  test('original state is unchanged after reduce', () => {
    const state = makeInitialState();
    const plan = makePlan('Immutable Plan', ['do x']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-imm',
      toolCallId: 'call-imm',
      plan,
      planSummary: 'Immutable plan summary',
    };

    const originalPlanKind = state.planning.kind;
    const originalInteractionKind = state.interactions.kind;

    reduceRuntimeState(state, event);

    expect(state.planning.kind).toBe(originalPlanKind);
    expect(state.interactions.kind).toBe(originalInteractionKind);
  });

  // 验证 tool 操作不修改原始 calls/queue/active 对象
  test('tool operations do not mutate original calls/queue/active', () => {
    const state = makeInitialState();
    const originalCalls = state.tools.calls;
    const originalQueue = state.tools.queue;
    const originalActive = state.tools.active;

    const queued: RuntimeEvent = {
      type: 'tool.queued',
      toolCallId: 'tool-mut',
      name: 'read_file',
      args: { path: 'test.txt' },
    };
    const s1 = reduceRuntimeState(state, queued);
    expect(state.tools.calls).toBe(originalCalls);
    expect(state.tools.queue).toBe(originalQueue);
    expect(Object.keys(state.tools.calls)).toHaveLength(0);
    expect(state.tools.queue).toHaveLength(0);

    const started: RuntimeEvent = {
      type: 'tool.started',
      toolCallId: 'tool-mut',
    };
    const callsBeforeStart = s1.tools.calls;
    const queueBeforeStart = s1.tools.queue;
    const s2 = reduceRuntimeState(s1, started);
    expect(s1.tools.calls).toBe(callsBeforeStart);
    expect(s1.tools.queue).toBe(queueBeforeStart);
    expect(s1.tools.calls['tool-mut']!.status).toBe('queued');

    const finished: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'tool-mut',
      name: 'test-tool',
      result: { ok: true, command: 'cat test.txt', exitCode: 0, stdout: '', stderr: '' },
    };
    const activeBeforeFinish = s2.tools.active;
    const s3 = reduceRuntimeState(s2, finished);
    expect(s2.tools.active).toBe(activeBeforeFinish);
    expect(s2.tools.active).toContain('tool-mut');

    expect(state.tools.active).toBe(originalActive);
    expect(s3.tools.calls['tool-mut']!.status).toBe('succeeded');
  });

  // 验证多次 reduce 链的不可变性
  test('each reduce step returns a new state object', () => {
    const state = makeInitialState();

    const e1: RuntimeEvent = {
      type: 'user_input.requested',
      interactionId: 'chain-1',
      toolCallId: 'chain-tool',
      request: {
        question: 'Chain Q?',
        options: [],
        allow_free_text: true,
      },
    };
    const s1 = reduceRuntimeState(state, e1);
    expect(s1).not.toBe(state);
    expect(s1.interactions).not.toBe(state.interactions);
    expect(s1.planning).toBe(state.planning); // planning 未变，结构共享

    const e2: RuntimeEvent = {
      type: 'user_input.answered',
      interactionId: 'chain-1',
      toolCallId: 'chain-tool',
      answer: 'chain answer',
    };
    const s2 = reduceRuntimeState(s1, e2);
    expect(s2).not.toBe(s1);
    expect(s2.interactions).not.toBe(s1.interactions);
  });
});

// ── 运行时环境 / Runtime environment ──

describe('reduceRuntimeState — runtime environment', () => {
  // 验证 authorization.changed 更新授权模式
  test('authorization.changed updates authorization mode', () => {
    const state = makeInitialState();
    expect(state.authorization.mode).toBe('default');

    const event: RuntimeEvent = {
      type: 'authorization.changed',
      mode: 'full_access',
    };

    const next = reduceRuntimeState(state, event);
    expect(next.authorization.mode).toBe('full_access');
  });

  // 验证 authorization.changed 保留 commandGrants 等字段
  test('authorization.changed preserves other authorization fields', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      authorization: {
        mode: 'default',
        commandGrants: {
          key1: {
            workspace: '/ws',
            threadId: 't1',
            command: 'ls',
            source: 'test' as const,
            grantedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'authorization.changed',
      mode: 'full_access',
    };

    const next = reduceRuntimeState(state, event);
    expect(next.authorization.mode).toBe('full_access');
    expect(next.authorization.commandGrants.key1).toBeDefined();
    expect(next.authorization.commandGrants.key1!.command).toBe('ls');
  });

  test('authorization.changed can persist replacement command grants', () => {
    const state = makeInitialState();
    const next = reduceRuntimeState(state, {
      type: 'authorization.changed',
      mode: 'default',
      commandGrants: {
        cmd: {
          workspace: '/ws',
          threadId: 'thread-1',
          command: 'bun test',
          source: 'test' as const,
          grantedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    expect(next.authorization.commandGrants.cmd!.command).toBe('bun test');
  });
});

// ── Turn 生命周期 / Turn lifecycle ──

describe('reduceRuntimeState — turn lifecycle', () => {
  // 验证 turn.started 更新 turnId 和递增 turnIndex
  test('turn.started advances turnId and turnIndex', () => {
    const state = makeInitialState();
    const oldTurnId = state.turn.turnId;
    const oldTurnIndex = state.turn.turnIndex;
    const event: RuntimeEvent = {
      type: 'turn.started',
      turnId: 'turn-new',
    };
    const next = reduceRuntimeState(state, event);
    expect(next.turn.turnId).toBe('turn-new');
    expect(next.turn.turnIndex).toBe(oldTurnIndex + 1);
    expect(next.turn.turnId).not.toBe(oldTurnId);
  });

  test('turn.completed durably closes the current turn', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'turn.completed',
      turnId: state.turn.turnId,
    };
    const next = reduceRuntimeState(state, event);
    expect(next.turn).toEqual({ ...state.turn, status: 'completed' });
  });

  test('turn.aborted durably closes the current turn with diagnostics', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason: 'user cancelled',
      cause: 'user',
    };
    const next = reduceRuntimeState(state, event);
    expect(next.turn).toEqual({
      ...state.turn,
      status: 'aborted',
      abortReason: 'user cancelled',
      abortCause: 'user',
    });
  });

  test('stale turn terminal events cannot close a newer turn', () => {
    const state = makeInitialState();
    const next = reduceRuntimeState(state, {
      type: 'turn.aborted',
      turnId: 'older-turn',
      reason: 'late cancellation',
      cause: 'user',
    });
    expect(next).toBe(state);
  });
});

// ── 用户消息 / User messages ──

describe('reduceRuntimeState — user messages', () => {
  test('user.message_appended persists transcript content', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'user.message_appended',
      messageId: 'msg-1',
      content: 'Hello, can you help?',
    };
    const next = reduceRuntimeState(state, event);
    expect(next.transcript.messages).toEqual([
      expect.objectContaining({
        kind: 'user',
        messageId: 'msg-1',
        turnId: state.turn.turnId,
        ordinal: 0,
        createdAt: '1970-01-01T00:00:00.000Z',
        content: 'Hello, can you help?',
      }),
    ]);
  });
});

describe('PR 3 — structured transcript and tool result metadata', () => {
  test('persists structured tool facts without decoding stdout', () => {
    let state = makeInitialState();
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'read-1',
      modelMessageId: 'model-1',
      name: 'read_file',
      args: { path: 'src/main.ts' },
    });

    const next = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'read-1',
      name: 'read_file',
      createdAt: '2026-07-20T08:00:00.000Z',
      result: {
        ok: true,
        command: 'read_file',
        exitCode: 0,
        stdout: 'plain file content, not JSON',
        stderr: '',
        totalLines: 42,
        resultMeta: { resourceRevision: 'sha256:resource-1' },
      },
    });

    expect(next.tools.calls['read-1']?.result?.resultMeta).toMatchObject({
      path: 'src/main.ts',
      totalLines: 42,
      command: 'read_file',
      resourceRevision: 'sha256:resource-1',
    });
    expect(next.tools.calls['read-1']?.result?.resultMeta?.contentDigest).toHaveLength(64);
    expect(next.transcript.messages.at(-1)).toMatchObject({
      kind: 'tool',
      messageId: 'tool-read-1',
      turnId: state.turn.turnId,
      ordinal: 0,
      createdAt: '2026-07-20T08:00:00.000Z',
      resultMeta: {
        path: 'src/main.ts',
        totalLines: 42,
        resourceRevision: 'sha256:resource-1',
      },
    });
  });

  test('records workspace mutation scope from authoritative tool args', () => {
    let state = makeInitialState();
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'edit-1',
      modelMessageId: 'model-1',
      name: 'edit_file',
      args: { path: 'src/main.ts', old_string: 'a', new_string: 'b' },
    });
    const next = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'edit-1',
      name: 'edit_file',
      result: {
        ok: true,
        command: 'edit_file',
        exitCode: 0,
        stdout: 'updated',
        stderr: '',
      },
    });
    expect(next.tools.calls['edit-1']?.result?.resultMeta?.workspaceMutationScope).toEqual([
      'src/main.ts',
    ]);
  });
});

// ── 模型交互 / Model interaction ──

describe('reduceRuntimeState — model interaction', () => {
  // 验证 model.requested 不修改状态（信息性事件）
  test('model.requested does not modify state', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'model.requested',
      requestId: 'req-1',
    };
    const next = reduceRuntimeState(state, event);
    expect(next).toEqual(state);
  });

  test('model.responded persists assistant content and final text', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'model.responded',
      messageId: 'msg-2',
      text: 'I will help you with that task.',
    };
    const next = reduceRuntimeState(state, event);
    expect(next.transcript.final).toBe('I will help you with that task.');
    expect(next.transcript.messages[0]).toMatchObject({
      kind: 'assistant',
      messageId: 'msg-2',
      content: 'I will help you with that task.',
      toolCalls: [],
    });
  });

  test('model.responded persists tool calls without final text', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'model.responded',
      messageId: 'msg-3',
      toolCalls: [
        { id: 'call-1', name: 'read_file', args: { path: 'test.txt' } },
        { id: 'call-2', name: 'shell_execute', args: { command: 'ls' } },
      ],
    };
    const next = reduceRuntimeState(state, event);
    expect(next.transcript.final).toBeUndefined();
    expect(next.transcript.messages[0]).toMatchObject({
      kind: 'assistant',
      messageId: 'msg-3',
      toolCalls: event.toolCalls,
    });
  });
});

// ── Plan 生命周期补充 / Additional plan lifecycle ──

describe('reduceRuntimeState — plan lifecycle supplements', () => {
  // 验证 plan.drafted 从 none 状态创建 drafted
  test('plan.drafted is no-op when planning is building_without_plan', () => {
    const state = makeInitialState();
    const plan = makePlan('Wont Apply', ['step']);
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-draft-0',
      planId: 'plan-nop',
      version: 1,
      plan,
      structuralHash: computePlanStructuralDigest(planToDigestInput(plan)),
    };

    const next = reduceRuntimeState(state, event);
    expect(next.planning.kind).toBe('building_without_plan');
  });

  test('plan.drafted uses event planId and version from tool-controller', () => {
    const state: RuntimeState = { ...makeInitialState(), planning: { kind: 'planning_empty' } };
    const plan = makePlan('Draft Plan', ['step a', 'step b']);
    const structuralHash = computePlanStructuralDigest(planToDigestInput(plan));
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-draft-1',
      planId: 'plan-from-tc',
      version: 1,
      plan,
      structuralHash,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('planning_draft');
    if (next.planning.kind === 'planning_draft') {
      expect(next.planning.document.planId).toBe('plan-from-tc');
      expect(next.planning.document.version).toBe(1);
      expect(next.planning.document.title).toBe(plan.name);
      expect(next.planning.document.bodyMarkdown).toBe(plan.description);
      expect(next.planning.document.steps).toHaveLength(plan.steps.length);
      expect(next.planning.document.structuralDigest).toBe(structuralHash);
    }
  });

  test('V2 plan.drafted replay rejects content whose digest does not match the event', () => {
    const state: RuntimeState = { ...makeInitialState(), planning: { kind: 'planning_empty' } };
    const plan = makePlan('Trusted Draft', ['trusted step']);
    const eventDigest = 'f'.repeat(64);
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'forged-draft-digest',
      planId: 'trusted-draft-id',
      version: 1,
      planSchemaVersion: 2,
      plan,
      structuralHash: eventDigest,
      artifact: {
        artifactId: 'trusted-draft-id:v1',
        taskId: 'draft-task',
        planId: 'trusted-draft-id',
        version: 1,
        fileName: 'v1.md',
        relativePath: 'plans/draft-task/trusted-draft-id/v1.md',
        displayPath: '/plans/draft-task/trusted-draft-id/v1.md',
        structuralDigest: eventDigest,
        byteLength: 100,
      },
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 plan.drafted replay rejects a missing Artifact reference', () => {
    const state: RuntimeState = { ...makeInitialState(), planning: { kind: 'planning_empty' } };
    const plan = makePlan('Trusted Draft', ['trusted step']);
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'missing-draft-artifact',
      planId: 'trusted-draft-id',
      version: 1,
      planSchemaVersion: 2,
      plan,
      structuralHash: computePlanStructuralDigest(planToDigestInput(plan)),
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test.each([
    ['short body', { ...makePlan('Malformed Draft', ['step']), description: 'too short' }],
    ['multiline title', { ...makePlan('Malformed Draft', ['step']), name: 'Malformed\nDraft' }],
    [
      'duplicate step ids',
      {
        ...makePlan('Malformed Draft', ['first', 'second']),
        steps: [
          { id: 'duplicate', step: 'first', status: 'pending' as const },
          { id: 'duplicate', step: 'second', status: 'pending' as const },
        ],
      },
    ],
    [
      'an illegal step id',
      {
        ...makePlan('Malformed Draft', ['first']),
        steps: [{ id: 'Not Safe', step: 'first', status: 'pending' as const }],
      },
    ],
    [
      'an unknown step status',
      {
        ...makePlan('Malformed Draft', ['first']),
        steps: [{ id: 'first', step: 'first', status: 'running' as never }],
      },
    ],
    [
      'too many steps',
      makePlan(
        'Malformed Draft',
        Array.from({ length: 13 }, (_, index) => `step ${index + 1}`),
      ),
    ],
    [
      'a top-level extra key',
      {
        ...makePlan('Malformed Draft', ['first']),
        steps: [{ id: 'first', step: 'first', status: 'pending' as const }],
        extra: 'not allowed',
      } as unknown as AgentPlan,
    ],
    [
      'a step command key',
      {
        ...makePlan('Malformed Draft', ['first']),
        steps: [{ id: 'first', step: 'first', status: 'pending' as const, command: 'bun test' }],
      } as unknown as AgentPlan,
    ],
    [
      'a step path key',
      {
        ...makePlan('Malformed Draft', ['first']),
        steps: [{ id: 'first', step: 'first', status: 'pending' as const, path: '/secret' }],
      } as unknown as AgentPlan,
    ],
    [
      'a step stdout key',
      {
        ...makePlan('Malformed Draft', ['first']),
        steps: [{ id: 'first', step: 'first', status: 'pending' as const, stdout: 'secret' }],
      } as unknown as AgentPlan,
    ],
    ['empty steps', { ...makePlan('Malformed Draft', ['step']), steps: [] }],
  ] as Array<[string, AgentPlan]>)('V2 plan.drafted replay rejects %s', (_label, plan) => {
    const state: RuntimeState = { ...makeInitialState(), planning: { kind: 'planning_empty' } };
    const structuralHash = computePlanStructuralDigest({
      title: plan.name.slice(0, 120),
      bodyMarkdown: plan.description,
      steps: plan.steps.map((step) => ({
        id: step.id ?? sanitizeStepId(step.step),
        title: step.step.slice(0, 160),
        status: step.status,
      })),
    });
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'malformed-v2-draft',
      planId: 'malformed-v2-plan',
      version: 1,
      planSchemaVersion: 2,
      plan,
      structuralHash,
      artifact: {
        artifactId: 'malformed-v2-plan:v1',
        taskId: 'malformed-task',
        planId: 'malformed-v2-plan',
        version: 1,
        fileName: 'v1.md',
        relativePath: 'plans/malformed-task/malformed-v2-plan/v1.md',
        displayPath: '/plans/malformed-task/malformed-v2-plan/v1.md',
        structuralDigest: structuralHash,
        byteLength: 100,
      },
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 plan.drafted replay rejects an Artifact not bound to the document identity', () => {
    const state: RuntimeState = { ...makeInitialState(), planning: { kind: 'planning_empty' } };
    const plan = makePlan('Trusted Draft', ['trusted step']);
    const structuralHash = computePlanStructuralDigest(planToDigestInput(plan));
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'forged-draft-artifact',
      planId: 'trusted-draft-id',
      version: 1,
      planSchemaVersion: 2,
      plan,
      structuralHash,
      artifact: {
        artifactId: 'substituted-plan:v1',
        taskId: 'draft-task',
        planId: 'substituted-plan',
        version: 1,
        fileName: 'v1.md',
        relativePath: 'plans/draft-task/substituted-plan/v1.md',
        displayPath: '/plans/draft-task/substituted-plan/v1.md',
        structuralDigest: structuralHash,
        byteLength: 100,
      },
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 plan.drafted replay rejects a forged replanning version and revision anchor', () => {
    const plan = makePlan('Anchored Replan', ['trusted step']);
    const document = {
      ...makeV2PlanDoc(plan, { planId: 'anchored-replan', version: 1 }),
      supersedesPlanVersion: 1,
      replanReason: 'expected',
    };
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'replanning_draft',
        document,
        supersedesPlanVersion: 1,
        replanReason: 'expected',
      },
    };
    const eventPlan: AgentPlan = {
      name: document.title,
      description: document.bodyMarkdown,
      status: 'pending',
      steps: document.steps.map((step) => ({
        id: step.id,
        step: step.title,
        status: 'pending',
      })),
    };
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'forged-replan-anchor',
      planId: document.planId,
      version: 3,
      planSchemaVersion: 2,
      plan: eventPlan,
      structuralHash: document.structuralDigest,
      supersedesPlanVersion: 2,
      replanReason: 'forged',
      artifact: {
        artifactId: `${document.planId}:v3`,
        taskId: 'replan-task',
        planId: document.planId,
        version: 3,
        fileName: 'v3.md',
        relativePath: `plans/replan-task/${document.planId}/v3.md`,
        displayPath: `/plans/replan-task/${document.planId}/v3.md`,
        structuralDigest: document.structuralDigest,
        byteLength: 100,
      },
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 plan.drafted replay rejects version skips and replan metadata injection in a draft', () => {
    const plan = makePlan('Versioned Draft', ['trusted step']);
    const document = makeV2PlanDoc(plan, { planId: 'versioned-draft', version: 2 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: { kind: 'planning_draft', document },
    };
    const eventPlan: AgentPlan = {
      name: document.title,
      description: document.bodyMarkdown,
      status: 'pending',
      steps: document.steps.map((step) => ({
        id: step.id,
        step: step.title,
        status: 'pending',
      })),
    };
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'forged-draft-revision',
      planId: document.planId,
      version: 4,
      planSchemaVersion: 2,
      plan: eventPlan,
      structuralHash: document.structuralDigest,
      supersedesPlanVersion: 2,
      replanReason: 'injected',
      artifact: {
        artifactId: `${document.planId}:v4`,
        taskId: 'draft-task',
        planId: document.planId,
        version: 4,
        fileName: 'v4.md',
        relativePath: `plans/draft-task/${document.planId}/v4.md`,
        displayPath: `/plans/draft-task/${document.planId}/v4.md`,
        structuralDigest: document.structuralDigest,
        byteLength: 100,
      },
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  // 验证 plan.drafted 使用事件中的 planId 和 version（由 tool-controller 提供）
  test('plan.drafted uses event planId and version on revision', () => {
    const oldPlan = makePlan('Old Draft', ['old step']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'planning_draft',
        document: makePlanDoc(oldPlan, { planId: 'existing-plan', version: 3 }),
        revisionFeedback: 'too vague',
      },
    };
    const newPlan = makePlan('Revised Draft', ['step x', 'step y', 'step z']);
    const structuralHash = computePlanStructuralDigest(planToDigestInput(newPlan));
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-draft-2',
      planId: 'existing-plan',
      version: 4,
      plan: newPlan,
      structuralHash,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('planning_draft');
    if (next.planning.kind === 'planning_draft') {
      expect(next.planning.document.planId).toBe('existing-plan');
      expect(next.planning.document.version).toBe(4);
      expect(next.planning.document.title).toBe(newPlan.name);
      expect(next.planning.document.structuralDigest).toBe(structuralHash);
    }
  });

  // 验证 plan.drafted 在 executing 状态下不操作
  test('plan.drafted is no-op when plan is executing', () => {
    const plan = makePlan('Approved Plan', ['done step']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document: makePlanDoc(plan, { planId: 'plan-approved', version: 1 }),
        executionMode: 'auto',
        approvedAtTurnId: 'turn-1',
      },
    };
    const newPlan = makePlan('Should Not Apply', ['new step']);
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-draft-3',
      planId: 'should-not-apply',
      version: 99,
      plan: newPlan,
      structuralHash: computePlanStructuralDigest(planToDigestInput(newPlan)),
    };

    const next = reduceRuntimeState(state, event);
    expect(next.planning.kind).toBe('executing');
  });

  // 验证 plan.progress_updated 在 building 状态下更新 plan
  test('plan.progress_updated updates steps when in executing state', () => {
    const oldPlan = makePlan('Building Plan', ['step 1', 'step 2']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document: makePlanDoc(oldPlan, { planId: 'plan-building', version: 2 }),
        executionMode: 'accept_edits',
        approvedAtTurnId: 'turn-0',
      },
    };
    const updatedPlan: AgentPlan = {
      ...oldPlan,
      steps: [
        { step: 'step 1', status: 'completed' },
        { step: 'step 2', status: 'pending' },
      ],
    };
    const event: RuntimeEvent = {
      type: 'plan.progress_updated',
      toolCallId: 'call-progress-1',
      plan: updatedPlan,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('executing');
    if (next.planning.kind === 'executing') {
      const step1 = next.planning.document.steps.find(
        (s: { id: string }) => s.id === sanitizeStepId('step 1'),
      );
      expect(step1).toBeDefined();
      expect(step1!.status).toBe('completed');
      expect(next.planning.document.planId).toBe('plan-building');
      expect(next.planning.document.version).toBe(2);
    }
  });

  test('V1 progress replay ignores supplied completion evidence', () => {
    const plan = makePlan('Legacy Plan', ['legacy step']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document: makePlanDoc(plan, { planId: 'legacy-plan', version: 1 }),
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.progress_updated',
      toolCallId: 'legacy-progress',
      plan: {
        ...plan,
        steps: [{ id: 'legacy-step', step: 'legacy step', status: 'completed' }],
      },
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [{ toolCallId: 'forged-tool-reference', outcome: 'succeeded' }],
        skipped: [],
        unresolved: [],
      },
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('executing');
    if (next.planning.kind === 'executing') {
      expect(next.planning.document.steps[0]?.status).toBe('completed');
      expect(next.planning.document.completionEvidence).toBeUndefined();
    }
  });

  test('V2 progress replay cannot roll a terminal step back to pending', () => {
    const plan = makePlan('Monotonic Plan', ['terminal step']);
    plan.steps[0]!.status = 'completed';
    const document = makeV2PlanDoc(plan, { planId: 'monotonic-plan', version: 2 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.progress_updated',
      toolCallId: 'rollback-progress',
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan: {
        ...plan,
        steps: [{ id: 'terminal-step', step: 'terminal step', status: 'pending' }],
      },
      completionEvidence: document.completionEvidence,
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test.each([
    [
      'unknown status',
      (plan: AgentPlan): void => {
        plan.steps[0]!.status = 'bogus' as never;
      },
    ],
    [
      'duplicate step id',
      (plan: AgentPlan): void => {
        plan.steps[1]!.id = plan.steps[0]!.id;
      },
    ],
    [
      'missing step id',
      (plan: AgentPlan): void => {
        delete plan.steps[0]!.id;
      },
    ],
    [
      'unknown step id',
      (plan: AgentPlan): void => {
        plan.steps[0]!.id = 'unknown-step';
      },
    ],
    [
      'top-level extra key',
      (plan: AgentPlan): void => {
        Object.assign(plan, { stdout: 'secret' });
      },
    ],
    [
      'step extra key',
      (plan: AgentPlan): void => {
        Object.assign(plan.steps[0]!, { command: 'pwd' });
      },
    ],
  ] as const)('V2 progress replay rejects malformed transport: %s', (_label, mutate) => {
    const original = makePlan('Strict Progress Plan', ['first step', 'second step']);
    const document = makeV2PlanDoc(original, { planId: 'strict-progress', version: 2 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
    };
    const transport: AgentPlan = {
      name: document.title,
      description: document.bodyMarkdown,
      status: 'in_progress',
      steps: document.steps.map((step) => ({
        id: step.id,
        step: step.title,
        status: step.status,
      })),
    };
    mutate(transport);

    expect(
      reduceRuntimeState(state, {
        type: 'plan.progress_updated',
        toolCallId: 'malformed-progress',
        planId: document.planId,
        version: document.version,
        structuralDigest: document.structuralDigest,
        plan: transport,
        completionEvidence: document.completionEvidence,
      }),
    ).toBe(state);
  });

  // 验证 plan.progress_updated 在非 building 状态时不操作
  test('plan.progress_updated is no-op when plan is not executing', () => {
    const state = makeInitialState(); // planning.kind === 'building_without_plan'
    const updatedPlan = makePlan('Should Not Apply', ['fake step']);
    const event: RuntimeEvent = {
      type: 'plan.progress_updated',
      toolCallId: 'call-progress-2',
      plan: updatedPlan,
    };

    const next = reduceRuntimeState(state, event);
    expect(next.planning.kind).toBe('building_without_plan');
  });

  // 验证 plan.completed 从 building 转为 completed
  test('plan.completed transitions from executing to completed', () => {
    const plan = makePlan('Build Plan', ['step 1', 'step 2']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document: makePlanDoc(plan, { planId: 'plan-bld', version: 1 }),
        executionMode: 'accept_edits',
        approvedAtTurnId: 'turn-0',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'call-done-1',
      plan,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('completed');
    if (next.planning.kind === 'completed') {
      expect(next.planning.document.planId).toBe('plan-bld');
      expect(next.planning.document.version).toBe(1);
      expect(next.planning.completedAtTurnId).toBe(state.turn.turnId);
    }
  });

  test('V2 completed replay rejects pending required verification', () => {
    const plan = makePlan('Verification Plan', ['verified step']);
    plan.status = 'completed';
    plan.steps[0]!.status = 'completed';
    const document = makeV2PlanDoc(plan, { planId: 'verification-plan', version: 3 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
      verification: {
        records: {
          required: {
            verificationId: 'required',
            mode: 'required',
            status: 'pending',
            spec: {} as never,
            requestedAt: '2026-08-10T00:00:00.000Z',
            attempts: 0,
            repairAttempts: 0,
            checkResults: {},
          },
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'complete-without-verification',
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan,
      completionEvidence: document.completionEvidence,
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 completed replay rejects a plan with a pending step', () => {
    const plan = makePlan('Incomplete Plan', ['completed step', 'pending step']);
    plan.status = 'completed';
    plan.steps[0]!.status = 'completed';
    const document = makeV2PlanDoc(plan, { planId: 'incomplete-plan', version: 2 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'complete-with-pending-step',
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan,
      completionEvidence: document.completionEvidence,
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 completed replay rejects extra transport keys before merging', () => {
    const plan = makePlan('Strict Completed Plan', ['completed step']);
    const document = makeV2PlanDoc(plan, { planId: 'strict-completed', version: 2 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
    };
    const transport = {
      name: document.title,
      description: document.bodyMarkdown,
      status: 'completed',
      steps: document.steps.map((step) => ({
        id: step.id,
        step: step.title,
        status: 'completed' as const,
        path: '/private/path',
      })),
    } as unknown as AgentPlan;

    expect(
      reduceRuntimeState(state, {
        type: 'plan.completed',
        toolCallId: 'malformed-completed',
        planId: document.planId,
        version: document.version,
        structuralDigest: document.structuralDigest,
        plan: transport,
        completionEvidence: document.completionEvidence,
      }),
    ).toBe(state);
  });

  test('V2 completed replay rejects a side-effect-free pending approval interaction', () => {
    const plan = makePlan('Approval Blocked Plan', ['completed step']);
    const document = makeV2PlanDoc(plan, { planId: 'approval-blocked', version: 2 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
      tools: {
        calls: {
          'external-read': {
            toolCallId: 'external-read',
            modelMessageId: 'external-read-model',
            name: 'read_file',
            args: { path: '/outside/workspace.txt' },
            status: 'awaiting_approval',
            sideEffect: false,
            createdAtTurnId: 'turn-0',
          },
        },
        queue: ['external-read'],
        active: [],
      },
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'external-read-approval',
        toolCallId: 'external-read',
        approval: {} as never,
      },
    };
    const completedPlan: AgentPlan = {
      name: document.title,
      description: document.bodyMarkdown,
      status: 'completed',
      steps: document.steps.map((step) => ({
        id: step.id,
        step: step.title,
        status: 'completed',
      })),
    };

    expect(
      reduceRuntimeState(state, {
        type: 'plan.completed',
        toolCallId: 'complete-with-approval',
        planId: document.planId,
        version: document.version,
        structuralDigest: document.structuralDigest,
        plan: completedPlan,
        completionEvidence: document.completionEvidence,
      }),
    ).toBe(state);
  });

  test('V2 completed replay rejects a plan whose steps are all skipped', () => {
    const plan = makePlan('Skipped Plan', ['skipped step']);
    plan.status = 'completed';
    plan.steps[0]!.status = 'skipped';
    const document = makeV2PlanDoc(makePlan('Skipped Plan', ['skipped step']), {
      planId: 'all-skipped-plan',
      version: 2,
    });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'complete-all-skipped',
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan,
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [{ stepId: 'skipped-step', reasonCode: 'not_needed' }],
        unresolved: [],
      },
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  test('V2 completed replay rejects matching unresolved failure evidence', () => {
    const plan = makePlan('Blocked Plan', ['effect step']);
    plan.status = 'completed';
    plan.steps[0]!.status = 'completed';
    const document = makeV2PlanDoc(plan, { planId: 'blocked-plan', version: 4 });
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document,
        executionMode: 'auto',
        approvedAtTurnId: 'turn-0',
      },
      tools: {
        calls: {
          'failed-effect': {
            toolCallId: 'failed-effect',
            modelMessageId: 'model-failed-effect',
            name: 'write_file',
            args: { path: '<redacted>' },
            status: 'failed',
            createdAtTurnId: 'turn-0',
            sideEffect: true,
            error: 'private failure detail',
          },
        },
        queue: [],
        active: [],
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'complete-with-unresolved-failure',
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan,
      completionEvidence: {
        schemaVersion: 1,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [{ kind: 'failure', referenceId: 'failed-effect' }],
      },
    };

    expect(reduceRuntimeState(state, event)).toBe(state);
  });

  // 验证 plan.completed 从 approved 转为 completed
  test('plan.completed transitions from executing to completed (approved path)', () => {
    const plan = makePlan('Approved Plan', ['step a']);
    const state: RuntimeState = {
      ...makeInitialState(),
      planning: {
        kind: 'executing',
        document: makePlanDoc(plan, { planId: 'plan-app', version: 2 }),
        executionMode: 'auto',
        approvedAtTurnId: 'turn-5',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'call-done-2',
      plan,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.planning.kind).toBe('completed');
    if (next.planning.kind === 'completed') {
      expect(next.planning.document.planId).toBe('plan-app');
      expect(next.planning.document.version).toBe(2);
      expect(next.planning.completedAtTurnId).toBe(state.turn.turnId);
    }
  });

  // 验证 plan.completed 在 none/drafted/awaiting_review/needs_revision 状态下不操作
  test('plan.completed is no-op when planning is building_without_plan', () => {
    const state = makeInitialState(); // planning.kind === 'building_without_plan'
    const plan = makePlan('Cannot Complete', ['step']);
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'call-done-3',
      plan,
    };

    const next = reduceRuntimeState(state, event);
    expect(next.planning.kind).toBe('building_without_plan');
  });
});

// ── Approval 补充 / Additional approval ──

describe('reduceRuntimeState — approval supplements', () => {
  // 验证 approval.command_replaced 不修改状态（信息性事件）
  test('approval.command_replaced does not modify state', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'approval.command_replaced',
      interactionId: 'inter-cmd',
      command: 'npm test',
    };
    const next = reduceRuntimeState(state, event);
    expect(next).toEqual(state);
  });
});

// ── Auto-review 事件 / Auto-review events ──

describe('reduceRuntimeState — auto-review events', () => {
  test('auto_review.requested sets awaiting_auto_review interaction', () => {
    const state = makeInitialState();
    // Add a queued tool to the state first
    const withTool = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-99',
      name: 'shell_execute',
      args: { command: 'npm test' },
    });
    const approval: ToolApprovalPayload = {
      ...makeToolApproval('npm test'),
      reason: 'testing',
    };
    const event: RuntimeEvent = {
      type: 'auto_review.requested',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      toolName: 'shell_execute',
      reason: 'auto-review for tool approval',
      approval,
    };
    const next = reduceRuntimeState(withTool, event);
    expect(next.interactions.kind).toBe('awaiting_auto_review');
    if (next.interactions.kind === 'awaiting_auto_review') {
      expect(next.interactions.interactionId).toBe('rev-1');
      expect(next.interactions.toolCallId).toBe('tool-99');
      expect(next.interactions.toolName).toBe('shell_execute');
    }
    expect(next.tools.calls['tool-99']!.status).toBe('awaiting_auto_review');
  });

  test('auto_review.completed approves tool when ok and approved', () => {
    const state = makeInitialState();
    // Set up state as if auto_review.requested was already processed
    const approval: ToolApprovalPayload = {
      ...makeToolApproval('npm test'),
      reason: 'testing',
    };
    const withTool = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-99',
      name: 'shell_execute',
      args: { command: 'npm test' },
    });
    const awaiting = reduceRuntimeState(withTool, {
      type: 'auto_review.requested',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      toolName: 'shell_execute',
      reason: 'auto-review for tool approval',
      approval,
    });
    const event: RuntimeEvent = {
      type: 'auto_review.completed',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      result: {
        ok: true,
        approved: true,
        grant: 'approve_once',
        reason: 'safe command',
        reviewerModelName: 'haiku',
        durationMs: 1500,
      },
    };
    const next = reduceRuntimeState(awaiting, event);
    expect(next.interactions.kind).toBe('idle');
    expect(next.tools.calls['tool-99']!.status).toBe('approved');
    // Regression: approvalGrant must be set so defense-in-depth doesn't reject
    expect(next.tools.calls['tool-99']!.approvalGrant).toBe('approve_once');
    // Circuit breaker should reset on approval
    expect(next.autoReview.circuitBreakerTripped).toBe(false);
    expect(next.autoReview.consecutiveRejects).toBe(0);
  });

  test('legacy auto_review.completed rejects tool when not approved and not escalated', () => {
    const state = makeInitialState();
    const approval: ToolApprovalPayload = {
      ...makeToolApproval('npm test'),
      reason: 'testing',
    };
    const withTool = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-99',
      name: 'shell_execute',
      args: { command: 'npm test' },
    });
    const awaiting = reduceRuntimeState(withTool, {
      type: 'auto_review.requested',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      toolName: 'shell_execute',
      reason: 'auto-review for tool approval',
      approval,
    });
    const event: RuntimeEvent = {
      type: 'auto_review.completed',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      result: {
        ok: true,
        approved: false,
        reason: 'unsafe command',
        reviewerModelName: 'haiku',
        durationMs: 1200,
      },
    };
    const next = reduceRuntimeState(awaiting, event);
    expect(next.interactions.kind).toBe('idle');
    expect(next.tools.calls['tool-99']!.status).toBe('rejected');
    // Circuit breaker should increment on rejection
    expect(next.autoReview.consecutiveRejects).toBe(1);
    expect(next.autoReview.rejectionHistory).toHaveLength(1);
    expect(next.autoReview.rejectionHistory[0]!.toolName).toBe('shell_execute');
    expect(next.autoReview.circuitBreakerTripped).toBe(false); // not tripped yet (threshold=3)
  });

  test('auto-review rejection clears a suspended child continuation', () => {
    const withTask = queueTaskCall(makeInitialState(), 'task-auto');
    const approval: ToolApprovalPayload = {
      ...makeToolApproval('git add fixture.txt'),
      tool: 'shell_execute',
      subagentId: 'subagent-1',
    };
    const awaiting = reduceRuntimeState(withTask, {
      type: 'auto_review.requested',
      reviewId: 'review-child',
      toolCallId: 'task-auto',
      toolName: 'shell_execute',
      reason: 'review child command',
      approval,
    });
    const suspended = {
      ...awaiting,
      suspendedSubagents: { 'task-auto': makeSuspendedSubagentSnapshot() },
    };

    const next = reduceRuntimeState(suspended, {
      type: 'auto_review.completed',
      reviewId: 'review-child',
      toolCallId: 'task-auto',
      result: {
        ok: true,
        approved: false,
        reason: 'unsafe child command',
        reviewerModelName: 'reviewer',
        durationMs: 10,
      },
    });

    expect(next.tools.calls['task-auto']?.status).toBe('rejected');
    expect(next.suspendedSubagents['task-auto']).toBeUndefined();
  });

  test('auto-review risk decision remains non-terminal until user approval follows', () => {
    const state = makeInitialState();
    const approval: ToolApprovalPayload = { ...makeToolApproval('npm test'), reason: 'testing' };
    const withTool = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-risk',
      name: 'shell_execute',
      args: { command: 'npm test' },
    });
    const awaiting = reduceRuntimeState(withTool, {
      type: 'auto_review.requested',
      reviewId: 'rev-risk',
      toolCallId: 'tool-risk',
      toolName: 'shell_execute',
      reason: 'auto-review for tool approval',
      approval,
    });
    const reviewed = reduceRuntimeState(awaiting, {
      type: 'auto_review.completed',
      reviewId: 'rev-risk',
      toolCallId: 'tool-risk',
      result: {
        ok: true,
        approved: false,
        escalatedToUser: true,
        reason: 'risk requires user authorization',
        reviewerModelName: 'reviewer',
        durationMs: 50,
      },
    });
    expect(reviewed.interactions.kind).toBe('awaiting_auto_review');
    expect(reviewed.tools.calls['tool-risk']!.status).toBe('awaiting_auto_review');

    const escalated = reduceRuntimeState(reviewed, {
      type: 'approval.requested',
      interactionId: 'approval-after-risk',
      toolCallId: 'tool-risk',
      approval,
    });
    expect(escalated.interactions.kind).toBe('awaiting_tool_approval');
    expect(escalated.tools.calls['tool-risk']!.status).toBe('awaiting_approval');
  });

  test('auto_review technical failure remains non-terminal until approval.requested follows', () => {
    const state = makeInitialState();
    const approval: ToolApprovalPayload = { ...makeToolApproval('npm test'), reason: 'testing' };
    const withTool = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-technical',
      name: 'shell_execute',
      args: { command: 'npm test' },
    });
    const awaiting = reduceRuntimeState(withTool, {
      type: 'auto_review.requested',
      reviewId: 'rev-technical',
      toolCallId: 'tool-technical',
      toolName: 'shell_execute',
      reason: 'auto-review for tool approval',
      approval,
    });
    const failed = reduceRuntimeState(awaiting, {
      type: 'auto_review.completed',
      reviewId: 'rev-technical',
      toolCallId: 'tool-technical',
      result: {
        ok: false,
        approved: false,
        failureType: 'technical',
        reason: 'provider timeout',
        reviewerModelName: 'haiku',
        durationMs: 100,
      },
    });
    expect(failed.interactions.kind).toBe('awaiting_auto_review');
    expect(failed.tools.calls['tool-technical']!.status).toBe('awaiting_auto_review');

    const escalated = reduceRuntimeState(failed, {
      type: 'approval.requested',
      interactionId: 'approval-after-review-failure',
      toolCallId: 'tool-technical',
      approval,
    });
    expect(escalated.interactions.kind).toBe('awaiting_tool_approval');
    expect(escalated.tools.calls['tool-technical']!.status).toBe('awaiting_approval');
  });

  test('auto_review.completed ignores mismatched reviewId', () => {
    const state = makeInitialState();
    const approval: ToolApprovalPayload = {
      ...makeToolApproval('npm test'),
      reason: 'testing',
    };
    const withTool = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-99',
      name: 'shell_execute',
      args: { command: 'npm test' },
    });
    const awaiting = reduceRuntimeState(withTool, {
      type: 'auto_review.requested',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      toolName: 'shell_execute',
      reason: 'auto-review for tool approval',
      approval,
    });
    const event: RuntimeEvent = {
      type: 'auto_review.completed',
      reviewId: 'rev-2', // mismatched
      toolCallId: 'tool-99',
      result: {
        ok: true,
        approved: true,
        reason: 'ok',
        reviewerModelName: 'haiku',
        durationMs: 100,
      },
    };
    const next = reduceRuntimeState(awaiting, event);
    // Should NOT transition — interactionId mismatch
    expect(next.interactions.kind).toBe('awaiting_auto_review');
    expect(next.tools.calls['tool-99']!.status).toBe('awaiting_auto_review');
  });

  test('auto_review.completed ignores a mismatched tool identity', () => {
    const state = makeInitialState();
    const approval: ToolApprovalPayload = {
      ...makeToolApproval('npm test'),
      reason: 'testing',
    };
    const withTool = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'tool-99',
      name: 'shell_execute',
      args: { command: 'npm test' },
    });
    const awaiting = reduceRuntimeState(withTool, {
      type: 'auto_review.requested',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      toolName: 'shell_execute',
      reason: 'auto-review for tool approval',
      approval,
    });

    const next = reduceRuntimeState(awaiting, {
      type: 'auto_review.completed',
      reviewId: 'rev-1',
      toolCallId: 'other-tool',
      result: {
        ok: true,
        approved: false,
        reason: 'stale result',
        reviewerModelName: 'haiku',
        durationMs: 100,
      },
    });

    expect(next.interactions.kind).toBe('awaiting_auto_review');
    expect(next.tools.calls['tool-99']!.status).toBe('awaiting_auto_review');
  });

  test('circuit breaker trips after consecutive auto_review rejections', () => {
    const state = makeInitialState();
    const approval: ToolApprovalPayload = {
      ...makeToolApproval('cmd'),
      summary: 'Run cmd',
      reason: 'testing',
    };
    // Pre-set consecutive rejects at 2 (one below threshold of 3)
    const withRejectHistory: RuntimeState = {
      ...state,
      autoReview: { ...state.autoReview, consecutiveRejects: 2, rejectionHistory: [] },
    };
    const withTool = reduceRuntimeState(withRejectHistory, {
      type: 'tool.queued',
      toolCallId: 'tool-99',
      name: 'shell_execute',
      args: { command: 'cmd' },
    });
    const awaiting = reduceRuntimeState(withTool, {
      type: 'auto_review.requested',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      toolName: 'shell_execute',
      reason: 'test',
      approval,
    });
    // Third consecutive rejection → should trip
    const event: RuntimeEvent = {
      type: 'auto_review.completed',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      result: {
        ok: true,
        approved: false,
        reason: 'rejected again',
        reviewerModelName: 'haiku',
        durationMs: 100,
      },
    };
    const next = reduceRuntimeState(awaiting, event);
    expect(next.tools.calls['tool-99']!.status).toBe('rejected');
    expect(next.autoReview.consecutiveRejects).toBe(3);
    expect(next.autoReview.circuitBreakerTripped).toBe(true);
  });
});
