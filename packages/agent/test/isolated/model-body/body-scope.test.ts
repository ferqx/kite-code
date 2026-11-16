import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { captureModelRequestMetadata, modelMetadataJson } from '../../../src/model-snapshot';
import { openSqliteStore } from '../../../src/sqlite';
import type { ArtifactReference } from '../../../src/storage/types';

async function failureCode(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

for (const identicalRequest of [false, true])
  test(`Auto seals ${identicalRequest ? 'identical large public requests' : 'identical small private metadata'} independently across sessions`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-body-scope-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const artifacts = createArtifactStore({ profile, store });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const publications: ArtifactReference[] = [];
    let metadataHash = '';
    let reviews = 0;
    let effects = 0;
    const reviewer: ModelAdapter = {
      async *stream() {
        reviews++;
        yield {
          type: 'text_delta',
          text: '{"decision":"approve_once","reason":"Synthetic exact action authorized"}',
        };
        yield finish;
      },
    };
    const runtime = createRuntime({
      store,
      artifacts: {
        ...artifacts,
        async publish(input) {
          const reference = await artifacts.publish(input);
          publications.push(reference);
          return reference;
        },
      },
      model: {
        async *stream() {
          yield finish;
        },
      },
      modelId: 'unused-model',
      modelConcurrency: 4,
      authorizationCheck: { id: 'review', version: '1', modelId: 'review-model', model: reviewer },
      permissions: {
        async authorize(request) {
          return request.definitionId === 'fixture/effect'
            ? {
                allowed: false,
                revision: 'synthetic-policy',
                check: {
                  request: {
                    task: 'Run this harmless synthetic action',
                    material: 'synthetic-'.repeat(8000),
                    ...(!identicalRequest ? { sessionId: request.sessionId } : {}),
                  },
                },
              }
            : { allowed: true, revision: 'synthetic-policy' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          actions: [
            {
              id: 'effect',
              version: '1',
              description: 'Harmless synthetic counter',
              inputSchema: { type: 'object', properties: { nonce: { type: 'string' } } },
              async prepare(input) {
                return input;
              },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'Synthetic action completed' };
              },
            },
          ],
        },
      ],
    });
    const owner = (sessionId: string) => ({
      expectedStoreId,
      sessionId,
      subjectId: `owner-${sessionId}`,
    });
    const references = async (sessionId: string) => {
      const models = (await store.listExecutions(sessionId)).filter(
        (execution) => execution.kind === 'model',
      );
      expect(models.every((execution) => execution.status === 'succeeded')).toBe(true);
      return publications.filter(
        (reference) => reference.sessionId === sessionId && reference.hash === metadataHash,
      );
    };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'synthetic',
        rootUri: pathToFileURL(root).href,
      });
      for (const sessionId of ['first', 'second', 'concurrent-a', 'concurrent-b'])
        await runtime.createSession({
          ...owner(sessionId),
          commandId: `create-${sessionId}`,
          workspaceId: 'w',
          title: sessionId,
        });
      const metadata = modelMetadataJson(
        await captureModelRequestMetadata({}, reviewer, {
          modelId: 'review-model',
          requestId: 'metadata-shape-only',
          messages: [],
          tools: [],
        }),
      );
      expect(Buffer.byteLength(canonicalJson(metadata))).toBeLessThan(64 * 1024);
      metadataHash = await semanticDigest(metadata);
      const legacy = await artifacts.publish({
        ...owner('first'),
        scope: { kind: 'session', id: 'first' },
        refId: `model-body-${await semanticDigest(metadata)}`,
        mediaType: 'application/json',
        content: Buffer.from(canonicalJson(metadata)),
      });
      const run = async (sessionId: string, nonce: string) => {
        const commandId = `${sessionId}-${nonce}`;
        await runtime.submitCommand({
          ...owner(sessionId),
          commandId,
          request: {
            kind: 'extension.invoke',
            extensionId: 'fixture',
            actionId: 'effect',
            definitionVersion: '1',
            input: { nonce },
          },
        });
        await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
        const action = (await store.listExecutions(sessionId)).find(
          (execution) =>
            execution.originCommandId === commandId && execution.definitionId === 'fixture/effect',
        );
        expect(action?.status).toBe('succeeded');
      };
      await run('first', 'one');
      await run('first', 'two');
      await run('second', 'one');
      await Promise.all([run('concurrent-a', 'one'), run('concurrent-b', 'one')]);
      expect(effects).toBe(5);
      expect(reviews).toBe(5);
      const first = await references('first');
      expect(first).toHaveLength(2);
      expect(first[0]).toEqual(first[1]);
      expect(first[0]!.hash).toBe(legacy.hash);
      const refs = [
        first[0]!,
        ...(await references('second')),
        ...(await references('concurrent-a')),
        ...(await references('concurrent-b')),
      ];
      expect(new Set(refs.map((reference) => reference.id)).size).toBe(4);
      expect(new Set(refs.map((reference) => reference.hash)).size).toBe(1);
      for (const reference of refs) {
        expect(reference.id).toStartWith('model-body-');
        expect(reference.id.length).toBeLessThanOrEqual(128);
        expect(
          JSON.parse(
            Buffer.from(
              await artifacts.readReference({
                expectedStoreId,
                reference,
              }),
            ).toString(),
          ),
        ).toEqual(metadata);
        expect(
          await failureCode(
            artifacts.read({
              ...owner(reference.sessionId === 'second' ? 'first' : 'second'),
              refId: reference.id,
              scope: { kind: 'session', id: reference.sessionId === 'second' ? 'first' : 'second' },
            }),
          ),
        ).toBe('artifact_reference_not_found');
      }
      expect(
        JSON.parse(
          Buffer.from(
            await artifacts.readReference({ expectedStoreId, reference: legacy }),
          ).toString(),
        ),
      ).toEqual(metadata);
      expect(
        await failureCode(
          artifacts.read({
            ...owner('second'),
            refId: legacy.id,
            scope: { kind: 'session', id: 'second' },
          }),
        ),
      ).toBe('artifact_reference_not_found');
      expect(
        await failureCode(
          artifacts.read({
            ...owner('first'),
            subjectId: 'owner-second',
            refId: legacy.id,
            scope: legacy.scope,
          }),
        ),
      ).toBe('artifact_scope_denied');
      expect(
        await failureCode(
          artifacts.publish({
            ...owner('first'),
            scope: legacy.scope,
            refId: legacy.id,
            mediaType: legacy.mediaType,
            content: Buffer.from('{"changed":true}'),
          }),
        ),
      ).toBe('artifact_reference_conflict');
      const requests = publications.filter((reference) =>
        reference.id.startsWith('authorization-check-request-'),
      );
      expect(new Set(requests.map((reference) => reference.id)).size).toBe(4);
      expect(new Set(requests.map((reference) => reference.hash)).size).toBe(
        identicalRequest ? 1 : 4,
      );
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
