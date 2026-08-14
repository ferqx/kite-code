import { describe, expect, test } from 'bun:test';
import {
  planningContinuationAfterPlanSubagentV1,
  validateDelegatedTaskV1,
} from '@/core/subagent/delegation-contract';
import { taskSpec } from '@/core/tools/registry/builtins/task';

describe('ACORE-AGENT-01 delegation contract', () => {
  test('validates delegated task structure without parsing user authorization or role intent', () => {
    expect(
      validateDelegatedTaskV1({
        delegatedTask: 'Review the reported issues and return file and line evidence.',
      }),
    ).toEqual({ valid: true, reason: 'valid' });
    expect(
      validateDelegatedTaskV1({
        delegatedTask: '调用多agent审核这些问题，确认问题并提供文件证据。',
      }),
    ).toEqual({ valid: true, reason: 'valid' });
    expect(validateDelegatedTaskV1({ delegatedTask: 'bounded!' })).toEqual({
      valid: true,
      reason: 'valid',
    });
    expect(validateDelegatedTaskV1({ delegatedTask: 'Review authentication.' })).toEqual({
      valid: true,
      reason: 'valid',
    });
    expect(
      validateDelegatedTaskV1({
        delegatedTask: 'Review how previous conversation records are stored.',
      }),
    ).toEqual({ valid: true, reason: 'valid' });
  });

  test('rejects only delegated tasks outside the shared structural length boundary', () => {
    for (const delegatedTask of ['short', 'x'.repeat(8_001)]) {
      expect(validateDelegatedTaskV1({ delegatedTask })).toEqual({
        valid: false,
        reason: 'task_not_bounded',
      });
    }
  });

  test('task schema and Runtime validation share the 8..8000 bounded task contract', () => {
    expect(
      taskSpec.inputSchema.safeParse({ subagent_type: 'explore', task: '1234567' }).success,
    ).toBe(false);
    expect(
      taskSpec.inputSchema.safeParse({ subagent_type: 'explore', task: '       x' }).success,
    ).toBe(false);
    expect(
      taskSpec.inputSchema.safeParse({ subagent_type: 'explore', task: 'x'.repeat(8001) }).success,
    ).toBe(false);
    expect(
      taskSpec.inputSchema.safeParse({ subagent_type: 'explore', task: 'bounded!' }).success,
    ).toBe(true);
    expect(validateDelegatedTaskV1({ delegatedTask: 'bounded!' }).valid).toBe(true);
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
      const content = JSON.parse(terminal.modelContent);
      expect(content.nextActions).toBeUndefined();
      expect(content.terminalStatus).toBe(result.terminalStatus);
    }
  });
});
