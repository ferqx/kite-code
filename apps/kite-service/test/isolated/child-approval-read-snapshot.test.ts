import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiteSessionAppServerStorageComposition } from '../../src/bootstrap';

test('cold parent projection can read child approvals within its existing Store snapshot', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-child-approval-snapshot-'));
  const owner = await createKiteSessionAppServerStorageComposition({
    databasePath: join(root, 'kite-session.sqlite'),
    hostInstanceId: 'child-approval-snapshot-test',
  });
  try {
    expect(owner.readSnapshot(() => owner.listPendingChildApprovalProxies('parent', 10))).toEqual(
      [],
    );
  } finally {
    owner.disposeStorage();
    rmSync(root, { recursive: true, force: true });
  }
});
