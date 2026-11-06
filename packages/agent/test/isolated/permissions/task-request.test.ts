import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AuthorizationRequest, Json } from '../../../src/extensions';
import { createDefaultTaskRequestClassifier, defaultTaskRoles } from '../../../src/extensions/task';
import { canonicalJson } from '../../../src/json';
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
      request('task.spawn', { taskName: 'a', preset: role.id, prompt: 'a' }),
      request(`agent/${role.id}`, { content: 'a' }, 'job'),
    ]) {
      expect(describe(invocation)).toMatchObject({
        internalRecordOnly: true,
        effects: ['record_write'],
        safeRead: false,
      });
    }
  }
  expect(describe(request('task.spawn', { prompt: 'ordinary task' }))).toMatchObject({
    internalRecordOnly: true,
  });
  expect(describe(request('task.spawn', { preset: 'custom', prompt: 'a' }))).toBeUndefined();
  for (const id of [
    'task',
    'task.execute',
    'send_message',
    'followup_task',
    'task_cancel',
    'agent/custom',
  ])
    expect(describe(request(id, { role: 'code' }))).toBeUndefined();
  expect(describe(request('task.execute', { role: 'custom' }))).toBeUndefined();
  for (const id of ['explore']) {
    const original = defaultTaskRoles.find((role) => role.id === id)!;
    expect(
      createDefaultTaskRequestClassifier([{ ...original, toolPolicy: 'parent' }])(
        request('task.spawn', { preset: id, prompt: 'a' }),
      ),
    ).toBeUndefined();
  }
  expect(
    createDefaultTaskRequestClassifier([
      { id: 'general', version: '1', toolPolicy: 'parent', modelId: 'custom' },
    ])(request('task.spawn', { preset: 'general', prompt: 'a' })),
  ).toBeUndefined();
  for (const id of ['worker', 'code', 'plan', 'review']) {
    expect(describe(request('task.spawn', { preset: id, prompt: 'a' }))).toBeUndefined();
    expect(describe(request(`agent/${id}`, { content: 'a' }, 'job'))).toBeUndefined();
  }
  const original = request('task.spawn', { preset: 'general', prompt: 'a' });
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
    describe(request('task.spawn', { preset: 'general', prompt: 'changed' }))?.revision,
  ).not.toBe(capability.revision);
});

test('the omitted general and explicit general retain internal-record authorization in every permission mode', async () => {
  const describe = createDefaultTaskRequestClassifier(defaultTaskRoles);
  const inputs: Json[] = [{ prompt: 'a' }, { preset: 'general', prompt: 'a' }];
  for (const mode of ['auto', 'accept_edits', 'full'] as const) {
    for (const input of inputs) {
      const invocation = request('task.spawn', input);
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode,
          workspaceTrust: true,
          revision: 'current-mode',
          allowed: [{ kind: 'tool', definitionId: 'task.spawn', definitionVersion: '1' }],
        }),
        describeCapability: () =>
          ({
            kind: 'tool',
            definitionId: 'task.spawn',
            definitionVersion: '1',
            hardAllowed: true,
            ...describe(invocation),
          }) as CapabilityDescription,
      });
      const decision = await policy.authorize(invocation);
      expect(decision.allowed).toBe(true);
      expect(decision.snapshot).toMatchObject({
        data: { capability: { effects: ['record_write'], internalRecordOnly: true } },
      });
    }
  }
});

test('only an explicitly trusted prior catalogue restores its original default and revision', () => {
  const prior = [
    {
      id: 'worker',
      version: '1',
      toolPolicy: 'parent' as const,
      description: 'Prior registered builtin default.',
    },
  ];
  const invocation = request('task.spawn', { prompt: 'ordinary prior task' });
  expect(createDefaultTaskRequestClassifier(prior)(invocation)).toBeUndefined();
  const describe = createDefaultTaskRequestClassifier(prior, {
    trustedRoles: prior,
    defaultRole: 'worker',
  });
  expect(describe(invocation)).toMatchObject({
    internalRecordOnly: true,
    revision: `builtin.task.internal:${createHash('sha256')
      .update(
        canonicalJson({
          roles: prior,
          kind: invocation.kind,
          definitionId: invocation.definitionId,
          definitionVersion: invocation.definitionVersion,
          input: invocation.input,
        }),
      )
      .digest('hex')}`,
  });
  expect(describe(request('agent/worker', { content: 'a' }, 'job'))).toMatchObject({
    internalRecordOnly: true,
  });
  expect(describe(request('task.spawn', { preset: 'general', prompt: 'a' }))).toBeUndefined();
  expect(
    createDefaultTaskRequestClassifier([{ ...prior[0]!, modelId: 'overridden' }], {
      trustedRoles: prior,
      defaultRole: 'worker',
    })(invocation),
  ).toBeUndefined();
});
