import { getAgentPhase } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateActiveTask as getActiveTask,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { AuthorizedExecutionControl } from '#kite-service/bootstrap/runtime/RuntimeSessionCoordinator';
import type { RuntimeEvent } from '#kite-service/bootstrap/runtime/state-runtime';

export interface PlanningModeExitResult {
  readonly events: RuntimeEvent[];
  /** Runtime-authoritative phase after evaluating the exit request. */
  readonly phase: import('@kite-ai/runtime-contract').AgentPhase;
}

type PlanningControl = Pick<AuthorizedExecutionControl, 'getState' | 'processEventBatch'>;

export function enterPlanningMode(control: PlanningControl): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const state = control.getState();
  const active = getActiveTask(state);
  const planning = getActivePlanning(state);
  if (active && planning.kind !== 'building_without_plan') return events;
  if (active?.sideEffectsStarted) return events;
  const taskId = active?.taskId ?? crypto.randomUUID();
  if (!active) {
    events.push({
      type: 'task.started',
      taskId,
      userGoal: '',
      turnId: state.turn.turnId,
    });
  }
  events.push({
    type: 'planning.entered',
    taskId,
    source: 'user_command',
  });
  return control.processEventBatch(events);
}

export function exitPlanningMode(control: PlanningControl): PlanningModeExitResult {
  const state = control.getState();
  const active = getActiveTask(state);
  const phase = getAgentPhase(getActivePlanning(state));
  if (!active || phase !== 'planning' || state.interactions.kind !== 'idle') {
    return { events: [], phase };
  }
  const events: RuntimeEvent[] = [
    {
      type: 'planning.exited',
      taskId: active.taskId,
      reason: 'Exited Plan Mode.',
    },
    {
      type: 'task.cancelled',
      taskId: active.taskId,
      reason: 'Exited Plan Mode.',
    },
  ];
  return { events: control.processEventBatch(events), phase: 'building' };
}
