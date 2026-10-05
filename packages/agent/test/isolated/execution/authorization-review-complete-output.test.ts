import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { canonicalJson } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';

async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error('Timed out at original complete-output review boundary');
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Shape = 'small' | 'sealed_large' | 'whitespace' | 'invalid_decision' | 'extra_field';
type Fault =
  | 'receipt_digest'
  | 'receipt_model_id'
  | 'receipt_hash'
  | 'receipt_answer'
  | 'model_descriptor'
  | 'artifact_scope'
  | 'artifact_hash'
  | 'artifact_size'
  | 'receipt_registration_scope'
  | 'receipt_registration_hash'
  | 'receipt_registration_size';
const cases: { shape: Shape; fault?: Fault }[] = [
  { shape: 'small' },
  { shape: 'sealed_large' },
  { shape: 'whitespace' },
  { shape: 'invalid_decision' },
  { shape: 'extra_field' },
  ...(
    [
      'receipt_digest',
      'receipt_model_id',
      'receipt_hash',
      'receipt_answer',
      'model_descriptor',
    ] as const
  ).map((fault) => ({ shape: 'sealed_large' as const, fault })),
  { shape: 'whitespace', fault: 'receipt_answer' },
  ...(
    [
      'receipt_registration_scope',
      'receipt_registration_hash',
      'receipt_registration_size',
    ] as const
  ).map((fault) => ({ shape: 'whitespace' as const, fault })),
  ...(['artifact_scope', 'artifact_hash', 'artifact_size'] as const).map((fault) => ({
    shape: 'whitespace' as const,
    fault,
  })),
];
for (const { shape, fault } of cases)
  test(`guarded complete ${shape} review ${fault ?? 'original'} retains original proof and independent Ask`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-review-complete-output-')));
    const evidenceRoot = realpathSync(
      mkdtempSync(join(tmpdir(), `kite-review-${shape}-evidence-`)),
    );
    const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
    const store = await openSqliteStore(profile);
    const artifacts = createArtifactStore({ profile, store });
    const reason = shape === 'small' ? 'Original scoped operation' : 'r'.repeat(6000);
    const reasoning = shape === 'small' ? 'Thought' : '思'.repeat(24000);
    const answer =
      (shape === 'whitespace' ? ' '.repeat(70000) : '') +
      JSON.stringify({
        decision: shape === 'invalid_decision' ? 'allow_everything' : 'approve_once',
        reason,
        ...(shape === 'extra_field' ? { grant: true } : {}),
      });
    let effects = 0;
    let reviews = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const ordinary = createFixedModel([]);
    const dispatch = store.markDispatching.bind(store);
    let targetProof: Parameters<typeof dispatch>[0]['authorization'] | null = null;
    store.markDispatching = async (input) => {
      const result = await dispatch(input);
      if (result.definitionId === 'fixture/guarded') targetProof = { ...input.authorization };
      return result;
    };
    const runtime = createRuntime({
      store,
      artifacts,
      model: ordinary,
      modelId: 'ordinary',
      modelConcurrency: 1,
      authorizationReview: {
        id: 'reviewer',
        version: '1',
        modelId: 'review-model',
        model: {
          async *stream(input) {
            reviews++;
            expect(input.tools).toEqual([]);
            entered = true;
            await gate;
            for (let offset = 0; offset < reasoning.length; offset += 4096)
              yield { type: 'reasoning_delta', text: reasoning.slice(offset, offset + 4096) };
            for (let offset = 0; offset < answer.length; offset += 1024)
              yield { type: 'text_delta', text: answer.slice(offset, offset + 1024) };
            yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
      },
      permissions: {
        async authorize(request) {
          return request.definitionId === 'fixture/guarded'
            ? {
                allowed: false,
                revision: 'p1',
                review: { request: { task: 'exact guarded operation' }, requireApproval: true },
              }
            : { allowed: true, revision: 'trusted' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          actions: [
            {
              id: 'guarded',
              version: '1',
              description: 'Owned complete review result',
              inputSchema: { type: 'object', additionalProperties: false },
              async prepare(_input, context) {
                await context.requireExecutionGroupQuiescent!();
                return {};
              },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'effect once' };
              },
            },
          ],
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: `file://${root}`,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'owned',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'guarded',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'guarded',
          definitionVersion: '1',
          input: {},
        },
      });
      await eventually(async () => (entered ? true : null));
      expect(effects).toBe(0);
      release();
      const carrier = await eventually(
        async () =>
          (await store.listExecutions('s')).find(
            (item) => item.childSessionId && ['succeeded', 'failed'].includes(item.status),
          ) ?? null,
      );
      const target = (await store.listExecutions('s')).find(
        (item) => item.definitionId === 'fixture/guarded',
      )!;
      const models = await store.listExecutions(carrier.childSessionId!);
      expect(models).toHaveLength(1);
      const model = models[0]!;
      expect(model).toMatchObject({
        kind: 'model',
        status: 'succeeded',
        definitionId: 'review-model',
      });
      const scope = {
        expectedStoreId,
        subjectId: 'owner',
        sessionId: carrier.childSessionId!,
        executionId: model.id,
      };
      const snapshot = await store.getModelOutputSnapshot(scope);
      const full = await runtime.readModelOutput(scope);
      expect(full.output.complete).toBe(true);
      expect(full.output.content).toBe(answer);
      expect(full.output.reasoning).toBe(reasoning);
      expect(JSON.parse(full.output.content).reason.length).toBe(reason.length);
      const interactions = (
        await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
      ).interactions;
      const proofInput = {
        expectedStoreId,
        targetExecutionId: target.id,
        reviewExecutionId: carrier.id,
        policyRevision: 'p1',
        request: { task: 'exact guarded operation' },
        requireApproval: true,
        reviewer: { id: 'reviewer', version: '1', modelId: 'review-model' },
      };
      const proof = await store.getAuthorizationReview(proofInput);
      writeFileSync(
        join(evidenceRoot, 'receipt.json'),
        JSON.stringify(
          {
            shape,
            fault,
            expectedStoreId,
            sessionId: 's',
            targetId: target.id,
            carrierId: carrier.id,
            carrierCommandId: carrier.originCommandId,
            childSessionId: carrier.childSessionId,
            modelId: model.id,
            modelRunId: model.runId,
            interactionIds: interactions.map((item) => item.id),
            statuses: { model: model.status, carrier: carrier.status, target: target.status },
            preview: snapshot.content,
            descriptor: snapshot.output,
            proof,
            fullReadComplete: full.output.complete,
            fullContentBytes: Buffer.byteLength(full.output.content),
            fullReasoningBytes: Buffer.byteLength(full.output.reasoning),
            fullContentHash: sha(full.output.content),
            fullReasoningHash: sha(full.output.reasoning),
            effects,
            reviews,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(`complete-output evidence: ${evidenceRoot}/receipt.json`);
      if (shape !== 'small') {
        expect(snapshot.output).not.toBeNull();
        expect(snapshot.content.length).toBeLessThan(answer.length);
        expect(Buffer.byteLength(full.output.reasoning)).toBeGreaterThan(64 * 1024);
      } else expect(snapshot.output).toBeNull();
      const invalid = shape === 'invalid_decision' || shape === 'extra_field';
      if (invalid) expect(proof.decision).not.toBe('approve_once');
      else {
        expect(proof.decision).toBe('approve_once');
        const before = (await store.getMetadata()).lastChangeCursor;
        const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
        try {
          expect(await cold.getAuthorizationReview(proofInput)).toEqual(proof);
          expect((await cold.getMetadata()).lastChangeCursor).toBe(before);
          expect(reviews).toBe(1);
        } finally {
          await cold.close();
        }
      }

      const interaction = await eventually(
        async () =>
          (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
            .interactions[0] ?? null,
      );
      expect(effects).toBe(0);
      if (fault) {
        const db = new Database(join(root, 'data/owned/core.db'));
        try {
          const row = db.query('SELECT result_json FROM execution WHERE id=?').get(carrier.id) as {
            result_json: string;
          };
          const result = JSON.parse(row.result_json);
          if (fault.startsWith('receipt_') && !fault.startsWith('receipt_registration_')) {
            const receipt = result.details.authorizationReviewOutput;
            expect(receipt.kind).toBe('authorization_review_output');
            if (fault === 'receipt_digest') receipt.modelOutputDigest = '0'.repeat(64);
            if (fault === 'receipt_model_id') receipt.modelExecutionId = target.id;
            if (fault === 'receipt_hash') receipt.contentHash = '0'.repeat(64);
            if (fault === 'receipt_answer') receipt.answer.reason = 'Changed finite answer';
          }
          if (fault.startsWith('receipt_registration_')) {
            const refId = `review-output-${result.details.authorizationReviewOutput.modelOutputDigest}`;
            const ref = db.query('SELECT blob_hash FROM blob_ref WHERE id=?').get(refId) as {
              blob_hash: string;
            };
            expect(ref).not.toBeNull();
            if (fault === 'receipt_registration_scope')
              db.run('UPDATE blob_ref SET owner_id=? WHERE id=?', [target.id, refId]);
            if (fault === 'receipt_registration_hash')
              db.run('UPDATE blob_ref SET blob_hash=? WHERE id=?', [
                snapshot.output!.head.hash,
                refId,
              ]);
            if (fault === 'receipt_registration_size')
              db.run('UPDATE blob SET size=1 WHERE hash=?', [ref.blob_hash]);
          }
          if (fault.startsWith('artifact_')) {
            expect(result.modelContent.kind).toBe('artifact');
            if (fault === 'artifact_scope') result.modelContent.reference.scope.id = target.id;
            if (fault === 'artifact_hash') result.modelContent.reference.hash = '0'.repeat(64);
            if (fault === 'artifact_size') result.modelContent.reference.size = '1';
          }
          if (fault === 'model_descriptor') {
            db.run(
              "UPDATE execution SET result_json=json_set(result_json,'$.modelOutput.contentBytes','1') WHERE id=?",
              [model.id],
            );
          } else
            db.run('UPDATE execution SET result_json=? WHERE id=?', [
              canonicalJson(result as Json),
              carrier.id,
            ]);
          let refused = false;
          try {
            refused = (await store.getAuthorizationReview(proofInput)).decision !== 'approve_once';
          } catch {
            refused = true;
          }
          expect(refused).toBe(true);
        } finally {
          db.close();
        }
      }
      await runtime.answerInteraction({
        expectedStoreId,
        commandId: 'answer',
        presentationSessionId: 's',
        interactionId: interaction.id,
        expectedRevision: interaction.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve' },
      });
      await runtime.waitForCommand('guarded');
      if (fault || invalid) {
        expect((await store.getExecution(target.id))!.status).not.toBe('succeeded');
        expect(effects).toBe(0);
        expect(targetProof).toBeNull();
        const db = new Database(join(root, 'data/owned/core.db'));
        try {
          expect(
            db
              .query(
                "SELECT count(*) AS n FROM change_event WHERE object_id=? AND type='execution.dispatching'",
              )
              .get(target.id),
          ).toEqual({ n: 0 });
        } finally {
          db.close();
        }
      } else {
        expect((await store.getExecution(target.id))!.status).toBe('succeeded');
        expect(targetProof).toMatchObject({
          reviewExecutionId: carrier.id,
          interactionId: interaction.id,
        });
        expect(effects).toBe(1);
      }
      expect(reviews).toBe(1);
      expect(ordinary.requests).toEqual([]);
      expect((await store.getView('s')).runs).toEqual([]);
    } finally {
      release();
      await runtime.close();
      await artifacts.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
