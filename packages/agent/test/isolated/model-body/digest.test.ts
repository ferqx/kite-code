import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { semanticDigestBytes } from '../../../src/model-body/digest';

test('full semantic verification lets macrotasks progress and hashes the final byte', async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 0x61);
  bytes[bytes.length - 1] = 0x62;
  const expected = createHash('sha256').update(bytes).digest('hex');
  let settled = false;
  const macro = new Promise<boolean>((resolve) => setImmediate(() => resolve(!settled)));
  const reading = semanticDigestBytes(bytes).finally(() => {
    settled = true;
  });
  const [hash, progressed] = await Promise.all([reading, macro]);
  expect(progressed).toBe(true);
  expect(hash).toBe(expected);
  expect(await semanticDigestBytes(new Uint8Array())).toBe(createHash('sha256').digest('hex'));
});

test('semantic verification observes exact in-progress and pre-abort reasons', async () => {
  const controller = new AbortController();
  const reason = new Error('owned_semantic_digest_cancel');
  const bytes = Buffer.alloc(16 * 1024 * 1024, 0x61);
  setImmediate(() => controller.abort(reason));
  const error = await semanticDigestBytes(bytes, controller.signal).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBe(reason);
  const preaborted = await semanticDigestBytes(bytes, controller.signal).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(preaborted).toBe(reason);
  expect(await semanticDigestBytes(Buffer.from('sibling'))).toBe(
    createHash('sha256').update('sibling').digest('hex'),
  );
});
