import { createHash } from 'node:crypto';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import {
  createSkillCapabilityResolver,
  evaluateSkillActivation,
  refreshSkillCatalog,
  type SkillScanOptions,
} from '@kite-ai/builtin-runtime/skills';
import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateActiveTask as getActiveTask,
  runtimeHostStateInteractionBelongsToCurrentWork as interactionBelongsToCurrentWork,
  type StateRuntimeSession,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import { eventsForSupersededTurnRecovery } from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

export type StartTurnCommand = Extract<RuntimeCommand, { readonly type: 'start_turn' }>;

/**
 * Exact identity of a start decision already committed by the State transaction.
 * It deliberately contains no prompt or skill input: those facts live only in
 * the committed State/event history.
 */
export interface PrecommittedStartTurnDescriptor {
  readonly commandId: string;
  readonly sessionId: string;
  readonly committedRevision: number;
  readonly turnId: string;
  readonly messageId: string;
  readonly phase: 'planning' | 'building';
  readonly taskId?: string;
  readonly initialSkillActivations?: readonly PrecommittedSkillActivation[];
}

export interface PrecommittedSkillActivation {
  readonly activationId: string;
  readonly skillId: string;
  readonly skillRevision: string;
  readonly taskId: string;
  readonly digest: string;
}

/** App-owned immutable dependencies required to plan initial skills before commit. */
export interface StartTurnSkillPlanningContext {
  readonly skillOptions: SkillScanOptions;
  readonly mcpManager?: McpRuntimeProvider;
  readonly flags: { readonly skillActivation: boolean; readonly skillWorkflow: boolean };
}

export interface CommittedStartTurnCommand {
  readonly receipt: RuntimeStoredCommandReceipt;
  readonly events: readonly RuntimeEvent[];
  readonly descriptor: PrecommittedStartTurnDescriptor;
}

/**
 * Build the full initial State decision for one start command without changing
 * State or starting an effect.  IDs are command-derived so a retry never leaks
 * prompt content into an identifier and never obtains a fresh turn identity.
 */
export function planStartTurnCommand(
  state: Readonly<RuntimeState>,
  command: StartTurnCommand,
  context?: StartTurnSkillPlanningContext,
  committedAt?: number,
): {
  readonly events: readonly RuntimeEvent[];
  readonly descriptor: PrecommittedStartTurnDescriptor;
} {
  if (command.sessionId !== state.session.threadId) {
    throw new Error('Runtime start command does not match the State session.');
  }
  if (command.expectedRevision !== state.revision) {
    throw new Error(`Runtime start command revision conflict at ${state.revision}.`);
  }
  if (getActiveTask(state) && interactionBelongsToCurrentWork(state)) {
    throw new Error('Runtime start command cannot replace an active durable interaction.');
  }
  if (command.initialSkills && command.initialSkills.length > 0 && !context) {
    throw new Error('Runtime start command with initial skills requires planning context.');
  }

  const phase = command.phase ?? 'building';
  const taskId = commandDerivedId(command.commandId, 'task');
  const messageId = commandDerivedId(command.commandId, 'message');
  const turnId = commandDerivedId(command.commandId, 'turn');
  const events: RuntimeEvent[] = [...eventsForSupersededTurnRecovery(state)];
  if (phase === 'planning' && events.length > 0) {
    // The recovery batch can alter the active task/turn relationship.  This
    // App seam intentionally has no second reducer, so deriving a planning
    // task from the pre-recovery State would be unsound.
    throw new Error(
      'Runtime planning start after superseded recovery requires a pure post-recovery plan.',
    );
  }
  const activeTask = getActiveTask(state);
  const replacesPlanningPlaceholder =
    phase === 'planning' &&
    activeTask?.userGoal.trim() === '' &&
    getActivePlanning(state).kind === 'planning_empty';

  if (replacesPlanningPlaceholder) {
    events.push({
      type: 'task.cancelled',
      taskId: activeTask.taskId,
      reason: 'Replaced Plan Mode placeholder with the submitted task.',
    });
  }

  const planningTask = replacesPlanningPlaceholder ? null : activeTask;
  if (phase === 'planning' && !planningTask) {
    events.push({
      type: 'task.started',
      taskId,
      userGoal: command.input,
      turnId: state.turn.turnId,
    });
    events.push({ type: 'planning.entered', taskId, source: 'user_command' });
  } else if (phase === 'planning' && planningTask) {
    events.push({ type: 'planning.entered', taskId: planningTask.taskId, source: 'user_command' });
  }

  events.push(
    {
      type: 'user.message_appended',
      messageId,
      content: command.input,
    },
    { type: 'turn.started', turnId },
  );

  const plannedSkillActivations: PrecommittedSkillActivation[] = [];
  if (command.initialSkills && command.initialSkills.length > 0) {
    const catalog = refreshSkillCatalog(context!.skillOptions, {
      resolveCapability: createSkillCapabilityResolver(context!.mcpManager),
    });
    const projectedTaskId =
      phase === 'planning' ? (planningTask?.taskId ?? taskId) : activeTask?.taskId;
    if (!projectedTaskId) {
      throw new Error('Runtime initial skill activation requires an active planned task.');
    }
    let synthetic = {
      activeTaskId: projectedTaskId,
      session: state.session,
      skills: { catalogRevision: state.skills.catalogRevision, frames: { ...state.skills.frames } },
    };
    for (const [index, requested] of command.initialSkills.entries()) {
      const activationId = commandDerivedSkillActivationId(
        command.commandId,
        index,
        requested.skillId,
      );
      const evaluation = evaluateSkillActivation({
        state: synthetic,
        catalog,
        flags: context!.flags,
        now: new Date(committedAt ?? 0),
        activationId,
        request: {
          skillId: requested.skillId,
          input: requested.input,
          requestedBy: 'user',
          implicit: false,
        },
      });
      if (!evaluation.ok) {
        throw new Error(`Runtime initial skill activation rejected: ${evaluation.reason}`);
      }
      events.push(...(evaluation.events as RuntimeEvent[]));
      synthetic = {
        ...synthetic,
        skills: {
          catalogRevision: catalog.revision,
          frames: {
            ...synthetic.skills.frames,
            [evaluation.activation.activationId]: {
              ...evaluation.activation,
              status: 'active' as const,
            },
          },
        },
      };
      plannedSkillActivations.push({
        activationId: evaluation.activation.activationId,
        skillId: evaluation.activation.skillId,
        skillRevision: evaluation.activation.skillRevision,
        taskId: evaluation.activation.taskId,
        digest: skillActivationDescriptorDigest(evaluation.activation),
      });
    }
  }

  return Object.freeze({
    events: Object.freeze(events),
    descriptor: Object.freeze({
      commandId: command.commandId,
      sessionId: command.sessionId,
      committedRevision: state.revision + events.length,
      turnId,
      messageId,
      phase,
      ...(phase === 'planning' ? { taskId: planningTask?.taskId ?? taskId } : {}),
      ...(plannedSkillActivations.length > 0
        ? { initialSkillActivations: Object.freeze(plannedSkillActivations) }
        : {}),
    }),
  });
}

