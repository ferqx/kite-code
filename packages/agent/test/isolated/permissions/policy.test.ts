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
} from '@kite-ai/agent/permissions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';

test('uncertain effects require this call’s human approval in every mode', async () => {
  const capability = {
    kind: 'tool' as const,
    definitionId: 'shell.execute',
    definitionVersion: '1',
  };
  for (const mode of ['accept_edits', 'auto', 'full'] as const) {
    const permissions = createPermissionPolicy({
      readPolicy: () => ({
        mode,
        workspaceTrust: true,
        revision: 'workspace',
        allowed: [capability],
      }),
      describeCapability: () => ({
        ...capability,
        revision: 'powershell',
        hardAllowed: true,
        safeRead: false,
        effects: ['process', 'unknown'],
        executionScope: { filesystem: 'workspace_write', network: 'none' },
        autoReview: 'check',
        requiresApproval: true,
      }),
    });
    const decision = await permissions.authorize({
      ...capability,
      sessionId: 's',
      runId: 'r',
      executionId: 'e',
      input: { command: '& ./script.ps1' },
      signal: new AbortController().signal,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'approval_required' });
    expect(decision.check).toBeUndefined();
    expect(decision.approval?.options?.map((option) => option.kind)).toEqual(['once']);
  }
});

test('capability refinement receives this authorization policy without a second control read', async () => {
  const request: AuthorizationRequest = {
    kind: 'tool',
    sessionId: 's',
    runId: 'r',
    executionId: 'e',
    definitionId: 'files.write',
    definitionVersion: '3',
    input: { path: '/owned/report.txt' },
    signal: new AbortController().signal,
  };
  const source: PermissionPolicySnapshot = {
    mode: 'auto',
    workspaceTrust: true,
    revision: 'original',
    allowed: [{ kind: 'tool', definitionId: 'files.write', definitionVersion: '3' }],
    controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: '1' }],
  };
  let reads = 0;
  const permissions = createPermissionPolicy({
    readPolicy() {
      reads++;
      return source;
    },
    describeCapability(actual, snapshot) {
      expect(actual).toBe(request);
      expect(snapshot).toEqual(source);
      expect(snapshot).not.toBe(source);
      // Host controls may change after this read; they cannot replace the bound snapshot.
      Object.assign(source, { mode: 'full', revision: 'later' });
      expect(snapshot?.mode).toBe('auto');
      return {
        kind: actual.kind,
        definitionId: actual.definitionId,
        definitionVersion: actual.definitionVersion,
        revision: 'files',
        effects: ['external'],
        hardAllowed: true,
        safeRead: false,
      };
    },
  });
  const decision = await permissions.authorize(request);
  expect(reads).toBe(1);
  expect(decision).toMatchObject({
    allowed: false,
    reason: 'auto_check_required',
    snapshot: { data: { mode: 'auto', policyRevision: 'original' } },
    controlReads: source.controlReads,
  });
});

test('a capability callback cannot mutate the policy used for authorization', async () => {
  const request: AuthorizationRequest = {
    kind: 'tool',
    sessionId: 's',
    runId: 'r',
    executionId: 'e',
    definitionId: 'files.write',
    definitionVersion: '3',
    input: {},
    signal: new AbortController().signal,
  };
  const identity = { kind: 'tool' as const, definitionId: 'files.write', definitionVersion: '3' };
  for (const [mode, trust, allowed, reason] of [
    ['auto', true, true, 'auto_check_required'],
    ['full', false, true, 'workspace_untrusted'],
    ['full', true, false, 'capability_not_allowed'],
  ] as const) {
    const source: PermissionPolicySnapshot = {
      mode,
      workspaceTrust: trust,
      revision: 'actual',
      allowed: allowed ? [identity] : [],
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: '1' }],
    };
    const permissions = createPermissionPolicy({
      readPolicy: () => source,
      describeCapability(_request, snapshot) {
        if (snapshot!.allowed[0]) Object.assign(snapshot!.allowed[0], { definitionId: 'mutated' });
        Object.assign(snapshot!.controlReads![0]!, { revision: '2' });
        Object.assign(snapshot!, {
          mode: 'full',
          workspaceTrust: true,
          revision: 'mutated',
          allowed: [identity],
        });
        return {
          ...identity,
          revision: 'file',
          effects: ['external'],
          safeRead: false,
          hardAllowed: true,
        };
      },
    });
    expect(await permissions.authorize(request)).toMatchObject({
      allowed: false,
      reason,
      snapshot: { data: { mode, workspaceTrust: trust, policyRevision: 'actual' } },
    });
    expect(source).toMatchObject({ mode, workspaceTrust: trust, revision: 'actual' });
    expect(source.controlReads?.[0]?.revision).toBe('1');
    expect(source.allowed).toEqual(allowed ? [identity] : []);
  }
});

