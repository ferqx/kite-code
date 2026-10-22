import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { AuthorizationRequest } from '@kite-ai/agent/extensions';
import {
  builtinCapability,
  type CapabilityDescription,
  createPermissionPolicy,
  type PermissionPolicySnapshot,
  workflowCapabilityDescription,
} from '@kite-ai/agent/permissions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';

test('shared builtin facts do not grant a namesake extension or relax Workflow Job ceilings', async () => {
  for (const extensionId of ['builtin.files', 'untrusted.namesake']) {
    const f = await fixture('accept_edits', 'files.read');
    try {
      f.capability = {
        ...f.capability,
        ...builtinCapability(extensionId, 'files.read', 'tool', 'builtin.planning'),
      };
      const workflow = workflowCapabilityDescription({
        ...f.capability,
        kind: 'tool',
        extensionId,
      });
      await f.submit();
      if (extensionId === 'untrusted.namesake') {
        const card = await f.pending();
        expect(f.effects).toBe(0);
        expect(card.request).toMatchObject({ policy: { effects: ['unknown'] } });
        expect(workflow.capability.policy.minimumApproval).toBe('user');
        await f.approve(card);
      } else {
        expect(workflow.capability.effectiveEffects).toEqual({
          filesystem: 'read',
          network: 'none',
          externalState: 'none',
        });
        expect(workflow.capability.policy.minimumApproval).toBe('none');
      }
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(1);
      const job = workflowCapabilityDescription({ ...f.capability, kind: 'job' });
      expect(job.capability.effectiveEffects).toEqual({
        filesystem: 'unknown',
        network: 'unknown',
        externalState: 'unknown',
      });
      expect(job.capability.policy.minimumApproval).toBe('user');
    } finally {
      await f.close();
    }
  }
});

