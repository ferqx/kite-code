import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import type { RuntimeEvent } from '@/core/runtime/events';
import { AgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { runRuntimeLoop } from '@/core/runtime/runner';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  type RuntimeState,
  setActivePlanning,
} from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

test('ACORE-EVAL-00 records a metadata-only scripted model → tool → model Runtime journey', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'eval-00',
    userId: 'synthetic',
    workspace: '/tmp',
  });
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  kernel.processEvent({
    type: 'user.message_appended',
    messageId: 'user-1',
    content: 'Inspect the fixture.',
  });

  let modelAttempts = 0;
  const eventTypes: string[] = [];
  for await (const event of runRuntimeLoop(
    kernel,
    async (effect) => {
      if (effect.type === 'call_model') {
        modelAttempts++;
        return modelAttempts === 1
          ? [
              {
                type: 'model.responded',
                messageId: 'model-1',
                toolCalls: [
                  { id: 'read-1', name: 'read_file', args: { path: '/synthetic/fixture.ts' } },
                ],
              },
              {
                type: 'tool.queued',
                toolCallId: 'read-1',
                name: 'read_file',
                args: { path: '/synthetic/fixture.ts' },
                modelMessageId: 'model-1',
                ordinal: 0,
                effectClass: 'read_only',
                sideEffect: false,
              },
            ]
          : [{ type: 'model.responded', messageId: 'model-2', text: 'Inspection complete.' }];
      }
      if (effect.type === 'run_tools') {
        return [
          { type: 'tool.started', toolCallId: 'read-1' },
          {
            type: 'tool.finished',
            toolCallId: 'read-1',
            name: 'read_file',
            result: { ok: true, command: '', exitCode: 0, stdout: 'fixture', stderr: '' },
          },
        ];
      }
      throw new Error(`unexpected_effect:${effect.type}`);
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    eventTypes.push(event.type);
  }

  const report = {
    schema: 'ACORE-EVAL-00-v1',
    modelAttempts,
    eventCounts: Object.fromEntries(
      eventTypes.map((type) => [type, eventTypes.filter((x) => x === type).length]),
    ),
    contentLogged: false,
  };
  expect(report).toEqual({
    schema: 'ACORE-EVAL-00-v1',
    modelAttempts: 2,
    eventCounts: {
      'model.responded': 2,
      'tool.queued': 1,
      'tool.started': 1,
      'tool.finished': 1,
      'run.completed': 1,
      'turn.completed': 1,
    },
    contentLogged: false,
  });
  expect(JSON.stringify(report)).not.toContain('/synthetic/fixture.ts');
  kernel.close();
});

const V2_JOURNEY_PLAN = {
  title: 'Runtime Journey V2',
  bodyMarkdown: 'Prove that Plan completion is gated by metadata-only Runtime evidence.',
  steps: [{ id: 'change', title: 'Apply the planned change', status: 'pending' as const }],
};

const V2_JOURNEY_IDENTITY = {
  planId: 'plan-journey-v2',
  version: 1,
  structuralDigest: computePlanStructuralDigest(V2_JOURNEY_PLAN),
};

function createV2JourneyState(threadId: string, workspace: string): RuntimeState {
  let state = createInitialRuntimeState({
    threadId,
    userId: 'synthetic',
    workspace,
  });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId: 'task-plan-v2',
    userGoal: 'Exercise metadata-only CompletionGuard V2.',
    turnId: state.turn.turnId,
  });
  const document = {
    planSchemaVersion: 2 as const,
    ...V2_JOURNEY_IDENTITY,
    ...V2_JOURNEY_PLAN,
    createdAtTurnId: state.turn.turnId,
    updatedAtTurnId: state.turn.turnId,
    completionEvidence: {
      schemaVersion: 1 as const,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
  };
  return setActivePlanning(state, {
    kind: 'executing',
    document,
    executionMode: 'accept_edits',
    approvedAtTurnId: state.turn.turnId,
  });
}

