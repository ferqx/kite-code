import { expect, test } from 'bun:test';
import type { AgentRuntime } from '@kite-ai/agent';
import type { CommandRecord, RunRecord } from '@kite-ai/agent/storage';
import { readBoundPlanningSuccessor } from '../../src/planning-configuration';

function fixture() {
  const scope = {
    originStoreId: 'store',
    sessionId: 's',
    rootWorkCommandId: 'A',
    rootWorkSeq: '2',
  };
  const prior = {
    ...scope,
    id: 'A-run',
    originCommandId: 'A',
    contextSelectionId: 'selection',
    status: 'completed',
    isActive: false,
    configuration: { original: 'A' },
    requirements: [{ runId: 'A-run', recordKey: 'run/A-run/plan.required', revision: '1' }],
  } as unknown as RunRecord;
  const successor = {
    ...prior,
    id: 'A-continued',
    originCommandId: 'business',
    status: 'running',
    isActive: true,
  } as RunRecord;
  const raw = {
    ...scope,
    id: 'raw',
    kind: 'human.input',
    subjectId: 'owner',
    requestDigest: 'raw-digest',
    cancelRequestedAt: null,
    request: {
      publicCommandId: 'public',
      originalRequest: { kind: 'input.follow_up', content: 'continue A' },
    },
    receipt: { businessCommandId: 'business', applicationState: 'applied', runId: successor.id },
  } as unknown as CommandRecord;
  const decision = {
    ...scope,
    id: 'decision',
    kind: 'human.input.decision',
    status: 'applied',
    subjectId: 'owner',
    cancelRequestedAt: null,
    request: {
      inputCommandId: raw.id,
      inputDigest: raw.requestDigest,
      proposal: { relation: 'same_work' },
    },
    receipt: {
      continuationRunId: prior.id,
      targetRootWorkCommandId: 'A',
      businessCommandId: 'business',
    },
  } as unknown as CommandRecord;
  const business = {
    ...scope,
    id: 'business',
    kind: 'input.follow_up',
    status: 'applied',
    subjectId: 'owner',
    cancelRequestedAt: null,
    receipt: {
      humanInputCommandId: raw.id,
      decisionCommandId: decision.id,
      continuationRunId: prior.id,
      runId: successor.id,
    },
  } as unknown as CommandRecord;
  const publicCommand = {
    ...scope,
    id: 'public',
    subjectId: 'owner',
    kind: 'input.follow_up',
    status: 'applied',
    cancelRequestedAt: null,
    request: { kind: 'input.follow_up', content: 'continue A' },
    receipt: {
      humanInputCommandId: raw.id,
      decisionCommandId: decision.id,
      businessCommandId: business.id,
      runId: successor.id,
    },
  } as unknown as CommandRecord;
  const commands = new Map(
    [raw, decision, business, publicCommand].map((command) => [command.id, command]),
  );
  const runs = new Map([prior, successor].map((run) => [run.id, run]));
  const runtime = {
    getCommand: async (id: string) => commands.get(id) ?? null,
    getRun: async (id: string) => runs.get(id) ?? null,
  } as unknown as AgentRuntime;
  return { runtime, prior, successor, raw, decision, business, publicCommand };
}

test('same-work planning successor requires the exact public/raw/decision/business chain and preserves original A scope', async () => {
  const f = fixture();
  expect(
    await readBoundPlanningSuccessor(
      f.runtime,
      'store',
      { runId: f.prior.id, sessionId: 's' },
      f.successor,
      f.business,
    ),
  ).toBe(f.prior);
  // Raw human invocations have their own identity; only the sealed business and Run inherit A.
  Object.assign(f.raw, { rootWorkCommandId: 'raw', rootWorkSeq: '8' });
  expect(
    await readBoundPlanningSuccessor(
      f.runtime,
      'store',
      { runId: f.prior.id, sessionId: 's' },
      f.successor,
    ),
  ).toBe(f.prior);
});

test('planning successor rejects forged, independent, changed configuration and cross-work proofs', async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      (f.publicCommand.receipt as Record<string, unknown>).humanInputCommandId = 'other-raw';
    },
    (f) => {
      (
        (f.decision.request as Record<string, unknown>).proposal as Record<string, unknown>
      ).relation = 'independent_work';
    },
    (f) => {
      (f.decision.receipt as Record<string, unknown>).continuationRunId = 'B-run';
    },
    (f) => {
      (f.decision.receipt as Record<string, unknown>).targetRootWorkCommandId = 'B';
    },
    (f) => {
      (f.business.receipt as Record<string, unknown>).runId = 'B-run';
    },
    (f) => {
      (f.raw.receipt as Record<string, unknown>).businessCommandId = 'other-business';
    },
    (f) => {
      Object.assign(f.successor, { configuration: { original: 'B' } });
    },
    (f) => {
      Object.assign(f.successor, { rootWorkCommandId: 'B' });
    },
    (f) => {
      Object.assign(f.successor, { contextSelectionId: 'other-selection' });
    },
    (f) => {
      Object.assign(f.successor, { requirements: [] });
    },
    (f) => {
      Object.assign(f.business, { cancelRequestedAt: 1 });
    },
    (f) => {
      Object.assign(f.publicCommand, { subjectId: 'foreign' });
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await expect(
      readBoundPlanningSuccessor(
        f.runtime,
        'store',
        { runId: f.prior.id, sessionId: 's' },
        f.successor,
      ),
    ).rejects.toMatchObject({ code: 'planning_run_scope_unavailable' });
  }
});
