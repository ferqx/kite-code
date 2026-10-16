import { expect, test } from 'bun:test';
import { decodeNativeRequest } from '../electron/native-ipc';

const input = {
  id: 'task',
  name: 'Review',
  prompt: 'Review the project',
  workspaceId: 'workspace',
  modelId: 'fixed',
  storeId: 'store',
  enabled: true,
  schedule: { frequency: 'weekdays', time: '09:30', timeZone: 'Asia/Shanghai' },
} as const;
test('scheduled IPC is closed and accepts only local bounded schedule data', () => {
  const request = { method: 'scheduled.save', operation: 'create', generation: 1, input } as const;
  expect(decodeNativeRequest(request)).toEqual(request);
  for (const bad of [
    { ...request, extra: true },
    { ...request, operation: undefined },
    { ...request, operation: 'upsert' },
    { ...request, operation: 'update', input: { ...input, id: undefined } },
    { ...request, generation: 0 },
    { ...request, input: { ...input, environment: 'worktree' } },
    { ...request, input: { ...input, schedule: { ...input.schedule, cron: '*' } } },
    { ...request, input: { ...input, schedule: { ...input.schedule, timeZone: 'Not/AZone' } } },
    { ...request, input: { ...input, schedule: { ...input.schedule, time: '25:00' } } },
    { method: 'scheduled.toggle', generation: 1, id: 'task', enabled: 'true' },
    { method: 'scheduled.delete', generation: 1, id: '../task' },
  ])
    expect(() => decodeNativeRequest(bad)).toThrow();
  for (const method of ['scheduled.runNow', 'scheduled.delete'] as const) {
    expect(decodeNativeRequest({ method, generation: 1, id: 'task' })).toEqual({
      method,
      generation: 1,
      id: 'task',
    });
  }
});
