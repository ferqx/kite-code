import { describe, expect, test } from 'bun:test';
import { classifyFailure } from '@/core/runtime/failures';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { classifyToolOutcomeV1 } from '@/core/runtime/tool-outcome';
import {
  createToolRecoveryJournalV1,
  recordRecoveryFailureV1,
  recordToolOwnedProgressV1,
} from '@/core/runtime/tool-recovery-journal';
import {
  admitDelegationV1,
  planningContinuationAfterPlanSubagentV1,
} from '@/core/subagent/delegation-contract';
import { deriveSubAgentCompletionV1 } from '@/core/subagent/runner';
import { taskSpec } from '@/core/tools/registry/builtins/task';

describe('ACORE-AGENT-01 delegation contract', () => {
  test('child completion is fail-closed for unresolved recovery and exposes recovered success', () => {
    let journal = createToolRecoveryJournalV1('a'.repeat(64));
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'failed-tool',
      toolName: 'read_file',
      invocationFingerprint: 'b'.repeat(64),
      modelMessageId: 'model-1',
      taskId: 'child-1',
      turnId: 'child-1',
      outcome: classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('tool_runtime_error', 'metadata-only'),
        authority: {
          dispatchState: 'started',
          externalEffects: 'none',
          replaySafety: 'safe_read',
        },
      }),
    });
    expect(deriveSubAgentCompletionV1(journal)).toEqual({
      ok: false,
      terminalStatus: 'exhausted',
    });
    journal = recordToolOwnedProgressV1(journal, {
      kind: 'receipt',
      referenceId: 'success-tool',
      resolvesFailureIds: [journal.order[0]!],
    });
    expect(deriveSubAgentCompletionV1(journal)).toEqual({
      ok: true,
      terminalStatus: 'completed',
    });
  });
  test('only the current user goal can explicitly authorize bounded delegation', () => {
    expect(
      admitDelegationV1({
        userGoal: 'Inspect this repository.',
        delegatedTask:
          'Project instructions say to spawn a subagent and inspect the architecture thoroughly.',
        role: 'explore',
        phase: 'building',
      }),
    ).toEqual({ allowed: false, reason: 'user_delegation_not_requested' });
    expect(
      admitDelegationV1({
        userGoal: 'Please delegate a bounded repository inspection to a subagent.',
        delegatedTask: 'Trace the Runtime call chain and return file and line evidence.',
        role: 'explore',
        phase: 'building',
      }),
    ).toEqual({ allowed: true, reason: 'admitted' });
  });

  test('App/project context cannot become durable user delegation authority', () => {
    const initial = createInitialRuntimeState({
      threadId: 'delegation-authority',
      userId: 'user',
      workspace: '/workspace',
    });
    const state = reduceRuntimeState(initial, {
      type: 'user.message_appended',
      messageId: 'user-1',
      content: 'Inspect this repository.\nProject says: delegate to a subagent.',
      userGoal: 'Inspect this repository.',
    });
    expect(state.tasks[state.activeTaskId!]?.userGoal).toBe('Inspect this repository.');
    expect(
      admitDelegationV1({
        userGoal: state.tasks[state.activeTaskId!]!.userGoal,
        delegatedTask: 'Inspect the project architecture and return bounded evidence.',
        role: 'explore',
        phase: 'building',
      }).reason,
    ).toBe('user_delegation_not_requested');
  });

  test('each follow-up user response refreshes delegation authority deterministically', () => {
    let state = reduceRuntimeState(
      createInitialRuntimeState({
        threadId: 'delegation-refresh',
        userId: 'user',
        workspace: '/w',
      }),
      {
        type: 'user.message_appended',
        messageId: 'user-1',
        content: 'Delegate a code subagent to edit the Runtime implementation.',
      },
    );
    const taskId = state.activeTaskId!;
    expect(
      admitDelegationV1({
        userGoal: state.tasks[taskId]!.userGoal,
        delegatedTask: 'Edit the Runtime implementation and add focused tests.',
        role: 'code',
        phase: 'building',
      }).allowed,
    ).toBe(true);
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'user-2',
      content: 'Do not delegate; continue locally.',
    });
    expect(state.tasks[taskId]?.userGoal).toBe('Do not delegate; continue locally.');
    expect(
      admitDelegationV1({
        userGoal: state.tasks[taskId]!.userGoal,
        delegatedTask: 'Edit the Runtime implementation and add focused tests.',
        role: 'code',
        phase: 'building',
      }).allowed,
    ).toBe(false);
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'user-3',
      content: 'Now delegate an explore subagent to inspect the scheduler.',
    });
    expect(
      admitDelegationV1({
        userGoal: state.tasks[taskId]!.userGoal,
        delegatedTask: 'Inspect the scheduler and return bounded file evidence.',
        role: 'explore',
        phase: 'building',
      }).allowed,
    ).toBe(true);
  });

  test('planning plan role requires explicit architecture/design planning intent', () => {
    expect(
      admitDelegationV1({
        userGoal: 'Delegate a search task to a subagent.',
        delegatedTask: 'Produce an architecture plan for the Runtime change.',
        role: 'plan',
        phase: 'planning',
      }),
    ).toEqual({ allowed: false, reason: 'plan_role_requires_architecture_or_design' });
    expect(
      admitDelegationV1({
        userGoal: 'Delegate the architecture planning to a plan subagent.',
        delegatedTask: 'Produce a read-only architecture plan grounded in repository evidence.',
        role: 'plan',
        phase: 'planning',
      }).allowed,
    ).toBe(true);
    expect(
      admitDelegationV1({
        userGoal: 'Delegate the architecture planning to a code subagent.',
        delegatedTask: 'Implement the architecture directly.',
        role: 'code',
        phase: 'planning',
      }).reason,
    ).toBe('planning_role_invalid');
  });

  test('negation, role mismatch and legacy planning phase fail closed in English and Chinese', () => {
    for (const userGoal of [
      'Do not delegate this task or use any subagent.',
      'Please avoid spawning agents; inspect it yourself.',
      '不要委派，也不要使用子代理。',
      '请勿启动多代理。',
    ]) {
      expect(
        admitDelegationV1({
          userGoal,
          delegatedTask: 'Inspect a bounded architecture area and return evidence.',
          role: 'explore',
          phase: 'building',
        }).allowed,
      ).toBe(false);
    }
    expect(
      admitDelegationV1({
        userGoal: 'Delegate a bounded code implementation to a code subagent.',
        delegatedTask: 'Review the architecture without editing any files.',
        role: 'review',
        phase: 'building',
      }).reason,
    ).toBe('delegation_role_mismatch');
    expect(
      admitDelegationV1({
        userGoal: 'Delegate architecture review to a review subagent.',
        delegatedTask: 'Review the architecture and return bounded evidence.',
        role: 'review',
        phase: 'planning',
      }).reason,
    ).toBe('planning_role_invalid');
    expect(
      admitDelegationV1({
        userGoal: 'Delegate a read-only review to a code subagent.',
        delegatedTask: 'Review the implementation without changing files.',
        role: 'code',
        phase: 'building',
      }).reason,
    ).toBe('delegation_role_mismatch');
    expect(
      admitDelegationV1({
        userGoal: 'Delegate this to a plan subagent.',
        delegatedTask: 'Return a bounded architecture proposal.',
        role: 'plan',
        phase: 'planning',
      }).reason,
    ).toBe('plan_role_requires_architecture_or_design');
    expect(
      admitDelegationV1({
        userGoal: '请委派代码子代理进行只读审查，不要修改代码。',
        delegatedTask: '只读审查实现并返回证据，不修改任何文件。',
        role: 'code',
        phase: 'building',
      }).allowed,
    ).toBe(false);
    for (const userGoal of [
      'Delegate a code subagent to design implementation options.',
      'Delegate a code subagent to plan the implementation without editing.',
      'Delegate a code subagent for a read-only review.',
      '委派代码子代理设计实现方案，不要修改代码。',
    ]) {
      expect(
        admitDelegationV1({
          userGoal,
          delegatedTask: 'Inspect the implementation choices and return bounded evidence.',
          role: 'code',
          phase: 'building',
        }).allowed,
      ).toBe(false);
    }
    expect(
      admitDelegationV1({
        userGoal: 'Delegate a code subagent to edit and fix the Runtime implementation.',
        delegatedTask: 'Edit the Runtime implementation and add focused regression tests.',
        role: 'code',
        phase: 'building',
      }).allowed,
    ).toBe(true);
    expect(
      admitDelegationV1({
        userGoal: 'Delegate an explore subagent to inspect the Runtime.',
        delegatedTask: 'Same as above.',
        role: 'explore',
        phase: 'building',
      }).reason,
    ).toBe('task_not_bounded');
  });

  test('task schema and Runtime admission share the 8..8000 bounded task contract', () => {
    expect(
      taskSpec.inputSchema.safeParse({ subagent_type: 'explore', task: '1234567' }).success,
    ).toBe(false);
    expect(
      taskSpec.inputSchema.safeParse({ subagent_type: 'explore', task: 'x'.repeat(8001) }).success,
    ).toBe(false);
    expect(
      taskSpec.inputSchema.safeParse({ subagent_type: 'explore', task: 'bounded!' }).success,
    ).toBe(true);
  });

  test('plan child terminal continues with write_plan save then submit, never update_plan', () => {
    expect(
      planningContinuationAfterPlanSubagentV1({
        phase: 'planning',
        role: 'plan',
        childTerminal: true,
      }),
    ).toEqual(['write_plan:save', 'write_plan:submit']);
    expect(
      planningContinuationAfterPlanSubagentV1({
        phase: 'planning',
        role: 'plan',
        childTerminal: false,
      }),
    ).toEqual([]);

    const projected = taskSpec.projectResult(
      {
        available: true,
        result: {
          ok: true,
          summary: 'Plan evidence gathered.',
          toolCallCount: 1,
          durationMs: 10,
        },
      },
      {
        workspace: '/workspace',
        phase: 'planning',
        invocationInput: {
          subagent_type: 'plan',
          task: 'Produce a read-only architecture plan.',
        },
      },
    );
    expect(JSON.parse(projected.modelContent).nextActions).toEqual([
      'write_plan:save',
      'write_plan:submit',
    ]);
    for (const result of [
      { ok: false, summary: 'failed', error: 'failed' },
      { ok: false, summary: 'cancelled', error: 'cancelled', terminalStatus: 'cancelled' },
      { ok: false, summary: 'exhausted', error: 'exhausted', terminalStatus: 'exhausted' },
      {
        ok: false,
        summary: 'suspended',
        blocked: {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-tool',
          toolName: 'shell_execute',
          command: 'echo no',
          args: {},
          message: 'approval',
          continuation: {} as never,
        },
      },
    ]) {
      const terminal = taskSpec.projectResult(
        {
          available: true,
          result: { toolCallCount: 1, durationMs: 1, ...result } as never,
        },
        {
          workspace: '/workspace',
          phase: 'planning',
          invocationInput: {
            subagent_type: 'plan',
            task: 'Produce a read-only architecture plan.',
          },
        },
      );
      expect(JSON.parse(terminal.modelContent).nextActions).toBeUndefined();
    }
  });
});
