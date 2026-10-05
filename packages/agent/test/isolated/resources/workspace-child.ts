import { createWorkspaceSerialLocks } from '../../../src/resources';

const locks = createWorkspaceSerialLocks({
  dataRoot: process.env.TEST_DATA_ROOT!,
  profile: 'test',
});
console.log('started');
await locks.acquire({ workspaceId: 'w', key: 'write' }, new AbortController().signal);
console.log('acquired');
await new Promise<never>(() => {
  setInterval(() => {}, 1000);
});
