import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import {
  object,
  planningBusinessCases,
  runPlanningBusinessCase,
  selectPlanningBusinessCases,
  verifyPlanningBusinessEvidence,
} from './planning-business-approval-fixture';

test('planning live selection keeps exact six directions and rejects unknown or duplicate cases', () => {
  const directions = planningBusinessCases.filter((entry) => entry.nextMode);
  expect(directions).toHaveLength(6);
  expect(new Set(directions.map((entry) => `${entry.mode}:${entry.nextMode}`)).size).toBe(6);
  expect(selectPlanningBusinessCases('plan-full').map((entry) => entry.id)).toEqual(['plan-full']);
  expect(() => selectPlanningBusinessCases('missing')).toThrow('unknown_case');
  expect(() => selectPlanningBusinessCases('plan-full,plan-full')).toThrow('duplicate_case');
});

for (const entry of planningBusinessCases) {
  test.skipIf(process.platform !== 'darwin')(
    `production Service fixed SDK planning/business ${entry.id}`,
    async () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-planning-business-fixed-')));
      const root = join(parent, 'case');
      const result = await runPlanningBusinessCase({
        entry,
        root,
        provider: 'fixed-loopback',
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(
        result.status,
        'passed',
        `retained ${root}/result.json: ${JSON.stringify(result.failure)}`,
      );
      expect(result.cleanupConfirmed).toBe(true);
      expect(result.cold).toMatchObject({ sameRows: true, sameEffects: true, providerRequests: 0 });
      assert(result.evidence);
      const card = result.evidence.interactions.find(
        (row) => row.id === result.evidence!.businessCardId,
      )!;
      const requests = result.requests as {
        role: string;
        body: { messages: { role: string; content: unknown }[] };
      }[];
      const originalReview = result.evidence.records.find((row) => row.id === card.executionId)!;
      const originalContent = (originalReview.result as { content: string }).content;
      const postAnswer = requests
        .filter((request) => request.role === 'business')
        .some((request) =>
          request.body.messages.some(
            (message) => message.role === 'tool' && message.content === originalContent,
          ),
        );
      expect(postAnswer).toBe(true);
      expect(card.acceptedDecisionRevision).not.toBeNull();
      const saved = readFileSync(join(root, 'result.json'), 'utf8');
      expect(JSON.parse(saved).status).toBe('passed');
      expect(saved.includes('"baseURL":')).toBe(false);
      const broken = structuredClone(result.evidence);
      broken.interactions.find(
        (row) => row.id === broken.businessCardId,
      )!.acceptedDecisionRevision = null;
      expect(() => verifyPlanningBusinessEvidence(broken)).toThrow('saved_answer_not_accepted');
      const duplicate = structuredClone(result.evidence);
      duplicate.records.push(
        structuredClone(
          duplicate.records.find(
            (row) => row.kind === 'tool' && row.definitionId === 'shell.execute',
          )!,
        ),
      );
      expect(() => verifyPlanningBusinessEvidence(duplicate)).toThrow('shell_tool_not_unique');
    },
    25000,
  );
}

test.skipIf(process.platform !== 'darwin')(
  'default general child unavailable spawn is an exact rejection with no grandchild model or dispatch',
  async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-planning-grandchild-negative-')));
    const root = join(parent, 'case');
    const entry = {
      ...planningBusinessCases.find((item) => item.id === 'direct-general')!,
      id: 'grandchild-unavailable',
      mode: 'full' as const,
    };
    const result = await runPlanningBusinessCase({
      entry,
      root,
      provider: 'fixed-loopback',
      signal: AbortSignal.timeout(20000),
      attemptUnavailableGrandchild: true,
    });
    assert.equal(
      result.status,
      'passed',
      `retained ${root}/result.json: ${JSON.stringify(result.failure)}`,
    );
    assert(result.evidence);
    expect(result.cohort).toBe('controlled-negative-grandchild-boundary-not-positive-denominator');
    const child = result.evidence.sessions.find((session) => session.id !== 's')!;
    const rejected = result.evidence.records.filter(
      (row) => row.sessionId === child.id && row.definitionId === 'spawn_agent',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.status).toBe('failed');
    expect(object(object(rejected[0]!.result).details).code).toBe('tool_not_available');
    expect(result.dispatchObservations.some((row) => row.executionId === rejected[0]!.id)).toBe(
      false,
    );
    expect(result.evidence.sessions).toHaveLength(2);
    const models = result.evidence.records.filter((row) => row.kind === 'model');
    expect(models.every((row) => row.sessionId === 's' || row.sessionId === child.id)).toBe(true);
    const childRequests = (
      result.requests as {
        body: {
          tools?: { function?: { name?: string } }[];
          messages: { role: string; content: unknown; tool_call_id?: string }[];
        };
      }[]
    ).filter(
      (request) =>
        !(request.body.tools ?? []).some((tool) => tool.function?.name === 'spawn_agent') &&
        !!request.body.tools,
    );
    expect(
      childRequests.some((request) =>
        request.body.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === rejected[0]!.callId &&
            String(message.content).includes('not available in the current model tool catalogue'),
        ),
      ),
    ).toBe(true);
    expect(result.cleanupConfirmed).toBe(true);
  },
  25000,
);
