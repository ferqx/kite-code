import { expect, test } from 'bun:test';
import { interactionAttachment } from '../src';
import { largeInteractionFixture } from './fixtures/large-interaction';

async function failure(read: () => Promise<unknown>) {
  try {
    await read();
    return undefined;
  } catch (error) {
    return error;
  }
}

test('actual large Auto human attachment is complete over authenticated Service, exact metadata/hash/scope verified, and GET cannot dispatch work', async () => {
  const f = await largeInteractionFixture();
  try {
    const card = await f.start();
    const intent = interactionAttachment(card)!;
    expect(BigInt(intent.reference.size)).toBeGreaterThan(17n * 1024n * 1024n);
    const cursor = f.client.lastAppliedCursor;
    const change = (await f.store.getMetadata()).lastChangeCursor;
    const body = await f.client.readInteractionAttachment(card);
    expect(JSON.parse(body.text).task).toBe(f.body);
    expect(JSON.parse(body.text).plan.full).toBe('actual fixed plan');
    expect(body.content.byteLength).toBe(Number(intent.reference.size));
    expect(body.reference.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.effects()).toBe(0);
    expect(f.reviewer.requests).toHaveLength(1);
    expect(f.client.lastAppliedCursor).toEqual(cursor);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(change);
    expect(
      await failure(() =>
        f.client.readArtifact(
          'other',
          { expectedStoreId: f.storeId, refId: intent.reference.id, scope: intent.reference.scope },
          { expectedReference: intent.reference },
        ),
      ),
    ).toMatchObject({ code: 'artifact_scope_denied' });
    expect(
      await failure(() =>
        f.client.readArtifact(
          's',
          {
            expectedStoreId: f.storeId,
            refId: intent.reference.id,
            scope: { kind: 'execution', id: card.executionId },
          },
          { expectedReference: intent.reference },
        ),
      ),
    ).toMatchObject({ code: 'artifact_reference_not_found' });
    expect(
      await failure(() =>
        f.client.readArtifact(
          's',
          { expectedStoreId: f.storeId, refId: intent.reference.id, scope: intent.reference.scope },
          { expectedReference: { ...intent.reference, hash: '0'.repeat(64) } },
        ),
      ),
    ).toMatchObject({ code: 'artifact_metadata_mismatch' });
    f.setCorrupt(true);
    expect(await failure(() => f.client.readInteractionAttachment(card))).toMatchObject({
      code: 'artifact_content_mismatch',
    });
    expect(f.effects()).toBe(0);
    const abort = new AbortController();
    abort.abort();
    expect(
      await failure(() => f.client.readInteractionAttachment(card, { signal: abort.signal })),
    ).toMatchObject({ name: 'AbortError' });
    expect((await f.client.getInteraction('s', card.id, { storeId: f.storeId })).state).toBe(
      'pending',
    );
    expect((await f.store.getView('s')).runs[0]!.status).not.toBe('cancelled');
  } finally {
    await f.close();
  }
}, 30000);
