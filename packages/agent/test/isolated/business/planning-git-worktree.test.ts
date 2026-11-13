import { createHash } from 'node:crypto';
import { expect, test } from '#kite-test';
import { createPlanningValidation, planningExtensionId } from '../../../src/business/planning';
import type {
  ConditionReadContext,
  ExtensionRecord,
  Json,
  NecessaryConditionContext,
  PublicExecution,
} from '../../../src/extensions';
import { canonicalJson } from '../../../src/json';
import type { RequirementRef } from '../../../src/storage/types';

const inputDigest = (value: Json) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const requirement: RequirementRef = {
  extensionId: planningExtensionId,
  definitionVersion: '1',
  requirementId: 'plan.required',
  recordKey: 'run/run/plan.required',
  revision: '1',
  sessionId: 'session',
  runId: 'run',
  originStoreId: 'store',
  phase: 'both',
};
const obligation: ExtensionRecord = {
  extensionId: planningExtensionId,
  key: requirement.recordKey,
  revision: '1',
  sessionId: 'session',
  originStoreId: 'store',
  contentType: 'builtin.planning.record',
  contentVersion: 1,
  value: { kind: 'plan', runId: 'run', requirementId: 'plan.required', readOnlyDefinitions: [] },
};
function fixture(input: Json, kind: 'tool' | 'job' = 'tool') {
  const actual: PublicExecution = {
    id: 'execution',
    sessionId: 'session',
    runId: 'run',
    kind,
    definitionId: kind === 'tool' ? 'git.worktree' : 'shell.command',
    definitionVersion: '1',
    attempt: 1,
    inputDigest: inputDigest(input),
    status: 'planned',
    result: null,
    resultRevision: '0',
    originStoreId: 'store',
  };
  const boundary: NecessaryConditionContext['boundary'] = {
    sessionId: 'session',
    runId: 'run',
    executionId: actual.id,
    kind: actual.kind,
    definitionId: actual.definitionId!,
    definitionVersion: '1',
    attempt: 1,
  };
  const read: ConditionReadContext = {
    sessionId: 'session',
    async getRun(id) {
      return {
        id,
        requirements: [requirement],
        sessionId: 'session',
        status: 'running',
        isActive: true,
        createdAt: 0,
        finishedAt: null,
      };
    },
    async getExecution() {
      return actual;
    },
    records: {
      async get(key) {
        return key === obligation.key ? obligation : null;
      },
    },
  };
  let calls = 0;
  const planning = createPlanningValidation(
    {},
    undefined,
    async () => input,
    undefined,
    async (execution, frozenInput) => {
      calls++;
      expect(execution).toEqual(actual);
      expect(Object.isFrozen(execution)).toBe(true);
      expect(Object.isFrozen(frozenInput)).toBe(true);
      return kind === 'tool'
        ? (frozenInput as { action: string }).action === 'list'
        : (frozenInput as { command: string }).command === 'trusted-list-command';
    },
  );
  return {
    actual,
    boundary,
    read,
    calls: () => calls,
    async evaluate(phase: 'dispatch' | 'completion' = 'dispatch') {
      return (
        await planning.conditions.evaluate([requirement], phase, {
          boundary,
          async forRequirement() {
            return read;
          },
        })
      )[0]!;
    },
  };
}
test('planning exemption asks trusted Host only for the verified list Tool or original readonly worker Job', async () => {
  for (const [input, kind] of [
    [{ action: 'list' }, 'tool'],
    [{ command: 'trusted-list-command' }, 'job'],
  ] as const) {
    const f = fixture(input, kind);
    expect(await f.evaluate()).toMatchObject({
      outcome: 'satisfied',
      evidence: { reason: 'planning_read_only_git_worktree' },
    });
    expect(f.calls()).toBe(1);
  }
  for (const input of [
    { action: 'create', key: 'key', path: '/target' },
    { action: 'remove', key: 'key', path: '/target' },
  ]) {
    const f = fixture(input);
    expect((await f.evaluate()).outcome).toBe('unsatisfied');
    expect(f.calls()).toBe(1);
  }
});
test('planning list exemption rejects mismatched frozen input, identity, Run, attempt and definition', async () => {
  const corruptions: Partial<PublicExecution>[] = [
    { id: 'other' },
    { sessionId: 'other' },
    { runId: 'other' },
    { attempt: 2 },
    { kind: 'job' },
    { definitionId: 'custom.worktree' },
    { definitionVersion: '2' },
    { inputDigest: '0'.repeat(64) },
  ];
  for (const corruption of corruptions) {
    const f = fixture({ action: 'list' });
    Object.assign(f.actual, corruption);
    expect((await f.evaluate()).outcome).toBe('unsatisfied');
    expect(f.calls()).toBe(0);
  }
  for (const corruption of [
    { kind: 'tool' as const, definitionId: 'shell.execute' },
    { definitionVersion: '2' },
  ]) {
    const f = fixture({ action: 'list' });
    Object.assign(f.boundary, corruption);
    Object.assign(f.actual, corruption);
    expect((await f.evaluate()).outcome).toBe('unsatisfied');
    expect(f.calls()).toBe(0);
  }
});
test('planning list exception does not waive completion or an inherited plan continuation', async () => {
  const completion = fixture({ action: 'list' });
  Object.assign(completion.boundary, {
    executionId: null,
    kind: null,
    definitionId: null,
    definitionVersion: null,
    attempt: null,
  });
  expect((await completion.evaluate('completion')).outcome).toBe('unsatisfied');
  expect(completion.calls()).toBe(0);
  const inherited = fixture({ action: 'list' });
  inherited.boundary.runId = 'next-run';
  inherited.actual.runId = 'next-run';
  expect((await inherited.evaluate()).outcome).toBe('unsatisfied');
  expect(inherited.calls()).toBe(0);
});

test('inherited parent plan never reads a child Shell or worktree boundary through the parent read scope', async () => {
  for (const definitionId of ['shell.execute', 'git.worktree']) {
    const f = fixture({ action: 'list' });
    let reads = 0;
    let classifications = 0;
    const planning = createPlanningValidation(
      {},
      undefined,
      async () => {
        classifications++;
        return {};
      },
      async () => {
        classifications++;
        return true;
      },
      async () => {
        classifications++;
        return true;
      },
    );
    const evaluated = await planning.conditions.evaluate([requirement], 'dispatch', {
      boundary: { ...f.boundary, sessionId: 'child', runId: 'child-run', definitionId },
      async forRequirement() {
        return {
          ...f.read,
          async getExecution() {
            reads++;
            throw new Error('foreign_execution_read');
          },
        };
      },
    });
    expect(evaluated[0]!.outcome).toBe('unsatisfied');
    expect(reads).toBe(0);
    expect(classifications).toBe(0);
  }
});
