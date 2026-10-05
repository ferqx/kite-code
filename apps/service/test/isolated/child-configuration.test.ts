import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Extension, OperationRef, Permissions } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { type ChildRole, createChildConfiguration } from '../../src/child-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { PermissionPolicyOptions } from '../../src/permissions';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 7000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= end) throw new Error('child_configuration_deadline');
    await Bun.sleep(5);
  }
}
function provider() {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content: string }[];
      const parent =
        body.model === 'parent' &&
        messages.some(
          (message) => message.role === 'user' && ['work', 'next'].includes(message.content),
        );
      const start = parent
        ? messages.reduce(
            (found, message, index) =>
              message.role === 'user' && ['work', 'next'].includes(message.content) ? index : found,
            -1,
          )
        : -1;
      const toolResults = messages.slice(start + 1).filter((message) => message.role === 'tool');
      const write = body.model === 'writer';
      const call = parent
        ? toolResults.length
          ? null
          : { name: 'fixture.delegate', input: {} }
        : write
          ? toolResults.length
            ? null
            : {
                name: 'files.write',
                input: { path: 'forbidden.txt', base: null, content: 'must not write' },
              }
          : body.model === 'background'
            ? toolResults.length
              ? null
              : { name: 'fixture.launch', input: {} }
            : toolResults.some((message) => message.content.includes('baseline'))
              ? null
              : { name: 'files.read', input: { path: 'input.txt' } };
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(
        chunk(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'actual child finished' },
          null,
        ) +
          chunk({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  return {
    requests,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  };
}
async function fixture(
  options: {
    roles?: ChildRole[];
    permissions?: Permissions;
    tools?: string[];
    sharedKey?: boolean;
    extra?: Extension;
    permissionPolicy?: Pick<PermissionPolicyOptions, 'readPolicy'>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-service-child-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input.txt'), 'full private input');
  writeFileSync(join(workspace, 'AGENTS.md'), 'actual old Workspace instruction');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const a = provider(),
    b = provider();
  const userPath = join(profile.profilePath, 'config.jsonc'),
    projectPath = join(workspace, 'kite-agent.jsonc');
  const configuration = {
    modelId: 'parent',
    models: [
      { id: 'parent', provider: 'compatible', model: 'parent', baseURL: a.baseURL },
      { id: 'child', provider: 'compatible', model: 'child-old', baseURL: a.baseURL },
    ],
    tools: ['fixture.delegate', ...(options.tools ?? ['files.read'])].map((id) => ({ id })),
  };
  writeFileSync(userPath, JSON.stringify(configuration));
  const roles = options.roles ?? [
    { id: 'worker', version: '7', modelId: 'child', toolIds: options.tools ?? ['files.read'] },
  ];
  const permissions =
    options.permissions ??
    (options.permissionPolicy
      ? undefined
      : {
          authorize: async () => ({ allowed: true, revision: 'trusted-fixture' }),
        });
  const host = createDefaultProcessConfiguration({
    profile,
    child: roles,
    knownToolIds: ['fixture.delegate', ...(options.extra?.tools?.map((tool) => tool.id) ?? [])],
    permissions,
    permissionPolicy: options.permissionPolicy,
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const refs: OperationRef[] = [];
  let resolutions = 0,
    disposals = 0;
  const delegate: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.delegate',
        version: '1',
        description: 'Trusted test-only delegation, not a product task Tool',
        inputSchema: { type: 'object', additionalProperties: false },
        async execute(_input, context) {
          const request = {
            kind: 'agent' as const,
            configurationId: 'worker',
            input: { content: 'actual child input' },
          };
          const ref = await context.operations.ensure({
            key: options.sharedKey ? 'stable' : `exact-${context.executionId}`,
            request,
            cancellation: 'detached',
          });
          const same = await context.operations.ensure({
            key: options.sharedKey ? 'stable' : `exact-${context.executionId}`,
            request,
            cancellation: 'detached',
          });
          expect(same).toEqual(ref);
          refs.push(ref);
          return { outcome: 'succeeded', content: JSON.stringify(ref) };
        },
      },
    ],
  };
  const runtime = createRuntime({
    ...host,
    store,
    modelConcurrency: 1,
    permissions: host.permissions!,
    ...(options.permissionPolicy
      ? {
          resolveRunConfiguration: async (
            input: Parameters<NonNullable<typeof host.resolveRunConfiguration>>[0],
          ) => {
            const binding = await host.resolveRunConfiguration!(input);
            return {
              ...binding,
              permissions: {
                authorize: (request: Parameters<Permissions['authorize']>[0]) =>
                  request.kind === 'tool' &&
                  request.definitionId === 'fixture.delegate' &&
                  request.definitionVersion === '1'
                    ? Promise.resolve({ allowed: true, revision: 'trusted-test-only-delegation' })
                    : binding.permissions!.authorize(request),
              },
            };
          },
        }
      : {}),
    extensions: [...host.extensions!, delegate, ...(options.extra ? [options.extra] : [])],
    resolveChildRunConfiguration: async (input) => {
      resolutions++;
      const result = await host.resolveChildRunConfiguration!(input);
      return {
        ...result,
        dispose: async () => {
          disposals++;
          await result.dispose?.();
        },
      };
    },
  });
  host.permissionManagement?.(runtime);
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'parent' });
  return {
    runtime,
    store,
    profile,
    host,
    delegate,
    permissions: host.permissions!,
    refs,
    a,
    b,
    workspace,
    userPath,
    projectPath,
    configuration,
    base,
    get resolutions() {
      return resolutions;
    },
    get disposals() {
      return disposals;
    },
    submit: (commandId = 'work') =>
      runtime.submitCommand({
        ...base,
        commandId,
        request: { kind: 'run.start', content: commandId },
      }),
    async child() {
      return until(async () =>
        (await store.listExecutions('s')).find((row) => row.childSessionId !== null),
      );
    },
    async childDone(executionId: string) {
      return until(async () => {
        const row = await store.getExecution(executionId);
        return row && ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(row.status)
          ? row
          : undefined;
      });
    },
    async close() {
      await runtime.close();
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('finite trusted roles are inert, closed and captured; no unresolved template can make a Provider request', () => {
  const role = { id: 'worker', version: '1', modelId: 'child', toolIds: ['files.read'] };
  const configured = createChildConfiguration({
    roles: [role],
    resolve: async () => {
      throw new Error('not called');
    },
  });
  role.modelId = 'changed';
  expect(configured.childConfigurations![0]!.modelId).toBe('child');
  expect(() =>
    configured.childConfigurations![0]!.model.stream({} as never, {
      signal: new AbortController().signal,
    }),
  ).toThrow('child_configuration_unresolved');
  expect(() =>
    createChildConfiguration({
      roles: [{ ...role, permissions: 'full' } as never],
      resolve: async () => {
        throw new Error();
      },
    }),
  ).toThrow('invalid_child_configuration');
});

test('one Model slot uses fresh SDK child binding and Workspace sources; a detached active child keeps its old route and Files lease across configuration changes', async () => {
  const entered = gate(),
    release = gate();
  let waited = false;
  const f = await fixture({
    permissions: {
      async authorize(request) {
        if (
          !waited &&
          request.kind === 'tool' &&
          request.definitionId === 'files.read' &&
          request.sessionId !== 's'
        ) {
          waited = true;
          entered.resolve();
          await release.promise;
        }
        return { allowed: true, revision: 'trusted-live-policy' };
      },
    },
  });
  try {
    await f.submit();
    await until(async () => (waited ? true : undefined));
    expect((await f.runtime.waitForCommand('work', { timeoutMs: 7000 })).status).toBe('applied');
    const first = await f.child();
    expect(first.definitionVersion).toBe('7');
    expect(f.disposals).toBe(0);
    writeFileSync(
      f.projectPath,
      JSON.stringify({
        models: [{ id: 'child', provider: 'compatible', model: 'child-new', baseURL: f.b.baseURL }],
      }),
    );
    writeFileSync(join(f.workspace, 'AGENTS.md'), 'actual new Workspace instruction');
    release.resolve();
    expect((await f.childDone(first.id)).status).toBe('succeeded');
    expect(f.a.requests.filter((request) => request.model === 'child-old').length).toBeGreaterThan(
      1,
    );
    expect(
      JSON.stringify(f.a.requests.filter((request) => request.model === 'child-old')),
    ).toContain('actual new Workspace instruction');
    expect(f.b.requests).toHaveLength(0);
    expect(readFileSync(join(f.workspace, 'input.txt'), 'utf8')).toBe('full private input');
    await until(async () => (f.disposals === 1 ? true : undefined));
    await f.submit('next');
    await f.runtime.waitForCommand('next', { timeoutMs: 7000 });
    const second = await until(async () =>
      (await f.store.listExecutions('s')).find(
        (row) => row.childSessionId !== null && row.id !== first.id,
      ),
    );
    expect((await f.childDone(second.id)).status).toBe('succeeded');
    expect(f.b.requests.every((request) => request.model === 'child-new')).toBe(true);
    expect(f.b.requests.length).toBeGreaterThan(0);
    expect(f.resolutions).toBe(2);
    expect(
      JSON.stringify((await f.store.getView(first.childSessionId!)).runs[0]!.configuration),
    ).toContain('child-old');
    expect(
      JSON.stringify((await f.store.getView(second.childSessionId!)).runs[0]!.configuration),
    ).toContain('child-new');
    expect(
      (await f.store.listExecutions(first.childSessionId!)).filter(
        (row) => row.definitionId === 'files.read' && row.status === 'succeeded',
      ),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
}, 20000);

test('parent policy denies a child write despite fresh child registration and leaves the original file scope unchanged', async () => {
  const f = await fixture({
    tools: ['files.write'],
    permissions: {
      async authorize(request) {
        return { allowed: request.definitionId !== 'files.write', revision: 'deny-write' };
      },
    },
  });
  try {
    f.configuration.models[1]!.model = 'writer';
    writeFileSync(f.userPath, JSON.stringify(f.configuration));
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
    const child = await f.child();
    await f.childDone(child.id);
    expect(existsSync(join(f.workspace, 'forbidden.txt'))).toBe(false);
    expect(
      (await f.store.listExecutions(child.childSessionId!)).find(
        (row) => row.definitionId === 'files.write',
      )?.result,
    ).toMatchObject({ content: 'permission_denied' });
  } finally {
    await f.close();
  }
}, 15000);

test('missing selected model and unknown/disabled child Tools fail before a child carrier or child Provider; original command retries remain unchanged', async () => {
  for (const variant of ['model', 'role', 'tool', 'disabled'] as const) {
    const f = await fixture({
      roles: [
        {
          id: variant === 'role' ? 'other' : 'worker',
          version: '1',
          modelId: variant === 'model' ? 'missing' : 'child',
          toolIds: variant === 'tool' ? ['absent.tool'] : ['files.read'],
        },
      ],
    });
    try {
      if (variant === 'disabled') {
        f.configuration.tools = [{ id: 'fixture.delegate' }];
        writeFileSync(f.userPath, JSON.stringify(f.configuration));
      }
      await f.submit();
      const original = await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
      expect(
        (await f.store.listExecutions('s')).filter((row) => row.childSessionId !== null),
      ).toHaveLength(0);
      expect(f.a.requests.filter((request) => request.model !== 'parent')).toHaveLength(0);
      const before = f.a.requests.length;
      expect(await f.submit()).toEqual(original);
      expect(f.a.requests).toHaveLength(before);
      expect(f.resolutions).toBe(variant === 'role' ? 0 : 1);
    } finally {
      await f.close();
    }
  }
}, 15000);

test('a cold original operation key returns its saved child reference without reading broken configuration or restarting the Provider', async () => {
  const f = await fixture({ sharedKey: true });
  let cold: ReturnType<typeof createRuntime> | undefined;
  try {
    await f.submit();
    const oldCommand = await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
    const child = await f.child();
    await f.childDone(child.id);
    const original = f.refs[0]!;
    const calls = f.a.requests.length;
    await f.runtime.close();
    writeFileSync(f.userPath, '{ invalid:');
    const store = await openSqliteStore({
      dataRoot: f.profile.dataRoot,
      profile: f.profile.profile,
    });
    let resolutions = 0;
    cold = createRuntime({
      ...f.host,
      store,
      permissions: f.permissions,
      extensions: [...f.host.extensions!, f.delegate],
      resolveChildRunConfiguration: async () => {
        resolutions++;
        throw new Error('must_not_resolve_original');
      },
    });
    expect(
      await cold.submitCommand({
        ...f.base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'work' },
      }),
    ).toEqual(oldCommand);
    expect(
      await store.getOperation({
        sessionId: 's',
        extensionId: 'fixture',
        key: 'stable',
        subjectId: 'user',
        originStoreId: f.base.expectedStoreId,
      }),
    ).toEqual(original);
    expect(resolutions).toBe(0);
    expect(f.a.requests).toHaveLength(calls);
    expect(
      (await store.listExecutions('s')).filter((row) => row.childSessionId !== null),
    ).toHaveLength(1);
  } finally {
    await cold?.close();
    await f.close();
  }
}, 15000);

test('a detached child Job retains the fresh Workspace binding after both Runs finish, and releases it only after actual terminal supervision', async () => {
  const terminal = gate();
  let job: OperationRef | undefined,
    ledger = '';
  const extra: Extension = {
    id: 'fixture.background',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.launch',
        version: '1',
        description: 'Test-only ordinary Job launch',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          job = await context.operations.ensure({
            key: 'background',
            cancellation: 'detached',
            request: {
              kind: 'job',
              definitionId: 'fixture.job',
              definitionVersion: '1',
              input: {},
            },
          });
          return { outcome: 'succeeded', content: JSON.stringify(job) };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.job',
        version: '1',
        description: 'Controlled physical ledger Job',
        inputSchema: { type: 'object' },
        async start(_input, context) {
          writeFileSync(ledger, context.executionId);
          return { reference: { executionId: context.executionId } };
        },
        async *observe() {
          await terminal.promise;
          writeFileSync(`${ledger}.ended`, 'actual terminal');
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: 'physical ledger complete' },
          };
        },
        async cancel() {
          terminal.resolve();
          return { status: 'stopped' };
        },
        async dispose() {},
      },
    ],
  };
  const f = await fixture({ tools: ['files.read', 'fixture.launch'], extra });
  ledger = join(f.workspace, 'background.ledger');
  try {
    f.configuration.models[1]!.model = 'background';
    writeFileSync(f.userPath, JSON.stringify(f.configuration));
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
    const child = await f.child();
    await f.childDone(child.id);
    await until(async () => (existsSync(ledger) && job ? true : undefined));
    expect((await f.store.getView(child.childSessionId!)).runs[0]!.status).toBe('completed');
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    expect((await f.store.getExecution(job!.executionId!))!.status).toBe('running');
    expect(f.disposals).toBe(0);
    const requests = f.a.requests.length;
    terminal.resolve();
    expect((await f.childDone(job!.executionId!)).status).toBe('succeeded');
    await until(async () => (f.disposals === 1 ? true : undefined));
    expect(readFileSync(`${ledger}.ended`, 'utf8')).toBe('actual terminal');
    expect(f.a.requests).toHaveLength(requests);
  } finally {
    terminal.resolve();
    await f.close();
  }
}, 15000);

