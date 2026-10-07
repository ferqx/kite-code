import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { AuthorizationRequest, JobContext, JobEvent } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createShellConfiguration } from '../../src/shell-configuration';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
async function until<T>(read: () => Promise<T | undefined>) {
  const end = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('shell_configuration_deadline');
    await Bun.sleep(5);
  }
}
function endpoint(command: string, stop = false, background = false, child = false) {
  let actualCommand = command;
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content: string }[];
      const last = messages.reduce(
        (v, m, i) =>
          m.role === 'user' &&
          (/^work$|^next$|^grant-[a-z-]+$/.test(m.content) ||
            (child && m.content.includes('child-shell-task')))
            ? i
            : v,
        -1,
      );
      const results = messages.slice(last + 1).filter((row) => row.role === 'tool');
      const isChild = child && messages[last]?.content.includes('child-shell-task');
      const key = isChild ? 'child-shell' : (messages[last]?.content ?? 'work');
      const calls =
        child && !isChild
          ? [
              {
                name: 'task',
                input: {
                  key,
                  role: 'worker',
                  input: { content: 'child-shell-task' },
                  cancellation: 'attached',
                  resultDisposition: 'required',
                },
              },
            ]
          : [
              {
                name: 'shell.launch',
                input: { key, command: actualCommand, cancellation: 'detached' },
              },
              {
                name: stop ? 'shell.stop' : 'shell.wait',
                input: stop
                  ? { shellId: key, commandId: `stop-${key}` }
                  : { shellId: key, timeoutMs: 4000 },
              },
              { name: 'shell.wait', input: { shellId: key, timeoutMs: 4000 } },
              { name: 'shell.read', input: { shellId: key, afterSeq: '0', limit: 200 } },
            ];
      const call = background && results.length > 0 ? undefined : calls[results.length];
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
            : { content: 'supervised Shell facts' },
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
    command(value: string) {
      actualCommand = value;
    },
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  };
}
async function fixture(
  options: {
    mode?: 'full' | 'ask';
    deny?: 'tool' | 'job';
    missing?: boolean;
    badAsset?: boolean;
    stop?: boolean;
    command?: string;
    background?: boolean;
    persistentPermissions?: boolean;
    hostBoundary?: boolean;
    child?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-shell-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const control = join(root, 'control');
  if (options.hostBoundary) mkdirSync(control, { mode: 0o700 });
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../../packages/agent/src/platform/process/shell-supervisor.ts'),
    ],
    target: 'bun',
    outdir: join(root, 'assets'),
    naming: 'shell-supervisor.js',
  });
  expect(built.success).toBe(true);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const configPath = join(profile.profilePath, 'config.jsonc');
  const command =
    options.command ??
    // biome-ignore lint/suspicious/noTemplateCurlyInString: actual POSIX parameter expansion, not JavaScript
    'printf \'%s|%s|%s\' "$PWD" "$FIXED_VALUE" "${HOME-unset}"; printf once >> effect';
  const a = endpoint(command, options.stop, options.background, options.child),
    b = endpoint('printf next >> effect');
  const configuration = {
    modelId: 'model',
    models: [{ id: 'model', provider: 'compatible', model: 'local-A', baseURL: a.baseURL }],
    tools: [
      'shell.launch',
      'shell.read',
      'shell.wait',
      'shell.stop',
      ...(options.child ? ['task'] : []),
    ].map((id) => ({
      id,
      definitionVersion: '1',
    })),
  };
  writeFileSync(configPath, JSON.stringify(configuration));
  const host = createDefaultProcessConfiguration({
    profile,
    ...(!options.missing
      ? {
          shell: {
            platform: 'darwin' as const,
            configurationId: 'qualified-fixture-1',
            env: { PATH: '/usr/bin:/bin', FIXED_VALUE: 'trusted-fixed' },
            supervisorPath: options.badAsset
              ? join(root, 'absent-guardian.js')
              : built.outputs[0]!.path,
            bunExecutable: process.execPath,
            shellExecutable: '/bin/sh',
            graceMs: 20,
            ...(options.hostBoundary
              ? {
                  host: {
                    controlBase: control,
                    protectedRoots: [profile.dataRoot, control],
                    readonlyAssets: [join(root, 'assets')],
                    runtimeReadOnlyRoots: [dirname(process.execPath)],
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(!options.persistentPermissions
      ? {
          permissionPolicy: {
            readPolicy: () => ({
              mode: options.mode ?? 'full',
              workspaceTrust: true,
              revision: 'trusted-shell-fixture',
              allowed: [
                { kind: 'model' as const, definitionId: 'model', definitionVersion: '1' },
                ...['shell.launch', 'shell.read', 'shell.wait', 'shell.stop']
                  .filter((id) => options.deny !== 'tool' || id !== 'shell.launch')
                  .map((id) => ({
                    kind: 'tool' as const,
                    definitionId: id,
                    definitionVersion: '1',
                  })),
                ...(options.deny === 'job'
                  ? []
                  : [
                      {
                        kind: 'job' as const,
                        definitionId: 'shell.command',
                        definitionVersion: '1',
                      },
                    ]),
              ],
            }),
          },
        }
      : {}),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    ...host,
    store,
    permissions: host.permissions!,
    modelConcurrency: 1,
    processConcurrency: 1,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    id: 'w',
    rootUri: `file://${workspace}`,
    name: 'private',
    expectedStoreId,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'shell' });
  const permissionManagement = host.permissionManagement!(runtime);
  if (options.persistentPermissions) {
    const initial = await permissionManagement.readMode(base);
    await permissionManagement.setMode({
      ...base,
      commandId: 'set-ask',
      mode: 'ask',
      ifRevision: initial.revision,
      makeDefault: false,
      ifDefaultRevision: initial.defaultRevision,
    });
    const observed = await permissionManagement.readTrust({ ...base, workspaceId: 'w' });
    await permissionManagement.setTrust({
      ...base,
      workspaceId: 'w',
      commandId: 'set-trust',
      trusted: true,
      canonicalIdentity: observed.canonicalIdentity,
      externalReadScopeDigest: observed.externalReadScopeDigest,
      ifRevision: observed.revision,
    });
  }
  return {
    root,
    workspace,
    a,
    b,
    configuration,
    configPath,
    runtime,
    store,
    profile,
    permissionManagement,
    base,
    submit: (id = 'work') =>
      runtime.submitCommand({
        ...base,
        commandId: id,
        request: { kind: 'run.start', content: id },
      }),
    done: (id = 'work') => runtime.waitForCommand(id, { timeoutMs: 8000 }),
    async card(definitionId: string) {
      return until(async () => {
        for (const session of await store.listSessions()) {
          const card = (
            await store.listInteractions({
              expectedStoreId,
              sessionId: session.id,
              state: 'pending',
            })
          ).interactions.find((row) => row.definitionId === definitionId);
          if (card) return card;
        }
        return undefined;
      });
    },
    async approve(
      definitionId: string,
      commandId: string,
      grant?: 'approve_once' | 'same_command',
    ) {
      const card = await this.card(definitionId);
      await runtime.answerInteraction({
        ...base,
        presentationSessionId: 's',
        commandId,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', ...(grant ? { grant } : {}) },
      });
      return card;
    },
    async close() {
      await runtime.close();
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
nativeTest(
  'default delegated Shell preserves accepted parent/child policy snapshots for Full and approved Ask',
  async () => {
    const f = await fixture({ hostBoundary: true, persistentPermissions: true, child: true });
    const outside = join(f.root, 'child-outside-effect');
    const dispatch = f.store.markDispatching.bind(f.store);
    const snapshots: unknown[] = [];
    f.store.markDispatching = async (input) => {
      const result = await dispatch(input);
      if ((await f.store.getExecution(input.executionId))?.definitionId === 'shell.command')
        snapshots.push(structuredClone(input.authorization.snapshot));
      return result;
    };
    const setMode = async (mode: 'full' | 'ask', commandId: string) => {
      const current = await f.permissionManagement.readMode(f.base);
      await f.permissionManagement.setMode({
        ...f.base,
        mode,
        commandId,
        ifRevision: current.revision,
        ifDefaultRevision: current.defaultRevision,
        makeDefault: true,
      });
    };
    const childJob = () =>
      until(async () => {
        const child = (await f.store.listExecutions('s'))
          .filter((row) => row.childSessionId)
          .at(-1);
        if (!child?.childSessionId) return undefined;
        const job = (await f.store.listExecutions(child.childSessionId)).find(
          (row) => row.definitionId === 'shell.command',
        );
        return job && !['planned', 'dispatching', 'running'].includes(job.status) ? job : undefined;
      });
    try {
      await setMode('full', 'child-full');
      f.a.command(`printf full > '${outside}'; printf full >> effect`);
      await f.submit();
      expect((await f.done()).status).toBe('applied');
      expect(await childJob()).toMatchObject({
        status: 'succeeded',
        result: { details: { processTreeStopped: true } },
      });
      expect(readFileSync(outside, 'utf8')).toBe('full');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('full');
      await setMode('ask', 'child-ask');
      f.a.command(`printf denied > '${outside}'; printf ask >> effect`);
      await f.submit('grant-child');
      await f.approve('task', 'child-approve-task');
      await f.approve('agent/worker', 'child-approve-carrier');
      await f.approve('shell.launch', 'child-approve-launch');
      const card = await f.card('shell.command');
      expect(card.presentationSessionId).toBe('s');
      expect((await f.store.getExecution(card.executionId))?.sessionId).not.toBe('s');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('full');
      await f.approve('shell.command', 'child-approve-job');
      expect((await f.done('grant-child')).status).toBe('applied');
      expect(await childJob()).toMatchObject({
        status: 'succeeded',
        result: { details: { processTreeStopped: true } },
      });
      expect(readFileSync(outside, 'utf8')).toBe('full');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('fullask');
      expect(snapshots).toEqual(
        ['full', 'ask'].map((mode) =>
          expect.objectContaining({
            namespace: 'agent.permission-intersection',
            version: '1',
            data: {
              policies: ['parent', 'child'].map((scope) =>
                expect.objectContaining({
                  scope,
                  allowed: mode === 'full',
                  snapshot: expect.objectContaining({
                    namespace: 'builtin.permissions',
                    version: '1',
                    data: expect.objectContaining({ mode, workspaceTrust: true }),
                  }),
                }),
              ),
            },
          }),
        ),
      );
      const requests = f.a.requests.length;
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      await f.submit('grant-child');
      await f.runtime.getView('s');
      expect(f.a.requests).toHaveLength(requests);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('fullask');
    } finally {
      await f.close();
    }
  },
  30000,
);
nativeTest(
  'host Job applies the stricter nested AND scope and rejects missing or unknown policy leaves before effects',
  async () => {
    const f = await fixture({ hostBoundary: true });
    const outside = join(f.root, 'nested-outside-effect');
    const leaf = (mode: 'full' | 'ask') => ({
      namespace: 'builtin.permissions',
      version: '1',
      data: {
        mode,
        workspaceTrust: true,
        capability: {
          kind: 'job',
          definitionId: 'shell.command',
          definitionVersion: '1',
          hardAllowed: true,
        },
      },
    });
    const intersect = (
      snapshots: NonNullable<JobContext['dispatchAuthorization']>['snapshot'][],
    ) => ({
      namespace: 'agent.permission-intersection',
      version: '1',
      data: {
        policies: snapshots.map((snapshot, index) => ({
          scope: index ? 'child' : 'parent',
          revision: `owned-${index}`,
          allowed: false,
          snapshot: snapshot ?? null,
        })),
      },
    });
    try {
      const configuration = await createShellConfiguration({
        workspaceRoot: f.workspace,
        toolIds: ['shell.launch'],
        options: {
          platform: 'darwin',
          configurationId: 'nested-scope-test',
          env: { PATH: '/usr/bin:/bin' },
          supervisorPath: join(f.root, 'assets/shell-supervisor.js'),
          bunExecutable: process.execPath,
          shellExecutable: '/bin/sh',
          graceMs: 20,
          host: {
            controlBase: join(f.root, 'control'),
            protectedRoots: [f.profile.dataRoot, join(f.root, 'control')],
            readonlyAssets: [join(f.root, 'assets')],
            runtimeReadOnlyRoots: [dirname(process.execPath)],
          },
        },
      });
      const job = configuration.extensions[0]!.jobs![0]!;
      const context: JobContext = {
        sessionId: 'adapter-test',
        executionId: 'owned-nested',
        signal: new AbortController().signal,
        dispatchAuthorization: {
          revision: 'owned-final-acceptance',
          snapshot: intersect([intersect([leaf('full')]), leaf('ask')]),
        },
      };
      const handle = await job.start(
        { command: `printf denied > '${outside}'; printf workspace > effect` },
        context,
      );
      const events: JobEvent[] = [];
      try {
        for await (const event of job.observe(handle)) events.push(event);
      } finally {
        await job.dispose(handle);
      }
      expect(events.find((event) => event.type === 'terminal')).toMatchObject({
        supervision: 'ended',
        result: { outcome: 'succeeded', details: { processTreeStopped: true } },
      });
      expect(existsSync(outside)).toBe(false);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('workspace');
      for (const snapshot of [
        undefined,
        intersect([leaf('full'), undefined]),
        { ...leaf('full'), namespace: 'unknown-policy' },
      ]) {
        await expect(
          job.start(
            { command: 'printf bypass >> effect' },
            {
              ...context,
              dispatchAuthorization: {
                revision: 'owned-final-acceptance',
                ...(snapshot ? { snapshot } : {}),
              },
            },
          ),
        ).rejects.toMatchObject({ code: 'shell_dispatch_scope_unavailable' });
      }
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('workspace');
    } finally {
      await f.close();
    }
  },
  15000,
);
nativeTest(
  'host Shell uses the final accepted persistent permission snapshot for Full and approved Workspace scopes',
  async () => {
    const f = await fixture({
      hostBoundary: true,
      persistentPermissions: true,
      background: true,
    });
    const outside = join(f.root, 'outside-effect');
    const dispatch = f.store.markDispatching.bind(f.store);
    const snapshots: unknown[] = [];
    f.store.markDispatching = async (input) => {
      const result = await dispatch(input);
      if ((await f.store.getExecution(input.executionId))?.definitionId === 'shell.command')
        snapshots.push(structuredClone(input.authorization.snapshot));
      return result;
    };
    const setMode = async (mode: 'full' | 'ask', commandId: string) => {
      const current = await f.permissionManagement.readMode(f.base);
      await f.permissionManagement.setMode({
        ...f.base,
        mode,
        commandId,
        ifRevision: current.revision,
        ifDefaultRevision: current.defaultRevision,
        makeDefault: false,
      });
    };
    const finishedJob = () =>
      until(async () => {
        const jobs = (await f.store.listExecutions('s')).filter(
          (row) => row.definitionId === 'shell.command',
        );
        const job = jobs.at(-1);
        return job && !['planned', 'dispatching', 'running'].includes(job.status) ? job : undefined;
      });
    let failure: unknown;
    let cleanupFailure: unknown;
    try {
      await setMode('full', 'host-full');
      f.a.command(`printf full > '${outside}'`);
      await f.submit();
      await f.done();
      expect(await finishedJob()).toMatchObject({
        status: 'succeeded',
        result: { details: { processTreeStopped: true } },
      });
      expect(readFileSync(outside, 'utf8')).toBe('full');
      await setMode('ask', 'host-ask');
      f.a.command(`printf denied > '${outside}'; printf workspace >> effect`);
      await f.submit('grant-workspace');
      await f.approve('shell.launch', 'host-approve-tool');
      const card = await f.card('shell.command');
      expect((await f.store.getExecution(card.executionId))?.status).toBe('planned');
      expect(readFileSync(outside, 'utf8')).toBe('full');
      await f.approve('shell.command', 'host-approve-job');
      await f.done('grant-workspace');
      const job = await until(async () => {
        const row = await f.store.getExecution(card.executionId);
        return row && !['planned', 'dispatching', 'running'].includes(row.status) ? row : undefined;
      });
      expect(job).toMatchObject({
        status: 'succeeded',
        result: { details: { processTreeStopped: true } },
      });
      expect(readFileSync(outside, 'utf8')).toBe('full');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('workspace');
      expect(snapshots).toEqual([
        expect.objectContaining({
          namespace: 'builtin.permissions',
          version: '1',
          data: expect.objectContaining({ mode: 'full', workspaceTrust: true }),
        }),
        expect.objectContaining({
          namespace: 'builtin.permissions',
          version: '1',
          data: expect.objectContaining({ mode: 'ask', workspaceTrust: true }),
        }),
      ]);
    } catch (error) {
      failure = error;
      console.error(
        JSON.stringify({
          caseId: 'host_shell_persistent_permission_failure',
          root: f.root,
          executions: await f.store.listExecutions('s'),
        }),
      );
    } finally {
      try {
        await f.close();
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
    }
    if (failure && cleanupFailure)
      throw new AggregateError([failure, cleanupFailure], 'host_shell_test_failed');
    if (failure) throw failure;
    if (cleanupFailure) throw cleanupFailure;
  },
  20000,
);
nativeTest(
  'default Shell tools use actual Workspace/env/assets and durable Job output; exact Command retry and reads cause no process replay',
  async () => {
    const f = await fixture();
    try {
      await f.submit();
      const command = await f.done();
      expect(command.status).toBe('applied');
      const executions = await f.store.listExecutions('s');
      const job = executions.find((row) => row.definitionId === 'shell.command')!;
      expect(job.status).toBe('succeeded');
      expect(job.kind).toBe('job');
      for (const id of ['shell.launch', 'shell.read', 'shell.wait'])
        expect(
          executions
            .filter((row) => row.definitionId === id)
            .every((row) => row.status === 'succeeded'),
        ).toBe(true);
      const output = await f.store.listExecutionOutput({
        executionId: job.id,
        afterSeq: '0',
        limit: 200,
      });
      expect(output.items.map((row) => row.content).join('')).toBe(
        `${f.workspace}|trusted-fixed|unset`,
      );
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('once');
      const read = executions.find((row) => row.definitionId === 'shell.read')!;
      expect(read.result).toMatchObject({
        details: { output: { highWaterSeq: output.highWaterSeq } },
      });
      const before = (await f.store.getMetadata()).lastChangeCursor;
      const requests = f.a.requests.length;
      expect(await f.submit()).toEqual(command);
      await f.runtime.getView('s');
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
      expect(f.a.requests).toHaveLength(requests);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('once');
      const snapshot = (await f.store.getView('s')).runs[0]!.configuration;
      expect(snapshot).toMatchObject({
        snapshot: {
          shell: {
            available: true,
            cwd: f.workspace,
            envKeys: ['FIXED_VALUE', 'PATH'],
            configurationId: 'qualified-fixture-1',
            job: { id: 'shell.command', definitionVersion: '1' },
          },
        },
      });
      expect(JSON.stringify(snapshot)).not.toContain('trusted-fixed');
      expect(JSON.stringify(snapshot)).not.toContain('HTTP_PROXY');
      expect(f.a.requests[0]!.tools).toBeDefined();
    } finally {
      await f.close();
    }
  },
  15000,
);
nativeTest(
  'trusted Shell grant digest preserves exact execution environment and default semantics while excluding only the operation key',
  async () => {
    const f = await fixture();
    try {
      const options = {
        platform: 'darwin' as const,
        configurationId: 'digest-fixture',
        env: { FIXED: 'original', PATH: '/usr/bin:/bin' },
        supervisorPath: join(f.root, 'assets/shell-supervisor.js'),
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
      };
      const configuration = { workspaceRoot: f.workspace, toolIds: ['shell.launch'], options };
      const first = await createShellConfiguration(configuration);
      const original: AuthorizationRequest = {
        kind: 'tool',
        sessionId: 's',
        runId: 'r',
        executionId: 'e',
        definitionId: 'shell.launch',
        definitionVersion: '1',
        signal: new AbortController().signal,
        input: { key: 'first', command: 'printf original' },
      };
      const digest = first.commandDigest(original);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(
        first.commandDigest({
          ...original,
          executionId: 'other',
          input: { key: 'second', command: 'printf original', cancellation: 'attached' },
        }),
      ).toBe(digest);
      expect(
        first.commandDigest({ ...original, input: { key: 'second', command: 'printf changed' } }),
      ).not.toBe(digest);
      expect(
        first.commandDigest({
          ...original,
          input: { key: 'second', command: 'printf original', cancellation: 'detached' },
        }),
      ).not.toBe(digest);
      const explicitDefaults = await createShellConfiguration({
        ...configuration,
        options: {
          ...options,
          env: { PATH: '/usr/bin:/bin', FIXED: 'original' },
          graceMs: 200,
          maxQueuedBytes: 256 * 1024,
        },
      });
      expect(explicitDefaults.commandDigest(original)).toBe(digest);
      options.env.FIXED = 'changed';
      expect(first.commandDigest(original)).toBe(digest);
      const changedEnv = await createShellConfiguration(configuration);
      expect(changedEnv.commandDigest(original)).not.toBe(digest);
      const otherWorkspace = join(f.root, 'other');
      mkdirSync(otherWorkspace);
      const changedWorkspace = await createShellConfiguration({
        ...configuration,
        workspaceRoot: otherWorkspace,
      });
      expect(changedWorkspace.commandDigest(original)).not.toBe(changedEnv.commandDigest(original));
      expect(first.commandDigest({ ...original, definitionVersion: '2' })).toBeUndefined();
      expect(
        first.commandDigest({
          ...original,
          kind: 'job',
          definitionId: 'shell.command',
          input: { command: 'printf original' },
        }),
      ).not.toBe(digest);
      expect(f.a.requests).toHaveLength(0);
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
    } finally {
      await f.close();
    }
  },
  15000,
);
nativeTest(
  'Ask launch approval precedes a separate exact Shell Job approval and any process effect',
  async () => {
    const f = await fixture({ mode: 'ask' });
    try {
      await f.submit();
      const tool = await f.card('shell.launch');
      expect(tool.request).toMatchObject({
        policy: { effects: ['process', 'unknown', 'record_write'] },
      });
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      expect(
        (await f.store.listExecutions('s')).some((row) => row.definitionId === 'shell.command'),
      ).toBe(false);
      await f.approve('shell.launch', 'approve-tool');
      const job = await f.card('shell.command');
      expect(job.executionId).not.toBe(tool.executionId);
      expect(job.request).toMatchObject({ policy: { effects: ['process', 'unknown'] } });
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      expect((await f.store.getExecution(job.executionId))?.status).toBe('planned');
      await f.approve('shell.command', 'approve-job');
      await f.done();
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('once');
    } finally {
      await f.close();
    }
  },
  15000,
);
nativeTest(
  'real Shell same_command accepts two new operation keys, keeps independent Tool/Job grants and clears once after a lost HTTP receipt',
  async () => {
    const f = await fixture({ persistentPermissions: true });
    const serverProfile = {
      dataRoot: f.profile.dataRoot,
      name: f.profile.profile,
      accessKey: f.profile.profileAccessKey,
    };
    const service = await startService({
      runtime: f.runtime,
      permissionManagement: f.permissionManagement,
      subjectId: f.base.subjectId,
      profile: serverProfile,
      buildId: 'real-shell-grants',
    });
    const sockets = new Set<Socket>();
    let clearPosts = 0,
      loseClear = false;
    const proxy = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(service.endpoint + request.url!, {
          method: request.method,
          headers: {
            authorization: `Bearer ${service.bootstrap.token}`,
            'content-type': 'application/json',
          },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const body = await upstream.arrayBuffer();
        if (request.method === 'POST' && request.url?.endsWith('/permission-grants')) {
          clearPosts++;
          if (loseClear) {
            loseClear = false;
            request.socket.destroy();
            response.destroy();
            return;
          }
        }
        response.writeHead(upstream.status, { 'content-type': 'application/json' });
        response.end(Buffer.from(body));
      } catch {
        response.destroy();
      }
    });
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address() as { port: number };
    const client = createClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: serverProfile,
        apiMajor: 1,
        requiredCapabilities: ['permission_grants', 'commands'],
      },
    });
    try {
      await client.connect();
      await f.submit('grant-first');
      const tool = await f.card('shell.launch');
      expect(tool.request).toMatchObject({ grants: ['approve_once', 'same_command'] });
      await client.answerInteraction('s', tool.id, {
        expectedStoreId: f.base.expectedStoreId,
        commandId: 'grant-tool',
        expectedRevision: tool.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
      });
      const job = await f.card('shell.command');
      await client.answerInteraction('s', job.id, {
        expectedStoreId: f.base.expectedStoreId,
        commandId: 'grant-job',
        expectedRevision: job.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
      });
      expect((await f.done('grant-first')).status).toBe('applied');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('once');
      const beforeRead = (await f.store.getMetadata()).lastChangeCursor;
      const beforeProvider = f.a.requests.length;
      const first = await client.listPermissionGrants('s', {
        storeId: f.base.expectedStoreId,
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.nextAfterSeq).not.toBeNull();
      const second = await client.listPermissionGrants('s', {
        storeId: f.base.expectedStoreId,
        afterSeq: first.nextAfterSeq!,
        upperSeq: first.upperSeq,
        limit: 1,
      });
      expect(second.nextAfterSeq).toBeNull();
      const grants = [...first.items, ...second.items].map((row) => row.grant);
      expect(grants.map((row) => row.kind).sort()).toEqual(['job', 'tool']);
      expect(new Set(grants.map((row) => row.interactionId))).toEqual(new Set([tool.id, job.id]));
      expect(grants.every((row) => /^[a-f0-9]{64}$/.test(row.commandDigest!))).toBe(true);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(beforeRead);
      expect(f.a.requests).toHaveLength(beforeProvider);
      await f.submit('grant-second');
      expect((await f.done('grant-second')).status).toBe('applied');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('onceonce');
      const executions = await f.store.listExecutions('s');
      expect(
        executions.filter(
          (row) => row.definitionId === 'shell.command' && row.status === 'succeeded',
        ),
      ).toHaveLength(2);
      expect(
        (
          await f.store.listInteractions({
            expectedStoreId: f.base.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions,
      ).toHaveLength(0);
      f.a.command('printf changed >> effect');
      await f.submit('grant-changed');
      const changed = await f.card('shell.launch');
      expect(changed.id).not.toBe(tool.id);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('onceonce');
      await client.answerInteraction('s', changed.id, {
        expectedStoreId: f.base.expectedStoreId,
        commandId: 'deny-changed',
        expectedRevision: changed.revision,
        answer: { kind: 'approval', decision: 'deny' },
      });
      await f.done('grant-changed');
      const original = {
        expectedStoreId: f.base.expectedStoreId,
        commandId: 'clear-original',
        ifRevision: first.revision,
      };
      loseClear = true;
      let lost: unknown;
      try {
        await client.clearPermissionGrants('s', original);
      } catch (error) {
        lost = error;
      }
      expect((lost as { code: string }).code).toBe('network_outcome_unknown');
      const receipt = await client.getPermissionMutation(original.commandId, {
        storeId: original.expectedStoreId,
      });
      expect(receipt).toMatchObject({
        commandId: original.commandId,
        kind: 'permission.grants.clear',
        state: 'applied',
        receipt: {
          status: 'applied',
          sessionId: 's',
          revision: String(BigInt(first.revision) + 1n),
        },
      });
      expect(clearPosts).toBe(1);
      expect(
        (await client.listPermissionGrants('s', { storeId: original.expectedStoreId })).items,
      ).toHaveLength(0);
      expect(
        await client.getPermissionMutation(original.commandId, {
          storeId: original.expectedStoreId,
        }),
      ).toEqual(receipt);
      expect(clearPosts).toBe(1);
      f.a.command(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Actual POSIX environment expansion must remain literal.
        'printf \'%s|%s|%s\' "$PWD" "$FIXED_VALUE" "${HOME-unset}"; printf once >> effect',
      );
      await f.submit('grant-after-clear');
      const after = await f.card('shell.launch');
      expect(after.id).not.toBe(tool.id);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('onceonce');
      await client.answerInteraction('s', after.id, {
        expectedStoreId: original.expectedStoreId,
        commandId: 'deny-after-clear',
        expectedRevision: after.revision,
        answer: { kind: 'approval', decision: 'deny' },
      });
      await f.done('grant-after-clear');
      const changedScope = await fetch(
        service.endpoint +
          `/v1/sessions/s/permission-grants?storeId=${original.expectedStoreId}&subjectId=other`,
        { headers: { authorization: `Bearer ${service.bootstrap.token}` } },
      );
      expect(changedScope.status).toBe(400);
      const directory = await fetch(
        `${service.endpoint}/v1/sessions/s/permission-grants?storeId=${original.expectedStoreId}`,
        { headers: { authorization: `Bearer ${service.bootstrap.token}` } },
      );
      expect(directory.headers.get('cache-control')).toBe('no-store');
      expect(directory.headers.get('x-content-type-options')).toBe('nosniff');
      await directory.json();
    } finally {
      client.disposeNetwork();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await service.close();
      await f.close();
    }
  },
  25000,
);
nativeTest(
  'Shell exact stop request settles only with actual guardian group proof; original output facts remain available',
  async () => {
    const f = await fixture({ stop: true, command: "trap '' TERM; sleep 30 & printf ready; wait" });
    try {
      await f.submit();
      await f.done();
      const rows = await f.store.listExecutions('s');
      const job = rows.find((row) => row.definitionId === 'shell.command')!;
      expect(job.status).toBe('cancelled');
      const group = (job.reference as { processGroupId: number }).processGroupId;
      expect(() => process.kill(-group, 0)).toThrow();
      const stop = rows.find((row) => row.definitionId === 'shell.stop')!;
      expect(stop.result).toMatchObject({ details: { cancelRequested: true } });
      expect(
        (await f.store.listExecutionOutput({ executionId: job.id, afterSeq: '0', limit: 200 }))
          .highWaterSeq,
      ).toBeDefined();
      expect(
        (
          await f.store.getExtensionRecord({
            sessionId: 's',
            extensionId: 'builtin.shell',
            key: 'shell/work',
          })
        )?.value,
      ).toMatchObject({ ref: { executionId: job.id, originStoreId: f.base.expectedStoreId } });
    } finally {
      await f.close();
    }
  },
  15000,
);
nativeTest(
  'host/asset qualification and exact policy refusal have zero Shell process effects; JSONC cannot supply env or executor',
  async () => {
    for (const options of [
      { missing: true },
      { badAsset: true },
      { deny: 'tool' as const },
      { deny: 'job' as const },
    ]) {
      const f = await fixture(options);
      try {
        await f.submit();
        const result = await f.done();
        if (options.missing) expect(result.receipt).toMatchObject({ reason: 'shell_unavailable' });
        expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
        expect(
          (await f.store.listExecutions('s')).filter(
            (row) => row.definitionId === 'shell.command' && row.status === 'succeeded',
          ),
        ).toHaveLength(0);
        if (options.missing || 'badAsset' in options) expect(f.a.requests).toHaveLength(0);
      } finally {
        await f.close();
      }
    }
    const f = await fixture();
    try {
      writeFileSync(
        f.configPath,
        JSON.stringify({
          ...f.configuration,
          tools: [
            {
              id: 'shell.launch',
              definitionVersion: '1',
              options: { env: { HOME: 'attacker' }, shellExecutable: '/tmp/attacker' },
            },
          ],
        }),
      );
      await f.submit();
      expect((await f.done()).receipt).toMatchObject({ reason: 'credential_reference_required' });
      writeFileSync(
        f.configPath,
        JSON.stringify({
          ...f.configuration,
          tools: [
            {
              id: 'shell.launch',
              definitionVersion: '1',
              options: { shellExecutable: '/tmp/attacker' },
            },
          ],
        }),
      );
      await f.submit('next');
      expect((await f.done('next')).receipt).toMatchObject({ reason: 'unsupported_tool_options' });
      expect(f.a.requests).toHaveLength(0);
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
    } finally {
      await f.close();
    }
  },
  15000,
);
nativeTest(
  'next Run selects a new compatible route without relabeling the original Shell snapshot/record',
  async () => {
    const f = await fixture();
    try {
      await f.submit();
      await f.done();
      const original = (await f.store.getView('s')).runs[0]!.configuration;
      const record = await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: 'builtin.shell',
        key: 'shell/work',
      });
      f.configuration.models[0]!.baseURL = f.b.baseURL;
      f.configuration.models[0]!.model = 'local-B';
      writeFileSync(f.configPath, JSON.stringify(f.configuration));
      await f.submit('next');
      await f.done('next');
      expect(f.b.requests.length).toBeGreaterThan(0);
      expect(f.b.requests.every((row) => row.model === 'local-B')).toBe(true);
      expect((await f.store.getView('s')).runs[0]!.configuration).toEqual(original);
      expect(
        await f.store.getExtensionRecord({
          sessionId: 's',
          extensionId: 'builtin.shell',
          key: 'shell/work',
        }),
      ).toEqual(record);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('oncenext');
    } finally {
      await f.close();
    }
  },
  15000,
);
test('Shell factory without selected tools is inert and unsupported platforms are explicit rather than raw fallback', async () => {
  expect(
    (await createShellConfiguration({ workspaceRoot: '/not-read', toolIds: [] })).extensions,
  ).toEqual([]);
  await expect(
    createShellConfiguration({ workspaceRoot: '/not-read', toolIds: ['shell.launch'] }),
  ).rejects.toMatchObject({ code: 'shell_unavailable' });
});

nativeTest(
  'detached Shell keeps its original binding after parent finish; one process slot queues another Session until exact confirmed stop',
  async () => {
    const f = await fixture({
      background: true,
      command: "printf started > started; trap '' TERM; sleep 30 & wait",
    });
    try {
      await f.submit();
      await f.done();
      const first = await until(async () => {
        const row = (await f.store.listExecutions('s')).find(
          (item) => item.definitionId === 'shell.command',
        );
        return row?.status === 'running' ? row : undefined;
      });
      expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
      await until(async () => (existsSync(join(f.workspace, 'started')) ? true : undefined));
      f.configuration.models[0]!.baseURL = f.b.baseURL;
      writeFileSync(f.configPath, JSON.stringify(f.configuration));
      await f.runtime.createSession({
        ...f.base,
        sessionId: 'other',
        commandId: 'other-create',
        workspaceId: 'w',
        title: 'other',
      });
      await f.runtime.submitCommand({
        ...f.base,
        sessionId: 'other',
        commandId: 'queued',
        request: { kind: 'run.start', content: 'next' },
      });
      const queued = await until(async () => {
        const row = (await f.store.listExecutions('other')).find(
          (item) => item.definitionId === 'shell.command',
        );
        return row?.status === 'planned' ? row : undefined;
      });
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      expect((await f.store.getExecution(first.id))?.status).toBe('running');
      await f.runtime.cancelExecution({
        ...f.base,
        commandId: 'precise-stop',
        executionId: first.id,
      });
      await until(async () => {
        const row = await f.store.getExecution(first.id);
        return row?.status === 'cancelled' ? row : undefined;
      });
      expect(() =>
        process.kill(-(first.reference as { processGroupId: number }).processGroupId, 0),
      ).toThrow();
      await f.runtime.waitForCommand('queued', { timeoutMs: 8000 });
      expect((await f.store.getExecution(queued.id))?.status).toBe('succeeded');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('next');
      expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    } finally {
      await f.close();
    }
  },
  15000,
);
