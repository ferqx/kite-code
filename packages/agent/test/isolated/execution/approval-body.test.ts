import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionRecord, Json } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function pending(runtime: ReturnType<typeof createRuntime>, storeId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const page = await runtime.listInteractions({
      expectedStoreId: storeId,
      sessionId: 's',
      state: 'pending',
    });
    if (page.interactions[0]) return page.interactions[0];
    await Bun.sleep(10);
  }
  throw new Error('approval not created');
}
for (const change of ['none', 'policy', 'artifact_bytes'] as const) {
  test(`complete manual approval keeps exact large input and rejects ${change} drift`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-approval-body-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'new' };
    const store = await openSqliteStore(profile);
    const artifacts = createArtifactStore({ profile, store });
    let changed = false,
      effects = 0;
    const input = { body: '完整'.repeat(40000), tail: 'EXACT_LAST_BYTE' };
    const model = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'large',
          name: 'fixture.effect',
          arguments: JSON.stringify(input),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      ...(change === 'none'
        ? [
            [
              {
                type: 'tool_call' as const,
                id: 'large-second',
                name: 'fixture.effect',
                arguments: JSON.stringify(input),
              },
              { ...finish, reason: 'tool_calls' as const },
            ],
          ]
        : []),
      [finish],
    ]);
    const read = artifacts.read.bind(artifacts);
    const readReference = artifacts.readReference.bind(artifacts);
    function drift(refId: string, content: Uint8Array) {
      if (changed && change === 'artifact_bytes' && refId.startsWith('approval-body-')) {
        const corrupt = new Uint8Array(content);
        corrupt[corrupt.length - 2] = corrupt[corrupt.length - 2]! ^ 1;
        return corrupt;
      }
      return content;
    }
    artifacts.read = async (request) => drift(request.refId, await read(request));
    artifacts.readReference = async (request) =>
      drift(request.reference.id, await readReference(request));
    const runtime = createRuntime({
      store,
      artifacts,
      model,
      modelId: 'fixed',
      modelConcurrency: 1,
      permissions: {
        async authorize(request) {
          if (request.kind === 'model') return { allowed: true, revision: 'fixed' };
          return {
            allowed: false,
            revision: 'minimum-user',
            approval: {
              request: {
                title:
                  changed && change === 'policy'
                    ? 'different request same revision'
                    : 'Exact request',
                policyBody: 'P'.repeat(70000),
              },
            },
          };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.effect',
              version: '1',
              description: 'Harmless exact large input',
              inputSchema: { type: 'object' },
              async execute(value) {
                expect(value).toEqual(input);
                effects++;
                return { outcome: 'succeeded', content: 'exact' };
              },
            },
          ],
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: `file://${root}`,
      });
      await runtime.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 's',
      });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'explicit large effect' },
      });
      const card: InteractionRecord = await pending(runtime, expectedStoreId);
      expect(effects).toBe(0);
      const envelope = card.request as {
        policy: {
          review: {
            kind: string;
            complete: boolean;
            reference: { id: string; size: string; scope: { kind: 'execution'; id: string } };
          };
        };
        approvalRequestDigest: string;
      };
      expect(envelope.policy.review.kind).toBe('artifact');
      expect(envelope.policy.review.complete).toBe(true);
      expect(envelope.policy.review.reference.scope).toEqual({
        kind: 'execution',
        id: card.executionId,
      });
      expect(Buffer.byteLength(JSON.stringify(card.request))).toBeLessThan(32768);
      const body = await runtime.readArtifact({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        refId: envelope.policy.review.reference.id,
        scope: envelope.policy.review.reference.scope,
      });
      const full = JSON.parse(new TextDecoder().decode(body.content)) as {
        input: Json;
        policy: { policyBody: string };
      };
      expect(full.input).toEqual(input);
      expect(full.policy.policyBody.length).toBe(70000);
      expect(body.reference.hash).toBe(envelope.approvalRequestDigest);
      expect((await runtime.getExecution(card.executionId))?.input).toEqual(input);
      changed = true;
      await runtime.answerInteraction({
        expectedStoreId,
        commandId: 'answer',
        presentationSessionId: 's',
        subjectId: 'owner',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve' },
      });
      if (change === 'none') {
        const second = await pending(runtime, expectedStoreId);
        const secondEnvelope = second.request as typeof envelope;
        expect(second.executionId).not.toBe(card.executionId);
        expect(secondEnvelope.approvalRequestDigest).toBe(envelope.approvalRequestDigest);
        expect(secondEnvelope.policy.review.reference.id).not.toBe(
          envelope.policy.review.reference.id,
        );
        expect(secondEnvelope.policy.review.reference.scope.id).toBe(second.executionId);
        await runtime.answerInteraction({
          expectedStoreId,
          commandId: 'answer-second',
          presentationSessionId: 's',
          subjectId: 'owner',
          interactionId: second.id,
          expectedRevision: second.revision,
          answer: { kind: 'approval', decision: 'approve' },
        });
      }
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(effects).toBe(change === 'none' ? 2 : 0);
      const saved = await runtime.getInteraction({
        expectedStoreId,
        sessionId: 's',
        interactionId: card.id,
      });
      expect(saved?.answer?.kind).toBe('approval');
      expect(saved?.acceptedDecisionRevision !== null).toBe(change === 'none');
      const effect = await runtime.getExecution(card.executionId);
      expect(effect?.status).toBe(change === 'none' ? 'succeeded' : 'failed');
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
}
