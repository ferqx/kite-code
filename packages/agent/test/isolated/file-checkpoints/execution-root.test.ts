import { expect, test } from 'bun:test';
import { digest, point, pointKey, pointType } from '../../../src/business/file-checkpoints/records';
import type { FileCheckpoint } from '../../../src/business/file-checkpoints/types';
import type { ExtensionRecord, Json } from '../../../src/extensions';

function record(
  boundary: FileCheckpoint['boundary'],
  workspace = { device: '1', inode: '2' },
): ExtensionRecord {
  const id = digest(boundary as unknown as Json);
  return {
    sessionId: 's',
    extensionId: 'builtin.files',
    key: pointKey(id),
    revision: '1',
    originStoreId: 'store',
    contentType: pointType,
    contentVersion: 1,
    value: { id, boundary, workspace } as unknown as Json,
  };
}
const legacy: FileCheckpoint['boundary'] = {
  storeId: 'store',
  workspaceId: 'w',
  sessionId: 's',
  runId: 'r',
  contextSelectionId: 'selection',
  messageId: null,
  messageSeq: '0',
  triggerMessageId: 'message',
  triggerSeq: '1',
};

test('saved points retain their original body, ID and revision without root migration or reset', () => {
  const original = record(legacy),
    saved = JSON.stringify(original);
  expect(point(original).boundary.executionRoot).toBeUndefined();
  expect(point(original).id).toBe(digest(legacy as unknown as Json));
  expect(JSON.stringify(original)).toBe(saved);
  const selected = record({
    ...legacy,
    executionRoot: { epoch: '0', identity: { device: '1', inode: '2' } },
  });
  const returned = record({
    ...legacy,
    executionRoot: { epoch: '2', identity: { device: '1', inode: '2' } },
  });
  expect(new Set([point(original).id, point(selected).id, point(returned).id]).size).toBe(3);
});

test('root identity disagreement and undeclared boundary fields cannot become checkpoint authority', () => {
  const invalid = record({
    ...legacy,
    executionRoot: { epoch: '1', identity: { device: '1', inode: '3' } },
  });
  expect(() => point(invalid)).toThrow('checkpoint_scope_conflict');
  const extra = record({
    ...legacy,
    executionRoot: { epoch: '1', identity: { device: '1', inode: '2' }, root: '/untrusted' },
  } as FileCheckpoint['boundary']);
  expect(() => point(extra)).toThrow('checkpoint_record_invalid');
});