test('trusted role carrier is an independent exact unknown-effect Job: Ask approves it once, while Model-only and untrusted policy cannot start the child Provider', async () => {
  for (const mode of ['allow', 'only-model', 'untrusted'] as const) {
    const f = await fixture({
      permissionPolicy: {
        readPolicy: () => ({
          mode: 'ask',
          workspaceTrust: mode !== 'untrusted',
          revision: 'trusted-role-policy',
          allowed: [
            { kind: 'model', definitionId: 'parent', definitionVersion: '1' },
            { kind: 'model', definitionId: 'child', definitionVersion: '1' },
            ...(mode === 'only-model'
              ? []
              : [
                  { kind: 'job' as const, definitionId: 'agent/worker', definitionVersion: '7' },
                  { kind: 'tool' as const, definitionId: 'files.read', definitionVersion: '3' },
                ]),
          ],
        }),
      },
    });
    try {
      await f.submit();
      if (mode === 'allow') {
        const card = await until(async () =>
          (
            await f.store.listInteractions({
              expectedStoreId: f.base.expectedStoreId,
              sessionId: 's',
              state: 'pending',
            })
          ).interactions.find((row) => row.definitionId === 'agent/worker'),
        );
        expect(card.definitionVersion).toBe('7');
        expect(card.request).toMatchObject({
          definitionId: 'agent/worker',
          definitionVersion: '7',
          input: { content: 'actual child input' },
          policy: { effects: ['unknown'], mode: 'ask' },
        });
        expect(f.a.requests.filter((request) => request.model !== 'parent')).toHaveLength(0);
        await f.runtime.answerInteraction({
          ...f.base,
          presentationSessionId: 's',
          commandId: 'approve-carrier',
          interactionId: card.id,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        });
      }
      await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
      const child = await f.child();
      const terminal = await f.childDone(child.id);
      expect(terminal.status).toBe(mode === 'allow' ? 'succeeded' : 'failed');
      expect(f.a.requests.filter((request) => request.model !== 'parent').length > 0).toBe(
        mode === 'allow',
      );
      if (mode !== 'allow')
        expect(
          (
            await f.store.listInteractions({
              expectedStoreId: f.base.expectedStoreId,
              sessionId: 's',
              state: 'pending',
            })
          ).interactions,
        ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
}, 20000);

test('an omitted role modelId inherits the actual parent identity rather than the changed JSONC default', async () => {
  const release = gate();
  let waiting = false;
  const f = await fixture({
    roles: [{ id: 'worker', version: '5', toolIds: ['files.read'] }],
    permissions: {
      async authorize(request) {
        if (!waiting && request.kind === 'tool' && request.definitionId === 'fixture.delegate') {
          waiting = true;
          await release.promise;
        }
        return { allowed: true, revision: 'trusted-parent-identity' };
      },
    },
  });
  try {
    await f.submit();
    await until(async () => (waiting ? true : undefined));
    writeFileSync(
      f.projectPath,
      JSON.stringify({
        modelId: 'unrelated',
        models: [{ id: 'unrelated', provider: 'compatible', model: 'wrong', baseURL: f.b.baseURL }],
      }),
    );
    release.resolve();
    await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
    const child = await f.child();
    expect((await f.childDone(child.id)).status).toBe('succeeded');
    expect((await f.store.getView(child.childSessionId!)).runs[0]!.configuration).toMatchObject({
      modelId: 'parent',
      snapshot: { roleModelId: null },
    });
    expect(f.b.requests).toHaveLength(0);
    expect(
      f.a.requests.some((request) =>
        (request.messages as { content: string }[]).some(
          (message) =>
            typeof message.content === 'string' && message.content.includes('actual child input'),
        ),
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    await f.close();
  }
}, 15000);

test('default resolved Skill selection retains more than 256 identities while explicit requested bound stays closed', async () => {
  const { readSkillSelection } = await import('../../src/child-configuration');
  const ids = Array.from({ length: 301 }, (_, i) => `skill-${i}`);
  expect(
    readSkillSelection({ snapshot: { skillSelection: { requested: null, resolvedIds: ids } } })
      .resolvedIds,
  ).toEqual(ids);
  expect(() =>
    readSkillSelection({ snapshot: { skillSelection: { requested: ids, resolvedIds: ids } } }),
  ).toThrow();
  expect(() =>
    readSkillSelection({
      snapshot: { skillSelection: { requested: null, resolvedIds: [...ids, ids[0]!] } },
    }),
  ).toThrow();
});