test('invalid mode is rejected before refinement and old one-argument callbacks remain valid', async () => {
  const request: AuthorizationRequest = {
    kind: 'tool',
    sessionId: 's',
    runId: 'r',
    executionId: 'e',
    definitionId: 'files.write',
    definitionVersion: '3',
    input: {},
    signal: new AbortController().signal,
  };
  let calls = 0;
  const permissions = createPermissionPolicy({
    readPolicy: () =>
      ({
        mode: 'not-a-mode',
        workspaceTrust: true,
        revision: 'invalid',
        allowed: [],
      }) as unknown as PermissionPolicySnapshot,
    describeCapability() {
      calls++;
      return null;
    },
  });
  expect(await permissions.authorize(request)).toMatchObject({
    allowed: false,
    reason: 'permission_policy_invalid',
  });
  expect(calls).toBe(0);
  const legacy = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'full',
      workspaceTrust: true,
      revision: 'actual',
      allowed: [{ kind: 'tool', definitionId: 'files.write', definitionVersion: '3' }],
    }),
    describeCapability(actual) {
      calls++;
      return {
        kind: actual.kind,
        definitionId: actual.definitionId,
        definitionVersion: actual.definitionVersion,
        revision: 'protected',
        effects: ['external'],
        safeRead: false,
        hardAllowed: false,
        denialReason: 'file_path_protected',
      };
    },
  });
  expect(await legacy.authorize(request)).toMatchObject({
    allowed: false,
    reason: 'file_path_protected',
  });
  expect(calls).toBe(1);
});

test('trusted Auto review selection skips business context but retains hard boundaries', async () => {
  for (const selection of ['check', 'none'] as const) {
    const f = await fixture('auto');
    try {
      f.capability = { ...f.capability, autoReview: selection };
      const request: AuthorizationRequest = {
        kind: 'tool',
        sessionId: 's',
        runId: null,
        executionId: 'synthetic',
        definitionId: 'fixture.effect',
        definitionVersion: '1',
        input: {},
        signal: new AbortController().signal,
      };
      const decision = await f.permissions.authorize(request);
      expect(f.reviews).toBe(0);
      if (selection === 'none') expect(decision.allowed).toBe(true);
      else {
        expect(decision.allowed).toBe(false);
        expect(decision.check?.request).toMatchObject({ mode: 'auto' });
        expect(decision.check?.request).not.toHaveProperty('reviewPurpose');
        expect(decision.check?.request).not.toHaveProperty('context');
      }
      f.capability = { ...f.capability, hardAllowed: false };
      expect(await f.permissions.authorize(request)).toMatchObject({
        allowed: false,
        reason: 'capability_unavailable',
      });
      f.capability = { ...f.capability, hardAllowed: true };
      f.policy = { ...f.policy, workspaceTrust: false };
      expect(await f.permissions.authorize(request)).toMatchObject({
        allowed: false,
        reason: 'workspace_untrusted',
      });
    } finally {
      await f.close();
    }
  }
});

