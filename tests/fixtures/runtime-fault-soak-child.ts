import type { RuntimeEvent } from '@/core/runtime/events';
import { createAgentKernel } from '@/core/runtime/kernel';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import { computePlanStructuralDigest, createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import type { AgentPlan } from '@/protocol/events';

const mode = process.argv[2];
const storePath = process.argv[3];
if (!mode || !storePath) throw new Error('Expected <mode> <store-path>');

if (mode === 'append-event') {
  process.stdout.write('ATTEMPTING\n');
  const store = createRuntimeStore(storePath);
  store.appendEvents('sqlite-busy', [
    {
      type: 'user.message_appended',
      messageId: 'after-lock',
      content: 'durable after bounded lock wait',
    },
  ]);
  store.close();
  process.stdout.write('WROTE\n');
  process.exit(0);
}

if (mode !== 'crash-state') throw new Error(`Unknown fixture mode: ${mode}`);

const plan: AgentPlan = {
  name: 'Crash recovery plan',
  description: 'Persist plan and verification before abrupt termination.',
  status: 'pending',
  steps: [{ step: 'Recover without replaying the dispatched effect', status: 'pending' }],
};
const structuralHash = computePlanStructuralDigest({
  title: plan.name,
  bodyMarkdown: plan.description,
  steps: [{ id: 'step-1', title: plan.steps[0]!.step, status: 'pending' }],
});
const upperBound = createZeroResourceUsageV1('versioned_upper_bound', 'fault-soak-v1');
upperBound.counters.toolInvocations = 1;
upperBound.gauges.activeToolInvocations = 1;
const events: RuntimeEvent[] = [
  {
    type: 'resource_budget.configured',
    runId: 'fault-run',
    startedAt: '2026-08-01T00:00:00.000Z',
    deadlineAt: '2026-08-01T00:30:00.000Z',
    budget: LIMITED_RESOURCE_BUDGET_V1,
  },
  {
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId: 'fault-reservation',
      runId: 'fault-run',
      invocationId: 'fault-invocation',
      resourceKind: 'tool',
      executableUpperBound: upperBound,
      state: 'reserved',
    },
  },
  { type: 'resource_budget.dispatch_started', reservationId: 'fault-reservation' },
  {
    type: 'tool.queued',
    toolCallId: 'plan-tool',
    name: 'write_plan',
    args: { title: plan.name },
  },
  {
    type: 'plan.drafted',
    toolCallId: 'plan-tool',
    planId: 'crash-plan',
    version: 1,
    plan,
    structuralHash,
  },
  {
    type: 'plan.review_requested',
    interactionId: 'plan-review',
    toolCallId: 'plan-tool',
    plan,
    planSummary: 'Review the persisted crash plan.',
  },
  {
    type: 'verification.requested',
    verificationId: 'crash-verification',
    taskId: 'crash-task',
    mode: 'required',
    spec: {
      schemaVersion: 1,
      verificationId: 'crash-verification',
      taskId: 'crash-task',
      subject: 'crash recovery state',
      checks: [
        {
          checkId: 'crash-state-check',
          description: 'The recovered state remains internally consistent.',
          type: 'command',
          command: 'true',
        },
      ],
      repair: { maxAttempts: 1 },
    },
    requestedAt: '2026-08-01T00:00:00.000Z',
  },
];
const initial = createInitialRuntimeState({
  threadId: 'crash-recovery',
  userId: 'fault-soak',
  workspace: process.cwd(),
  phase: 'planning',
});
initial.activeTaskId = 'crash-task';
initial.tasks['crash-task'] = {
  taskId: 'crash-task',
  userGoal: 'Recover the interrupted run without replaying effects.',
  status: 'active',
  startedAtTurnId: initial.turn.turnId,
  sideEffectsStarted: true,
  planning: { kind: 'building_without_plan' },
  planHistory: [],
};
initial.planning = initial.tasks['crash-task'].planning;
const store = createRuntimeStore(storePath);
store.saveSnapshot('crash-recovery', initial);
store.close();
const kernel = createAgentKernel({
  threadId: 'crash-recovery',
  userId: 'fault-soak',
  workspace: process.cwd(),
  storePath,
});
kernel.processEvents(events);
process.stdout.write('READY_TO_KILL\n');
setInterval(() => {}, 60_000);
