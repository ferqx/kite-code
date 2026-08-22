import type { RuntimeEvent } from '@kite/agent-kernel';
import type { AgentPlan } from '@kite/runtime-contract';
import {
  createRuntimeHostState26InitialStateV1,
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@kite/runtime-host';
import { reduceRuntimeState } from '#runtime-support/runtime-state26-reducer';
import {
  openState26Store5ForTestV1,
  testState26ProjectIdentityForWorkspaceV1,
} from '../../scripts/support/runtime-storage';
import { currentPlanDraftedEvent } from '../helpers/current-plan';

const mode = process.argv[2];
const storePath = process.argv[3];
if (!mode || !storePath) throw new Error('Expected <mode> <store-path>');

if (mode === 'append-event') {
  process.stdout.write('ATTEMPTING\n');
  const event: RuntimeEvent = {
    type: 'user.message_appended',
    messageId: 'after-lock',
    content: 'durable after bounded lock wait',
  };
  const initial = createRuntimeHostState26InitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'sqlite-busy',
    userId: 'fault-soak',
    workspace: process.cwd(),
    ...testState26ProjectIdentityForWorkspaceV1(process.cwd()),
  });
  const next = { ...reduceRuntimeState(initial, event), revision: 1 };
  const store = openState26Store5ForTestV1(storePath);
  store.appendEventsAndSnapshot('sqlite-busy', [event], next, [
    { eventId: 'sqlite-busy-event-1', revision: 1 },
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
  steps: [
    {
      id: 'step-1',
      step: 'Recover without replaying the dispatched effect',
      status: 'pending',
    },
  ],
};
const upperBound = createZeroResourceUsageV1('versioned_upper_bound', 'fault-soak-v1');
upperBound.counters.toolInvocations = 1;
upperBound.gauges.activeToolInvocations = 1;
const drafted = currentPlanDraftedEvent({
  toolCallId: 'plan-tool',
  planId: 'crash-plan',
  version: 1,
  plan,
  taskId: 'crash-task',
});
const events: RuntimeEvent[] = [
  {
    type: 'task.started',
    taskId: 'crash-task',
    userGoal: 'Exercise crash recovery with a current Plan.',
    turnId: 'turn-0',
  },
  { type: 'planning.entered', taskId: 'crash-task', source: 'user_command' },
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
  drafted,
  {
    type: 'plan.review_requested',
    interactionId: 'plan-review',
    toolCallId: 'plan-tool',
    taskId: 'crash-task',
    plan,
    planSummary: 'Review the persisted crash plan.',
    planId: drafted.planId,
    version: drafted.version,
    structuralDigest: drafted.structuralHash,
    artifact: drafted.artifact,
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
const initial = createRuntimeHostState26InitialStateV1({
  recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
  threadId: 'crash-recovery',
  userId: 'fault-soak',
  workspace: process.cwd(),
  ...testState26ProjectIdentityForWorkspaceV1(process.cwd()),
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
const next = { ...events.reduce(reduceRuntimeState, initial), revision: events.length };
const store = openState26Store5ForTestV1(storePath);
store.appendEventsAndSnapshot(
  'crash-recovery',
  events,
  next,
  events.map((_event, index) => ({
    eventId: `crash-recovery-event-${index + 1}`,
    revision: index + 1,
  })),
);
process.stdout.write('READY_TO_KILL\n');
setInterval(() => {}, 60_000);
