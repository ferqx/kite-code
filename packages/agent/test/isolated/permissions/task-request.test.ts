import { expect, test } from 'bun:test';
import type { AuthorizationRequest, Json } from '../../../src/extensions';
import { createDefaultTaskRequestClassifier, defaultTaskRoles } from '../../../src/extensions/task';
import { type CapabilityDescription, createPermissionPolicy } from '../../../src/permissions';

const request = (
  definitionId: string,
  input: Json,
  kind: 'tool' | 'job' = 'tool',
): AuthorizationRequest =>
  ({
    kind,
    definitionId,
    definitionVersion: '1',
    input,
    signal: new AbortController().signal,
  }) as AuthorizationRequest;

test('only exact finite builtin role declarations classify Task creation and carrier as internal records', async () => {
  const describe = createDefaultTaskRequestClassifier(defaultTaskRoles);
  for (const role of defaultTaskRoles) {
    for (const invocation of [
      request('task', { key: 'a', role: role.id, input: { content: 'a' } }),
      request('task.execute', { key: 'a', role: role.id, input: { content: 'a' } }),
      request(`agent/${role.id}`, { content: 'a' }, 'job'),
    ]) {
      expect(describe(invocation)).toMatchObject({
        internalRecordOnly: true,
        effects: ['record_write'],
        safeRead: false,
      });
    }
  }
  for (const id of ['send_message', 'followup_task', 'task_cancel', 'agent/custom'])
    expect(describe(request(id, { role: 'code' }))).toBeUndefined();
  expect(describe(request('task.execute', { role: 'custom' }))).toBeUndefined();
  for (const id of ['plan', 'review']) {
    const original = defaultTaskRoles.find((role) => role.id === id)!;
    expect(
      createDefaultTaskRequestClassifier([{ ...original, toolPolicy: 'parent' }])(
        request('task.execute', { role: id }),
      ),
    ).toBeUndefined();
  }
  expect(
    createDefaultTaskRequestClassifier([
      { id: 'code', version: '1', toolPolicy: 'parent', modelId: 'custom' },
    ])(request('task.execute', { role: 'code' })),
  ).toBeUndefined();
  const original = request('task.execute', { key: 'a', role: 'code', input: { content: 'a' } });
  const capability = {
    kind: original.kind,
    definitionId: original.definitionId,
    definitionVersion: '1',
    hardAllowed: true,
    ...describe(original),
  } as CapabilityDescription;
  const policy = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'auto',
      workspaceTrust: true,
      revision: 'source',
      allowed: [
        { kind: original.kind, definitionId: original.definitionId, definitionVersion: '1' },
      ],
    }),
    describeCapability: () => capability,
  });
  const accepted = await policy.authorize(original);
  expect(accepted.allowed).toBe(true);
  expect(accepted.snapshot).toMatchObject({
    namespace: 'builtin.permissions',
    data: { capability: { internalRecordOnly: true } },
  });
  const changed = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'auto',
      workspaceTrust: true,
      revision: 'source',
      allowed: [
        { kind: original.kind, definitionId: original.definitionId, definitionVersion: '1' },
      ],
    }),
    describeCapability: () => ({ ...capability, internalRecordOnly: undefined }),
  });
  expect((await changed.authorize(original)).allowed).toBe(false);
  expect((await changed.authorize(original)).revision).not.toBe(accepted.revision);
  expect(
    describe(request('task.execute', { key: 'a', role: 'code', input: { content: 'changed' } }))
      ?.revision,
  ).not.toBe(capability.revision);
});
