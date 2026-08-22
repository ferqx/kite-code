import { describe, expect, test } from 'bun:test';
import { projectSubagentResultV1 } from '../src/rmv1-14-operations';

const RECOVERY_KEY = 'a'.repeat(64);

function recoveryJournal(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    identityKey: RECOVERY_KEY,
    failures: {},
    order: [],
    progressRevision: 0,
    qualityGuard: { blocked: false, observedFailures: 0 },
  };
}

function step(): Record<string, unknown> {
  return {
    toolName: 'read_file',
    toolArgs: { path: 'README.md' },
    status: 'success',
    ok: true,
    totalLines: 3,
  };
}

function executionJournal(): Record<string, unknown>[] {
  return [
    {
      toolCallId: 'child-read',
      toolName: 'read_file',
      status: 'applied',
      startedAt: 10,
      finishedAt: 11,
      fingerprint: 'f'.repeat(64),
    },
  ];
}

function blockedResult(): Record<string, unknown> {
  const args = { path: 'README.md' };
  const continuation = {
    id: 'child-1',
    role: {
      role: 'explore',
      systemPrompt: 'private system prompt must not be projected',
      allowedTools: new Set(['read_file']),
      model: () => 'private live model',
    },
    task: 'private delegated task must not be projected',
    messages: [{ role: 'user', content: 'private prompt transcript' }],
    toolCallCount: 1,
    modelInvocationOrdinal: 2,
    steps: [step()],
    toolRecovery: recoveryJournal(),
    projectInstructions: { private: 'private project instructions' },
    allowedTools: ['read_file'],
  };
  return {
    ok: false,
    summary: 'Child is waiting for approval.',
    toolCallCount: 1,
    durationMs: 17,
    terminalStatus: 'suspended',
    error: 'approval required',
    steps: [step()],
    executionJournal: executionJournal(),
    exhaustedFingerprints: { 'exhausted-fingerprint': true },
    toolRecovery: recoveryJournal(),
    blocked: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'child-read',
      runtimeToolCallId: 'runtime-child-read',
      toolName: 'read_file',
      args,
      command: 'cat README.md',
      message: 'private blocked diagnostic must not be projected',
      approvalBinding: { secret: 'private approval binding' },
      continuation,
    },
  };
}

function completedResult(): Record<string, unknown> {
  return {
    ok: true,
    summary: 'Plan complete.',
    toolCallCount: 2,
    durationMs: 21,
    terminalStatus: 'completed',
    steps: [step()],
    executionJournal: executionJournal(),
    exhaustedFingerprints: { 'exhausted-fingerprint': true },
    toolRecovery: recoveryJournal(),
  };
}

function project(
  result: Record<string, unknown>,
  input: Record<string, unknown> = { subagent_type: 'explore' },
  phase: 'planning' | 'building' = 'building',
) {
  return projectSubagentResultV1({ input, result, phase });
}

describe('RMV1-14 Builtin subagent result projection', () => {
  test('retains the explicit normal terminal allowlist as exact RuntimeJson', () => {
    const projected = project(completedResult());
    expect(projected).toMatchObject({
      schema: 'kite.builtin-operation-result.v1',
      ok: true,
      stdout: expect.stringContaining('Plan complete.'),
      subagentResult: {
        ok: true,
        summary: 'Plan complete.',
        toolCallCount: 2,
        durationMs: 21,
        terminalStatus: 'completed',
        steps: [
          {
            toolName: 'read_file',
            toolArgs: { path: 'README.md' },
            status: 'success',
            ok: true,
            totalLines: 3,
          },
        ],
        executionJournal: [
          {
            toolCallId: 'child-read',
            toolName: 'read_file',
            status: 'applied',
            startedAt: 10,
            finishedAt: 11,
            fingerprint: 'f'.repeat(64),
          },
        ],
        exhaustedFingerprints: { 'exhausted-fingerprint': true },
        toolRecovery: recoveryJournal(),
      },
    });
    expect(Object.isFrozen(projected.subagentResult)).toBe(true);
    expect(JSON.parse(JSON.stringify(projected.subagentResult))).toEqual(projected.subagentResult);
  });

  test('projects blocked identity and continuation facts without private payloads', () => {
    const projected = project(blockedResult());
    const subagentResult = projected.subagentResult as Record<string, unknown>;
    const blocked = subagentResult.blocked as Record<string, unknown>;
    const continuation = blocked.continuation as Record<string, unknown>;
    expect(blocked).toEqual({
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'child-read',
      runtimeToolCallId: 'runtime-child-read',
      toolName: 'read_file',
      args: { path: 'README.md' },
      command: 'cat README.md',
      continuation: {
        id: 'child-1',
        role: 'explore',
        modelInvocationOrdinal: 2,
        blockedTool: {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-read',
          runtimeToolCallId: 'runtime-child-read',
          toolName: 'read_file',
          args: { path: 'README.md' },
          command: 'cat README.md',
        },
      },
    });
    expect(continuation).not.toHaveProperty('messages');
    expect(continuation).not.toHaveProperty('task');
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('private system prompt');
    expect(serialized).not.toContain('private prompt transcript');
    expect(serialized).not.toContain('private delegated task');
    expect(serialized).not.toContain('private project instructions');
    expect(serialized).not.toContain('private approval binding');
    expect(serialized).not.toContain('private blocked diagnostic');
    expect(JSON.parse(serialized)).toEqual(projected);
  });

  test('keeps planning nextActions in the model text projection', () => {
    const projected = project(completedResult(), { subagent_type: 'plan' }, 'planning');
    expect(projected.stdout).toContain('write_plan:save');
    expect(projected.stdout).toContain('write_plan:submit');
  });

  test.each([
    ['Set', () => ({ ...completedResult(), toolRecovery: new Set(['private']) })],
    ['Map', () => ({ ...completedResult(), toolRecovery: new Map([['private', 1]]) })],
    ['BigInt', () => ({ ...completedResult(), toolRecovery: { value: 1n } })],
    ['unknown field', () => ({ ...completedResult(), privateField: 'unexpected' })],
    ['critical shape', () => ({ ...completedResult(), toolCallCount: -1 })],
  ])('fails closed for %s result shapes', (_name, makeResult) => {
    const projected = project(makeResult());
    expect(projected.ok).toBe(false);
    expect(projected.subagentResult).toBeUndefined();
    expect(projected.stderr).toContain('failed closed');
  });

  test('fails closed for accessors and cycles without invoking them or serializing them', () => {
    let getterCalls = 0;
    const accessorResult = completedResult();
    Object.defineProperty(accessorResult, 'summary', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must not be read';
      },
    });
    const accessorProjection = project(accessorResult);
    expect(accessorProjection.subagentResult).toBeUndefined();
    expect(getterCalls).toBe(0);

    const cyclicRecovery: Record<string, unknown> = {};
    cyclicRecovery.self = cyclicRecovery;
    const cycleProjection = project({ ...completedResult(), toolRecovery: cyclicRecovery });
    expect(cycleProjection.subagentResult).toBeUndefined();
  });

  test('fails closed when blocked continuation identity or fields drift', () => {
    const result = blockedResult();
    const blocked = result.blocked as Record<string, unknown>;
    const continuation = blocked.continuation as Record<string, unknown>;
    const drifted = {
      ...result,
      blocked: {
        ...blocked,
        args: { path: 'other.md' },
        continuation: {
          ...continuation,
          unexpected: 'field',
        },
      },
    };
    const projected = project(drifted);
    expect(projected.subagentResult).toBeUndefined();
    expect(projected.stderr).toContain('failed closed');
  });
});