test('shared builtin facts do not grant a namesake extension', async () => {
  for (const extensionId of ['builtin.files', 'untrusted.namesake']) {
    const f = await fixture('accept_edits', 'files.read');
    try {
      f.capability = {
        ...f.capability,
        ...builtinCapability(extensionId, 'files.read', 'tool', 'builtin.planning'),
      };
      await f.submit();
      if (extensionId === 'untrusted.namesake') {
        const card = await f.pending();
        expect(f.effects).toBe(0);
        expect(card.request).toMatchObject({ policy: { effects: ['unknown'] } });
        await f.approve(card);
      }
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects).toBe(1);
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
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
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

test('only the exact new controlled Browser orchestration definitions have no external effects', () => {
  for (const [definitionId, kind] of [
    ['browser.execute', 'tool'],
    ['browser.code_session', 'job'],
  ] as const) {
    expect(builtinCapability('builtin.browser', definitionId, kind, '', '1')).toEqual({
      effects: [],
      safeRead: true,
      approvalExempt: 'builtin.browser',
    });
    for (const [extensionId, version] of [
      ['untrusted.namesake', '1'],
      ['builtin.browser', '2'],
    ] as const)
      expect(builtinCapability(extensionId, definitionId, kind, '', version).safeRead).toBe(false);
  }
  expect(builtinCapability('builtin.browser', 'browser.session', 'job', '', '1')).toEqual({
    effects: ['process', 'network', 'unknown'],
    safeRead: false,
    approvalExempt: 'builtin.browser',
  });
  expect(builtinCapability('builtin.browser', 'browser.open', 'tool', '', '1')).toEqual({
    effects: ['process', 'network', 'unknown', 'record_write'],
    safeRead: false,
    approvalExempt: 'builtin.browser',
  });
  expect(builtinCapability('builtin.shell', 'shell.execute', 'tool', '', '1')).toEqual({
    effects: ['process', 'unknown', 'record_write'],
    safeRead: false,
  });
});

test('exact Browser release, human handoff and its response receipt do not grant new control', () => {
  for (const [definitionId, kind] of [
    ['browser.close', 'tool'],
    ['browser.request_human', 'tool'],
    ['browser.human_wait', 'job'],
  ] as const) {
    expect(builtinCapability('builtin.browser', definitionId, kind, '', '1')).toEqual({
      effects: [],
      safeRead: true,
      approvalExempt: 'builtin.browser',
    });
    for (const [extensionId, version] of [
      ['untrusted.namesake', '1'],
      ['builtin.browser', '2'],
    ] as const)
      expect(builtinCapability(extensionId, definitionId, kind, '', version).safeRead).toBe(false);
  }
  for (const [definitionId, kind] of [
    ['browser.resume', 'action'],
    ['browser.respond_human', 'action'],
    ['browser.fill', 'tool'],
    ['browser.click', 'tool'],
    ['browser.navigate', 'tool'],
  ] as const) {
    const capability = builtinCapability('builtin.browser', definitionId, kind, '', '1');
    expect(capability.safeRead).toBe(false);
    expect(capability.effects.length).toBeGreaterThan(0);
  }
});

test('Browser control reduction still requires the exact selected and hard-allowed capability', async () => {
  for (const [definitionId, kind] of [
    ['browser.close', 'tool'],
    ['browser.request_human', 'tool'],
    ['browser.human_wait', 'job'],
  ] as const) {
    const identity = { kind, definitionId, definitionVersion: '1' };
    for (const missing of ['selection', 'hard-cap'] as const) {
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode: 'auto',
          workspaceTrust: true,
          revision: 'exact-current-policy',
          allowed: missing === 'selection' ? [] : [identity],
        }),
        describeCapability: () => ({
          ...identity,
          ...builtinCapability('builtin.browser', definitionId, kind, '', '1'),
          hardAllowed: missing !== 'hard-cap',
          revision: 'actual-builtin',
        }),
      });
      const decision = await policy.authorize({
        ...identity,
        sessionId: 's',
        runId: 'r',
        executionId: 'e',
        input: {},
        signal: new AbortController().signal,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe(
        missing === 'selection' ? 'capability_not_allowed' : 'capability_unavailable',
      );
      expect(decision.check).toBeUndefined();
      expect(decision.approval).toBeUndefined();
    }
  }
});

test('normal Auto policy defaults reviewer timeout to the registered tool execution strategy', async () => {
  const identity = {
    kind: 'tool' as const,
    definitionId: 'remote.operation',
    definitionVersion: '1',
  };
  const policy = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'auto',
      workspaceTrust: true,
      revision: 'current',
      allowed: [identity],
    }),
    describeCapability: () => ({
      ...identity,
      revision: 'registered',
      hardAllowed: true,
      effects: ['network', 'unknown'],
      safeRead: false,
    }),
  });
  const result = await policy.authorize({
    ...identity,
    sessionId: 's',
    runId: 'r',
    executionId: 'e',
    input: {},
    signal: new AbortController().signal,
  });
  expect(result.allowed).toBe(false);
  expect(result.check?.timeoutScope).toBe('governed');
  expect(result.reason).toBe('auto_check_required');
});

