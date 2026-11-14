import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AgentRuntime } from '@kite-ai/agent';
import { PdfSnapshotRequest } from '../../src/http/schema/pdf-snapshot';
import { createOutputPreviews } from '../../src/output-previews';

const bytes = Buffer.from('%PDF-test');
const input = {
  expectedStoreId: 'store',
  sessionId: 'session',
  sourceHash: createHash('sha256').update(bytes).digest('hex'),
  page: 1,
  data: bytes.toString('base64'),
};
const runtime = {
  getMetadata: async () => ({ storeId: 'store' }),
  getSession: async (id: string) => (id === 'session' ? {} : undefined),
} as unknown as AgentRuntime;
test('PDF snapshot strict schema rejects paths, invalid bounds and malformed base64', () => {
  expect(PdfSnapshotRequest.safeParse(input).success).toBe(true);
  for (const invalid of [
    { ...input, path: '/etc/passwd' },
    { ...input, page: 0 },
    { ...input, page: 501 },
    { ...input, sourceHash: 'bad' },
    { ...input, data: '!!!!' },
  ])
    expect(PdfSnapshotRequest.safeParse(invalid).success).toBe(false);
});
test('PDF snapshot validates store/session/hash before renderer and preserves cancellation', async () => {
  const previews = createOutputPreviews(runtime, '/unused', 'test');
  const signal = new AbortController().signal;
  await expect(
    previews.renderPdfSnapshot({ ...input, expectedStoreId: 'other' }, signal),
  ).rejects.toThrow('store_identity_mismatch');
  await expect(
    previews.renderPdfSnapshot({ ...input, sessionId: 'other' }, signal),
  ).rejects.toThrow('session_not_found');
  await expect(
    previews.renderPdfSnapshot({ ...input, sourceHash: '0'.repeat(64) }, signal),
  ).rejects.toThrow('output_preview_snapshot_invalid');
  await expect(
    previews.renderPdfSnapshot({ ...input, data: input.data + '\n' }, signal),
  ).rejects.toThrow('output_preview_snapshot_invalid');
  const owner = new AbortController();
  owner.abort();
  await expect(previews.renderPdfSnapshot(input, owner.signal)).rejects.toThrow();
});
