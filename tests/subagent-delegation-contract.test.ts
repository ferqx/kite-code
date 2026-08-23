import { describe, expect, test } from 'bun:test';
import { BUILTIN_TASK_PUBLIC_SCHEMA_, BUILTIN_TASK_RUNTIME_SCHEMA_ } from '@kite/builtin-runtime';
import {
  planningContinuationAfterPlanSubagent,
  projectSubagentResult,
  validateDelegatedTask,
} from '@kite/builtin-runtime/subagent';

describe('ACORE-AGENT-01 delegation contract', () => {
  test('validates delegated task structure without parsing user authorization or role intent', () => {
    expect(
      validateDelegatedTask({
        delegatedTask: 'Review the reported issues and return file and line evidence.',
      }),
    ).toEqual({ valid: true, reason: 'valid' });
    expect(
      validateDelegatedTask({
        delegatedTask: '调用多agent审核这些问题，确认问题并提供文件证据。',
      }),
    ).toEqual({ valid: true, reason: 'valid' });
    expect(validateDelegatedTask({ delegatedTask: 'bounded!' })).toEqual({
      valid: true,
      reason: 'valid',
    });
    expect(validateDelegatedTask({ delegatedTask: 'Review authentication.' })).toEqual({
      valid: true,
      reason: 'valid',
    });
    expect(
      validateDelegatedTask({
        delegatedTask: 'Review how previous conversation records are stored.',
      }),
    ).toEqual({ valid: true, reason: 'valid' });
  });

  test('rejects only delegated tasks outside the shared structural length boundary', () => {
    for (const delegatedTask of ['short', 'x'.repeat(8_001)]) {
      expect(validateDelegatedTask({ delegatedTask })).toEqual({
        valid: false,
        reason: 'task_not_bounded',
      });
    }
  });

  test('task schema and Runtime validation share the 8..8000 bounded task contract', () => {
    expect(
      BUILTIN_TASK_PUBLIC_SCHEMA_.safeParse({ subagent_type: 'explore', task: '1234567' }).success,
    ).toBe(false);
    expect(
      BUILTIN_TASK_PUBLIC_SCHEMA_.safeParse({ subagent_type: 'explore', task: '       x' }).success,
    ).toBe(false);
    expect(
      BUILTIN_TASK_PUBLIC_SCHEMA_.safeParse({ subagent_type: 'explore', task: 'x'.repeat(8001) })
        .success,
    ).toBe(false);
    expect(
      BUILTIN_TASK_PUBLIC_SCHEMA_.safeParse({ subagent_type: 'explore', task: 'bounded!' }).success,
    ).toBe(true);
    expect(validateDelegatedTask({ delegatedTask: 'bounded!' }).valid).toBe(true);
  });

  test('keeps raw and private Artifact-backed task forms disjoint', () => {
    const taskArtifact = {
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'subagent_task_request' as const,
      integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      byteLength: 256,
    };
    const raw = { subagent_type: 'review' as const, task: 'Review the fixture implementation.' };
    const privateArgs = { subagent_type: raw.subagent_type, taskArtifact };
    const mixed = { ...raw, taskArtifact };

    // The public schema remains the raw v24 shape, but is now closed so a
    // private projection cannot be silently stripped into a raw task.
    expect(BUILTIN_TASK_PUBLIC_SCHEMA_.safeParse(raw).success).toBe(true);
    expect(BUILTIN_TASK_PUBLIC_SCHEMA_.safeParse(mixed).success).toBe(false);
    expect(BUILTIN_TASK_PUBLIC_SCHEMA_.safeParse(privateArgs).success).toBe(false);

    // Runtime restore still accepts each exact persisted form, while the
    // ambiguous mixed form is rejected before hydration or Provider dispatch.
    expect(BUILTIN_TASK_RUNTIME_SCHEMA_.safeParse(raw).success).toBe(true);
    expect(BUILTIN_TASK_RUNTIME_SCHEMA_.safeParse(privateArgs).success).toBe(true);
    expect(BUILTIN_TASK_RUNTIME_SCHEMA_.safeParse(mixed).success).toBe(false);
  });

  test('plan child terminal continues with write_plan save then submit, never update_plan', () => {
    expect(
      planningContinuationAfterPlanSubagent({
        phase: 'planning',
        role: 'plan',
        childTerminal: true,
      }),
    ).toEqual(['write_plan:save', 'write_plan:submit']);
    expect(
      planningContinuationAfterPlanSubagent({
        phase: 'planning',
        role: 'plan',
        childTerminal: false,
      }),
    ).toEqual([]);

    const projected = projectSubagentResult({
      input: {
        subagent_type: 'plan',
        task: 'Produce a read-only architecture plan.',
      },
      phase: 'planning',
      result: {
        ok: true,
        summary: 'Plan evidence gathered.',
        toolCallCount: 1,
        durationMs: 10,
      },
    });
    expect(JSON.parse(projected.stdout).nextActions).toEqual([
      'write_plan:save',
      'write_plan:submit',
    ]);
    const emptyRecoveryJournal = {
      schemaVersion: 1,
      identityKey: 'a'.repeat(64),
      failures: {},
      order: [],
      progressRevision: 0,
      qualityGuard: { blocked: false, observedFailures: 0 },
    };
    for (const result of [
      { ok: false, summary: 'failed', error: 'failed', terminalStatus: 'failed' },
      { ok: false, summary: 'cancelled', error: 'cancelled', terminalStatus: 'cancelled' },
      { ok: false, summary: 'exhausted', error: 'exhausted', terminalStatus: 'exhausted' },
      {
        ok: false,
        summary: 'suspended',
        error: 'approval',
        terminalStatus: 'suspended',
        blocked: {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-tool',
          toolName: 'shell_execute',
          command: 'echo no',
          args: {},
          message: 'approval',
          continuation: {
            id: 'child-plan',
            role: { role: 'plan' },
            task: 'Produce a read-only architecture plan.',
            messages: [],
            toolCallCount: 1,
            steps: [],
            toolRecovery: emptyRecoveryJournal,
          },
        },
      },
    ]) {
      const terminal = projectSubagentResult({
        input: {
          subagent_type: 'plan',
          task: 'Produce a read-only architecture plan.',
        },
        phase: 'planning',
        result: { toolCallCount: 1, durationMs: 1, ...result } as never,
      });
      const content = JSON.parse(terminal.stdout || terminal.stderr);
      expect(content.nextActions).toBeUndefined();
      expect(content.terminalStatus).toBe(result.terminalStatus);
    }
  });
});