test('registered builtin browser operations retain their effects and never request review or approval in any mode', async () => {
  const definitions = [
    ...[
      'execute',
      'open',
      'navigate',
      'snapshot',
      'image',
      'click',
      'fill',
      'scroll',
      'close',
      'request_human',
      'control',
    ].map((name) => ['tool', `browser.${name}`] as const),
    ...['code_session', 'session', 'human_wait'].map((name) => ['job', `browser.${name}`] as const),
    ...['capture', 'handoff', 'resume', 'close', 'select', 'input', 'respond_human'].map(
      (name) => ['action', `browser.${name}`] as const,
    ),
  ];
  let reviews = 0;
  for (const [kind, id] of definitions) {
    const facts = builtinCapability('builtin.browser', id, kind, '', '1');
    expect(facts.approvalExempt).toBe('builtin.browser');
    const identity = {
      kind: kind === 'action' ? ('job' as const) : kind,
      definitionId: kind === 'action' ? `builtin.browser/${id}` : id,
      definitionVersion: '1',
    };
    const capability: CapabilityDescription = {
      ...identity,
      ...facts,
      revision: 'registered-browser',
      hardAllowed: true,
    };
    if (
      [
        'browser.open',
        'browser.session',
        'browser.fill',
        'browser.click',
        'browser.navigate',
      ].includes(id)
    ) {
      expect(facts.effects.length).toBeGreaterThan(0);
      expect(facts.safeRead).toBe(false);
    }
    for (const mode of ['accept_edits', 'auto', 'full'] as const) {
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode,
          workspaceTrust: true,
          revision: 'current',
          allowed: [identity],
        }),
        describeCapability: () => capability,
        readCheckContext() {
          reviews++;
          return { task: null, plan: null, rejectionReasons: [] };
        },
      });
      const decision = await policy.authorize({
        ...identity,
        sessionId: 's',
        runId: 'r',
        executionId: 'e',
        input: {},
        signal: new AbortController().signal,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.check).toBeUndefined();
      expect(decision.approval).toBeUndefined();
      expect(decision.snapshot).toMatchObject({
        data: { capability: { effects: facts.effects, approvalExempt: 'builtin.browser' } },
      });
    }
  }
  expect(reviews).toBe(0);
});

test('browser exemption cannot grant a namesake extension, future definition, version or missing host authority', async () => {
  for (const [extensionId, id, kind, version] of [
    ['untrusted.namesake', 'browser.fill', 'tool', '1'],
    ['builtin.browser', 'browser.future', 'tool', '1'],
    ['builtin.browser', 'browser.fill', 'tool', '2'],
    ['builtin.browser', 'browser.fill', 'job', '1'],
  ] as const)
    expect(builtinCapability(extensionId, id, kind, '', version).approvalExempt).toBeUndefined();
  const identity = { kind: 'tool' as const, definitionId: 'browser.fill', definitionVersion: '1' };
  for (const missing of ['selection', 'hard-cap', 'workspace-trust'] as const) {
    const policy = createPermissionPolicy({
      readPolicy: () => ({
        mode: 'auto',
        workspaceTrust: missing !== 'workspace-trust',
        revision: 'current',
        allowed: missing === 'selection' ? [] : [identity],
      }),
      describeCapability: () => ({
        ...identity,
        ...builtinCapability('builtin.browser', 'browser.fill', 'tool', '', '1'),
        revision: 'registered',
        hardAllowed: missing !== 'hard-cap',
      }),
    });
    const decision = await policy.authorize({
      ...identity,
      sessionId: 's',
      runId: 'r',
      executionId: 'e',
      input: {},
      signal: new AbortController().signal,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.check).toBeUndefined();
    expect(decision.approval).toBeUndefined();
  }
  const forged = { kind: 'tool' as const, definitionId: 'browser.future', definitionVersion: '1' };
  const policy = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'full',
      workspaceTrust: true,
      revision: 'current',
      allowed: [forged],
    }),
    describeCapability: () => ({
      ...forged,
      effects: ['network'],
      safeRead: false,
      approvalExempt: 'builtin.browser',
      revision: 'forged',
      hardAllowed: true,
    }),
  });
  expect(
    await policy.authorize({
      ...forged,
      sessionId: 's',
      runId: 'r',
      executionId: 'e',
      input: {},
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ allowed: false, reason: 'capability_metadata_invalid' });
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