/** Commit a complete start decision and its applied command receipt together. */
export function commitStartTurnCommand(
  session: StateRuntimeSession,
  command: StartTurnCommand,
  evidence: RuntimeCommandCommitEvidence,
  context?: StartTurnSkillPlanningContext,
): CommittedStartTurnCommand {
  if (evidence.targetSessionId !== command.sessionId || session.sessionId !== command.sessionId) {
    throw new Error('Runtime start command receipt target does not match the State session.');
  }
  const planned = planStartTurnCommand(
    session.getState() as RuntimeState,
    command,
    context,
    evidence.committedAt,
  );
  const committed = session.commitCommandBatch(planned.events, evidence);
  return Object.freeze({
    receipt: committed.receipt,
    events: committed.events as readonly RuntimeEvent[],
    descriptor: Object.freeze({
      ...planned.descriptor,
      committedRevision: committed.receipt.committedRevision,
    }),
  });
}

/** Reject a descriptor before a runner can redispatch an already-committed start. */
export function assertPrecommittedStartTurn(
  state: Readonly<RuntimeState>,
  descriptor: PrecommittedStartTurnDescriptor,
  sessionId: string,
): void {
  if (
    descriptor.sessionId !== sessionId ||
    state.session.threadId !== sessionId ||
    state.revision !== descriptor.committedRevision ||
    state.turn.turnId !== descriptor.turnId ||
    !state.transcript.messages.some((message) => message.messageId === descriptor.messageId)
  ) {
    throw new Error('Runtime precommitted start descriptor does not match current State.');
  }
  if (descriptor.taskId && getActiveTask(state)?.taskId !== descriptor.taskId) {
    throw new Error('Runtime precommitted start task identity does not match current State.');
  }
  for (const activation of descriptor.initialSkillActivations ?? []) {
    const frame = state.skills.frames[activation.activationId];
    if (
      !frame ||
      frame.skillId !== activation.skillId ||
      frame.skillRevision !== activation.skillRevision ||
      frame.taskId !== activation.taskId ||
      skillActivationDescriptorDigest(frame) !== activation.digest
    ) {
      throw new Error('Runtime precommitted start skill activation does not match current State.');
    }
  }
}

function commandDerivedId(commandId: string, domain: 'task' | 'message' | 'turn'): string {
  const digest = createHash('sha256')
    .update(`kite.runtime.start-turn.v1\0${domain}\0${commandId}`)
    .digest('hex');
  return `${domain}_${digest.slice(0, 32)}`;
}

function commandDerivedSkillActivationId(
  commandId: string,
  index: number,
  skillId: string,
): string {
  const digest = createHash('sha256')
    .update(`kite.runtime.start-turn.initial-skill.v1\0${commandId}\0${index}\0${skillId}`)
    .digest('hex');
  return `skill_activation_${digest.slice(0, 32)}`;
}

function skillActivationDescriptorDigest(input: {
  readonly activationId: string;
  readonly skillId: string;
  readonly skillRevision: string;
  readonly taskId: string;
}): string {
  return createHash('sha256')
    .update(
      `kite.runtime.start-turn.skill-descriptor.v1\0${input.activationId}\0${input.skillId}\0${input.skillRevision}\0${input.taskId}`,
    )
    .digest('hex');
}