async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('Permission fixture deadline');
    await Bun.sleep(10);
  }
}
async function fixture(
  mode: PermissionPolicySnapshot['mode'] = 'accept_edits',
  toolId = 'fixture.effect',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-permission-policy-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'exact-call',
        name: toolId,
        arguments: '{"path":"file","value":"exact"}',
      },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  let policy: PermissionPolicySnapshot = {
    mode,
    workspaceTrust: true,
    revision: 'policy-1',
    allowed: [
      { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
      { kind: 'tool', definitionId: toolId, definitionVersion: '1' },
    ],
  };
  let capability: CapabilityDescription = {
    kind: 'tool',
    definitionId: toolId,
    definitionVersion: '1',
    revision: 'registration-1',
    effects: ['external'],
    hardAllowed: true,
    safeRead: false,
  };
  let effects = 0;
  let reviews = 0;
  const permissions = createPermissionPolicy({
    readPolicy: () => policy,
    describeCapability(request) {
      return request.kind === 'model'
        ? {
            kind: 'model',
            definitionId: 'fixed',
            definitionVersion: '1',
            revision: 'model-1',
            effects: ['network'],
            hardAllowed: true,
            safeRead: false,
          }
        : capability;
    },
    readCheckContext() {
      reviews++;
      return { task: 'explicit task', plan: null, rejectionReasons: [] };
    },
  });
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions,
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: toolId,
            version: '1',
            description: 'Untrusted prose claiming safe Model authority',
            inputSchema: { type: 'object' },
            async execute(input) {
              effects++;
              return { outcome: 'succeeded', content: JSON.stringify(input) };
            },
          },
        ],
      },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    subjectId: 'owner',
    workspaceId: 'w',
    title: 'root',
  });
  const submit = () =>
    runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'explicit task' },
    });
  return {
    store,
    runtime,
    model,
    submit,
    expectedStoreId,
    permissions,
    get effects() {
      return effects;
    },
    get reviews() {
      return reviews;
    },
    set policy(value: PermissionPolicySnapshot) {
      policy = value;
    },
    get policy() {
      return policy;
    },
    set capability(value: CapabilityDescription) {
      capability = value;
    },
    get capability() {
      return capability;
    },
    async pending() {
      return until(
        async () =>
          (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
            .interactions[0] ?? null,
      );
    },
    async approve(
      card: Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number],
    ) {
      return runtime.answerInteraction({
        expectedStoreId,
        commandId: 'answer',
        presentationSessionId: card.presentationSessionId,
        interactionId: card.id,
        expectedRevision: card.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve' },
      });
    },
    async close() {
      try {
        await runtime.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test('Request Approval exact Core card approval grants one original invocation, preserves parameters and duplicate work performs no effect', async () => {
  const f = await fixture();
  try {
    await f.submit();
    const card = await f.pending();
    expect(card.request).toMatchObject({
      definitionId: 'fixture.effect',
      definitionVersion: '1',
      input: { path: 'file', value: 'exact' },
      policy: { mode: 'accept_edits', effects: ['external'] },
    });
    expect(f.effects).toBe(0);
    const answer = await f.approve(card);
    expect(answer.receipt).toMatchObject({ outcome: 'answer_saved' });
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects).toBe(1);
    expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
    expect(
      (await f.runtime.getInteraction({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        interactionId: card.id,
      }))!.acceptedDecisionRevision,
    ).not.toBeNull();
    const original = await f.runtime.getCommand('work');
    expect(original).not.toBeNull();
    expect(await f.submit()).toEqual(original!);
    expect(f.effects).toBe(1);
    expect(f.reviews).toBe(0);
  } finally {
    await f.close();
  }
});

test('policy trust, allowlist, registration or mode changes while human waits never turn an old approval into authority', async () => {
  for (const change of ['trust', 'allowlist', 'registration', 'mode'] as const) {
    const f = await fixture();
    try {
      await f.submit();
      const card = await f.pending();
      if (change === 'trust') f.policy = { ...f.policy, workspaceTrust: false };
      if (change === 'allowlist')
        f.policy = {
          ...f.policy,
          allowed: f.policy.allowed.filter((entry) => entry.kind === 'model'),
        };
      if (change === 'registration') f.capability = { ...f.capability, hardAllowed: false };
      if (change === 'mode') f.policy = { ...f.policy, mode: 'full' };
      await f.approve(card);
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(0);
      expect(
        (await f.runtime.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: card.id,
        }))!.acceptedDecisionRevision,
      ).toBeNull();
      expect((await f.runtime.getExecution(card.executionId))!.status).toBe('failed');
      expect(f.reviews).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('trusted Accept Edits workspace writes and safe Auto reads execute without a card; Full bypasses ordinary unknown effect classification', async () => {
  for (const mode of ['accept_edits', 'auto', 'full'] as const) {
    const f = await fixture(mode);
    try {
      if (mode === 'accept_edits') f.capability = { ...f.capability, effects: ['workspace_write'] };
      if (mode === 'auto') f.capability = { ...f.capability, effects: ['read'], safeRead: true };
      if (mode === 'full')
        f.capability = { ...f.capability, effects: ['unknown'], safeRead: false };
      await f.submit();
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(1);
      expect(
        (await f.runtime.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
          .interactions,
      ).toHaveLength(0);
      expect(f.reviews).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('Full does not reuse namesake Model authority for a Tool; Auto without a Core reviewer reads context and requests a real human', async () => {
  const denied = await fixture('full', 'fixed');
  try {
    denied.policy = {
      ...denied.policy,
      allowed: denied.policy.allowed.filter((entry) => entry.kind === 'model'),
    };
    await denied.submit();
    await denied.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(denied.effects).toBe(0);
    expect(denied.model.requests).toHaveLength(2);
    expect(
      (await denied.runtime.getView('s')).executions.find((execution) => execution.kind === 'tool')!
        .status,
    ).toBe('failed');
  } finally {
    await denied.close();
  }
  const auto = await fixture('auto');
  try {
    await auto.submit();
    const card = await auto.pending();
    expect(card.request).toMatchObject({
      policy: { mode: 'auto', reason: 'auto_check_unavailable' },
    });
    expect(auto.effects).toBe(0);
    expect(auto.reviews).toBeGreaterThan(0);
    const contextReads = auto.reviews;
    await auto.approve(card);
    await auto.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(auto.effects).toBe(1);
    expect(auto.reviews).toBeGreaterThanOrEqual(contextReads);
  } finally {
    await auto.close();
  }
});

test('policy finite validation and aborted request never manufacture approval authority', async () => {
  let reads = 0;
  const request: AuthorizationRequest = {
    kind: 'tool',
    sessionId: 's',
    runId: 'r',
    executionId: 'e',
    definitionId: 't',
    definitionVersion: '1',
    input: {},
    signal: new AbortController().signal,
  };
  const policy = createPermissionPolicy({
    readPolicy() {
      reads++;
      return {
        mode: 'accept_edits',
        workspaceTrust: true,
        revision: '1',
        allowed: Array.from({ length: 513 }, () => ({
          kind: 'tool' as const,
          definitionId: 't',
          definitionVersion: '1',
        })),
      };
    },
    describeCapability() {
      throw new Error('Invalid policy must not discover capabilities');
    },
  });
  expect(reads).toBe(0);
  expect(await policy.authorize(request)).toEqual({
    allowed: false,
    revision: 'invalid-policy',
    reason: 'permission_policy_invalid',
  });
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let error: unknown;
  try {
    await policy.authorize({ ...request, signal: controller.signal });
  } catch (caught) {
    error = caught;
  }
  expect((error as Error).message).toBe('cancelled');
  expect(reads).toBe(1);
});

test('Full preserves hard capability, current Workspace trust and exact registered version with zero Tool effects and no approval fallback', async () => {
  for (const change of ['trust', 'hard-capability', 'version'] as const) {
    const f = await fixture('full');
    try {
      if (change === 'trust') f.policy = { ...f.policy, workspaceTrust: false };
      if (change === 'hard-capability') f.capability = { ...f.capability, hardAllowed: false };
      if (change === 'version') f.capability = { ...f.capability, definitionVersion: '2' };
      await f.submit();
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(0);
      expect(f.model.requests).toHaveLength(2);
      expect(
        (await f.runtime.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
          .interactions,
      ).toHaveLength(0);
      expect(f.reviews).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('record_write stays outside Accept Edits; Request Approval and unqualified Auto require exact approval while Full uses trusted allowed metadata', async () => {
  for (const mode of ['accept_edits', 'auto', 'full'] as const) {
    const f = await fixture(mode);
    try {
      f.capability = { ...f.capability, effects: ['record_write'], safeRead: false };
      await f.submit();
      if (mode !== 'full') {
        const card = await f.pending();
        expect(card.request).toMatchObject({ policy: { effects: ['record_write'], mode } });
        expect(f.effects).toBe(0);
        await f.approve(card);
      }
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(1);
      if (mode === 'auto') expect(f.reviews).toBeGreaterThan(0);
      else expect(f.reviews).toBe(0);
    } finally {
      await f.close();
    }
  }
}, 15000);

test('absolute file reads retain their read classification at both known versions', () => {
  for (const version of ['1', '2'])
    expect(
      builtinCapability(
        'builtin.files.path',
        'files.read_path',
        'tool',
        'builtin.planning',
        version,
      ),
    ).toEqual({ effects: ['read'], safeRead: true });
  for (const [id, version] of [
    ['files.read_path', '3'],
    ['files.read_path', undefined],
    ['files.write_path', '1'],
    ['files.edit_path', '1'],
  ])
    expect(
      builtinCapability('builtin.files.path', id!, 'tool', 'builtin.planning', version),
    ).toEqual({ effects: ['external'], safeRead: false });
});

test('Web network effects require the exact registered builtin Tool identity and version', () => {
  expect(builtinCapability('builtin.web', 'web_fetch', 'tool', 'builtin.planning', '1')).toEqual({
    effects: ['network', 'unknown'],
    safeRead: false,
  });
  for (const [extensionId, definitionId, kind, version] of [
    ['untrusted.namesake', 'web_fetch', 'tool', '1'],
    ['builtin.web', 'other', 'tool', '1'],
    ['builtin.web', 'web_fetch', 'job', '1'],
    ['builtin.web', 'web_fetch', 'action', '1'],
    ['builtin.web', 'web_fetch', 'tool', '2'],
    ['builtin.web', 'web_fetch', 'tool', undefined],
  ] as const) {
    expect(builtinCapability(extensionId, definitionId, kind, 'builtin.planning', version)).toEqual(
      { effects: ['unknown'], safeRead: false },
    );
  }
});

test('explicit trusted internal record-only facts bypass approval in three modes without changing generic record-write behavior', async () => {
  for (const mode of ['accept_edits', 'auto', 'full'] as const) {
    const f = await fixture(mode);
    try {
      f.capability = {
        ...f.capability,
        effects: ['record_write'],
        safeRead: false,
        internalRecordOnly: true,
      };
      await f.submit();
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(1);
      expect(f.reviews).toBe(0);
      expect(
        (await f.runtime.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
          .interactions,
      ).toHaveLength(0);
      const execution = (await f.store.listExecutions('s')).find(
        (item) => item.definitionId === 'fixture.effect',
      )!;
      expect(execution.status).toBe('succeeded');
    } finally {
      await f.close();
    }
  }
});

test('internal-record fact cannot conceal external/process/unknown effects or bypass hard gates', async () => {
  for (const effect of ['external', 'process', 'unknown', 'network', 'workspace_write'] as const) {
    const f = await fixture('full');
    try {
      f.capability = { ...f.capability, effects: [effect], internalRecordOnly: true };
      await f.submit();
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(0);
      expect(f.reviews).toBe(0);
      expect(
        (await f.runtime.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
          .interactions,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
});
