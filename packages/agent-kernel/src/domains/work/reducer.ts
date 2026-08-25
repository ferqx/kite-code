import type { KernelEvent } from '../../events';
import {
  eventRecord,
  jsonRecord,
  nonEmptyStringField,
  recordField,
  stringField,
  updateTasks,
} from '../../reducer-utils';
import type { AgentState } from '../../state';

/** Work ownership and side-effect boundaries are statically bound here. */
export function reduceWorkState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'tool.started': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const call = toolCallId ? state.tools.calls[toolCallId] : undefined;
      const taskId = state.activeTaskId;
      if (call?.status !== 'running' || call.sideEffect !== true || !taskId) return state;
      return updateTasks(state, taskId, (current) =>
        current ? { ...current, sideEffectsStarted: true } : current!,
      );
    }
    case 'skill.catalog_refreshed': {
      const catalogRevision = nonEmptyStringField(payload, 'catalogRevision');
      return catalogRevision
        ? { ...state, skills: jsonRecord({ ...state.skills, catalogRevision }) }
        : state;
    }
    case 'skill.activation_started': {
      const activation = recordField(payload, 'activation');
      const activationId = activation && nonEmptyStringField(activation, 'activationId');
      const taskId = activation && nonEmptyStringField(activation, 'taskId');
      if (!activation || !activationId || !taskId || taskId !== state.activeTaskId) return state;
      const frames = recordField(state.skills, 'frames') ?? {};
      if (frames[activationId]) return state;
      return {
        ...state,
        skills: jsonRecord({
          ...state.skills,
          frames: { ...frames, [activationId]: jsonRecord({ ...activation, status: 'active' }) },
        }),
      };
    }
    case 'skill.frame_closed': {
      const activationId = nonEmptyStringField(payload, 'activationId');
      if (!activationId) return state;
      const frames = recordField(state.skills, 'frames') ?? {};
      const frame = frames[activationId];
      if (!frame || stringField(frame, 'status') !== 'active') return state;
      return {
        ...state,
        skills: jsonRecord({
          ...state.skills,
          frames: {
            ...frames,
            [activationId]: jsonRecord({
              ...frame,
              status: payload.status,
              closedAt: payload.closedAt,
              closeReason: payload.reason,
              ...(payload.output ? { output: payload.output } : {}),
            }),
          },
        }),
      };
    }
    default:
      return state;
  }
}
