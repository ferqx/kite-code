import { strict as assert } from 'node:assert';
import { selectProfile } from '@kite-ai/agent/profile';
import type { AgentClient } from '@kite-ai/client';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';
import { NativeWorkspaceRemovalPort } from '../electron/workspace-removal';

const input = JSON.parse(process.argv[2]!);
const lease = await acquireDesktopProfileAccess(input.access),
  data = openPrivateData(selectProfile(input.access.profile).profilePath, lease);
try {
  if (input.action === 'seed')
    data.saveWorkspaceRemoval({
      request: { expectedStoreId: input.storeId, commandId: 'original-remove' },
      workspaceId: 'w',
      subjectId: 'user',
      label: '原空间🙂',
      phase: 'unknown',
    });
  let http = 0;
  const client = {
    getWorkspaceRemoval: async () => {
      http++;
      throw Error('foreign saved intention must not reach HTTP');
    },
  } as unknown as AgentClient;
  const caller = new NativeWorkspaceRemovalPort(
    client,
    () => data,
    () => ({ generation: 1, storeId: input.storeId, subjectId: 'user' }),
    () => undefined,
    () => {},
  );
  const before = data.workspaceRemovals();
  if (input.action === 'cold') {
    assert.equal((await caller.lookup('original-remove')).error, 'workspace_origin_unavailable');
    assert.deepEqual(data.workspaceRemovals(), before);
    assert.equal(http, 0);
  }
  console.log(JSON.stringify({ rows: before, http }));
} finally {
  data.close();
  await lease.close();
}