const V2_VERIFICATION_SPEC = {
  schemaVersion: 1 as const,
  verificationId: 'verification-journey-v2',
  taskId: 'task-plan-v2',
  subject: 'Runtime Journey V2 completion',
  checks: [
    {
      checkId: 'metadata-proof',
      type: 'schema' as const,
      description: 'Validate a metadata-only literal.',
      subject: { kind: 'literal' as const, value: { ok: true } },
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
  ],
  repair: { maxAttempts: 0 },
};

function reduceJourneyEvents(state: RuntimeState, events: readonly RuntimeEvent[]): RuntimeState {
  return events.reduce(reduceRuntimeState, state);
}

function requiredVerificationEvents(completed: boolean): RuntimeEvent[] {
  const events: RuntimeEvent[] = [
    {
      type: 'verification.requested',
      verificationId: V2_VERIFICATION_SPEC.verificationId,
      taskId: 'task-plan-v2',
      mode: 'required',
      spec: V2_VERIFICATION_SPEC,
      requestedAt: '2026-08-10T00:00:00.000Z',
    },
  ];
  if (!completed) return events;
  events.push(
    {
      type: 'verification.started',
      verificationId: V2_VERIFICATION_SPEC.verificationId,
      attempt: 1,
      startedAt: '2026-08-10T00:00:00.100Z',
    },
    {
      type: 'verification.check_completed',
      verificationId: V2_VERIFICATION_SPEC.verificationId,
      result: {
        checkId: 'metadata-proof',
        outcome: 'passed',
        summary: 'metadata proof passed',
        evidenceDigest: 'a'.repeat(64),
        startedAt: '2026-08-10T00:00:00.100Z',
        finishedAt: '2026-08-10T00:00:00.900Z',
      },
    },
    {
      type: 'verification.completed',
      verificationId: V2_VERIFICATION_SPEC.verificationId,
      outcome: 'passed',
      completedAt: '2026-08-10T00:00:01.000Z',
    },
  );
  return events;
}

async function executeJourneyEffect(
  state: RuntimeState,
): Promise<{ state: RuntimeState; events: RuntimeEvent[] }> {
  const queued: RuntimeEvent = {
    type: 'tool.queued',
    toolCallId: 'effect-journey-v2',
    name: 'write_file',
    args: { path: 'journey-output.txt', content: 'metadata-only fixture' },
    modelMessageId: 'model-effect-v2',
    ordinal: 0,
    taskId: 'task-plan-v2',
    effectClass: 'workspace_write',
    sideEffect: true,
  };
  const queuedState = reduceRuntimeState(state, queued);
  const execution = await executeRuntimeTools({
    state: queuedState,
    toolCallIds: ['effect-journey-v2'],
  });
  return { state: reduceJourneyEvents(queuedState, execution), events: [queued, ...execution] };
}

async function executeJourneyPlanUpdate(
  state: RuntimeState,
  options: { toolCallId: string; completePlan: boolean },
): Promise<{ state: RuntimeState; events: RuntimeEvent[] }> {
  const queued: RuntimeEvent = {
    type: 'tool.queued',
    toolCallId: options.toolCallId,
    name: 'update_plan',
    args: {
      plan_id: V2_JOURNEY_IDENTITY.planId,
      version: V2_JOURNEY_IDENTITY.version,
      structural_digest: V2_JOURNEY_IDENTITY.structuralDigest,
      updates: [{ step_id: 'change', status: 'completed' }],
      complete_plan: options.completePlan,
    },
    modelMessageId: `model-${options.toolCallId}`,
    ordinal: 0,
    taskId: 'task-plan-v2',
    effectClass: 'plan_only',
    sideEffect: false,
  };
  const queuedState = reduceRuntimeState(state, queued);
  const execution = await executeRuntimeTools({
    state: queuedState,
    toolCallIds: [options.toolCallId],
  });
  return { state: reduceJourneyEvents(queuedState, execution), events: [queued, ...execution] };
}

async function runBlockedJourney(
  initialState: RuntimeState,
): Promise<{ events: RuntimeEvent[]; blockedMetadata: Array<Record<string, unknown>> }> {
  const kernel = new AgentKernel({
    store: createRuntimeStore(':memory:'),
    initialState,
    interactionMode: 'accept_edits',
  });
  let modelAttempts = 0;
  const events: RuntimeEvent[] = [];
  const blockedMetadata: Array<Record<string, unknown>> = [];
  for await (const event of runRuntimeLoop(
    kernel,
    async () => {
      modelAttempts++;
      return [
        {
          type: 'model.responded' as const,
          messageId: `blocked-final-${modelAttempts}`,
          text: 'candidate',
        },
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event);
    if (event.type === 'completion.blocked') {
      blockedMetadata.push({
        guardVersion: event.guardVersion,
        code: event.code,
        correctionAttempt: event.correctionAttempt,
        planIdentity: event.planIdentity,
      });
    }
  }
  kernel.close();
  return { events, blockedMetadata };
}

function metadataEventCounts(events: readonly RuntimeEvent[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(events.map((event) => event.type))].map((type) => [
      type,
      events.filter((event) => event.type === type).length,
    ]),
  );
}

function expectMetadataOnly(report: unknown): void {
  for (const forbidden of [
    'candidate',
    V2_JOURNEY_PLAN.bodyMarkdown,
    'metadata-only fixture',
    'journey-output.txt',
    'prompt',
    'path',
    'command',
    'stdout',
    'body',
  ]) {
    expect(JSON.stringify(report)).not.toContain(forbidden);
  }
}

test('ACORE-PLAN-03 records a real metadata-only blocked journey for required verification', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-journey-verification-'));
  try {
    let state = createV2JourneyState('eval-plan-v2-verification-blocked', workspace);
    const planUpdate = await executeJourneyPlanUpdate(state, {
      toolCallId: 'update-verification-blocked',
      completePlan: false,
    });
    state = planUpdate.state;
    const verification = requiredVerificationEvents(true);
    state = reduceJourneyEvents(state, verification);
    if (state.planning.kind !== 'executing') throw new Error('expected executing V2 plan');
    expect(state.planning.document.steps[0]?.status).toBe('completed');
    expect(state.planning.document.completionEvidence).toEqual({
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    });
    const blocked = await runBlockedJourney(state);
    const events = [...verification, ...planUpdate.events, ...blocked.events];

    const report = {
      schema: 'ACORE-PLAN-03-v1',
      journey: 'blocked_verification_required',
      eventCounts: metadataEventCounts(events),
      blockedMetadata: blocked.blockedMetadata,
      contentLogged: false,
    };
    expect(report.blockedMetadata).toEqual([
      {
        guardVersion: 'completion_guard_v2',
        code: 'verification_required',
        correctionAttempt: 1,
        planIdentity: V2_JOURNEY_IDENTITY,
      },
      {
        guardVersion: 'completion_guard_v2',
        code: 'verification_required',
        correctionAttempt: 2,
        planIdentity: V2_JOURNEY_IDENTITY,
      },
    ]);
    expect(report.eventCounts).toMatchObject({
      'verification.requested': 1,
      'plan.progress_updated': 1,
      'completion.blocked': 2,
      'turn.aborted': 1,
      'run.error': 1,
    });
    expect(events.some((event) => event.type === 'run.completed')).toBe(false);
    expectMetadataOnly(report);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ACORE-PLAN-03 records a real metadata-only blocked journey for missing effect evidence', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-journey-effect-'));
  try {
    let state = createV2JourneyState('eval-plan-v2-effect-blocked', workspace);
    const verification = requiredVerificationEvents(true);
    state = reduceJourneyEvents(state, verification);
    const verificationProjection = await executeJourneyPlanUpdate(state, {
      toolCallId: 'update-verification-projection',
      completePlan: false,
    });
    state = verificationProjection.state;
    const effect = await executeJourneyEffect(state);
    state = effect.state;
    if (state.planning.kind !== 'executing') throw new Error('expected executing V2 plan');
    expect(state.planning.document.completionEvidence).toMatchObject({
      verification: [{ verificationId: 'verification-journey-v2', outcome: 'passed' }],
      execution: [],
    });
    expect(state.tools.calls['effect-journey-v2']).toMatchObject({
      status: 'succeeded',
      sideEffect: true,
    });
    const blocked = await runBlockedJourney(state);
    const events = [
      ...verification,
      ...verificationProjection.events,
      ...effect.events,
      ...blocked.events,
    ];
    const report = {
      schema: 'ACORE-PLAN-03-v1',
      journey: 'blocked_effect_evidence_required',
      eventCounts: metadataEventCounts(events),
      blockedMetadata: blocked.blockedMetadata,
      contentLogged: false,
    };
    expect(report.blockedMetadata.map((entry) => entry.code)).toEqual([
      'effect_evidence_required',
      'effect_evidence_required',
    ]);
    expect(report.eventCounts).toMatchObject({
      'verification.completed': 1,
      'tool.started': 1,
      'tool.finished': 2,
      'plan.progress_updated': 1,
      'completion.blocked': 2,
      'run.error': 1,
    });
    expect(events.some((event) => event.type === 'run.completed')).toBe(false);
    expectMetadataOnly(report);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ACORE-PLAN-03 completes a real metadata-only V2 journey through update_plan', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-journey-completed-'));
  try {
    let state = createV2JourneyState('eval-plan-v2-completed', workspace);
    const verification = requiredVerificationEvents(true);
    state = reduceJourneyEvents(state, verification);
    const effect = await executeJourneyEffect(state);
    state = effect.state;
    const planUpdate = await executeJourneyPlanUpdate(state, {
      toolCallId: 'update-completed-plan',
      completePlan: true,
    });
    state = planUpdate.state;
    if (state.planning.kind !== 'completed') throw new Error('expected completed V2 plan');
    expect(state.planning.document.completionEvidence).toMatchObject({
      verification: [{ verificationId: 'verification-journey-v2', outcome: 'passed' }],
      execution: [{ toolCallId: 'effect-journey-v2', outcome: 'succeeded' }],
    });
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const finalEvents: RuntimeEvent[] = [];
    let completionIdentity: unknown;
    for await (const event of runRuntimeLoop(
      kernel,
      async () => [
        { type: 'model.responded' as const, messageId: 'accepted-final-v2', text: 'candidate' },
      ],
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      finalEvents.push(event);
      if (event.type === 'run.completed') completionIdentity = event.planIdentity;
    }
    kernel.close();
    const events = [...verification, ...effect.events, ...planUpdate.events, ...finalEvents];

    const report = {
      schema: 'ACORE-PLAN-03-v1',
      journey: 'completed_with_runtime_evidence',
      eventCounts: metadataEventCounts(events),
      completionIdentity,
      contentLogged: false,
    };
    expect(report.completionIdentity).toEqual(V2_JOURNEY_IDENTITY);
    expect(report.eventCounts).toMatchObject({
      'verification.requested': 1,
      'verification.started': 1,
      'verification.check_completed': 1,
      'verification.completed': 1,
      'tool.started': 1,
      'tool.finished': 2,
      'plan.progress_updated': 1,
      'plan.completed': 1,
      'run.completed': 1,
      'turn.completed': 1,
    });
    expectMetadataOnly(report);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
