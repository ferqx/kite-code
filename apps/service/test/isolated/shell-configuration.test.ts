import { Database } from 'bun:sqlite';
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
import { pathToFileURL } from 'node:url';
import { createRuntime, prepareOutputDirectory } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { AuthorizationRequest, JobContext, JobEvent } from '@kite-ai/agent/extensions';
import { createShellConfiguration } from '@kite-ai/agent/permissions/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import type { SqliteOperations } from '../../../../packages/agent/src/storage/sqlite/operations';
import { isOutputCollectionCommand } from '../../../../packages/agent/src/storage/sqlite/output-collection';
import { fixtureScopeOption } from '../../../../tests/fixtures/permission-grant';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createCodexLocalSource } from '../../src/codex-auth';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

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
function permissionSnapshot(raw: unknown): unknown {
  const value = raw as { namespace: string; data: Record<string, unknown> };
  if (value.namespace === 'builtin.business.permissions') {
    expect(Object.keys(value.data).sort()).toEqual(['current', 'gate']);
    expect(value.data.gate === null || typeof value.data.gate === 'object').toBe(true);
    return permissionSnapshot(value.data.current);
  }
  if (value.namespace === 'agent.permission-intersection')
    return {
      ...value,
      data: {
        ...value.data,
        policies: (value.data.policies as { snapshot: unknown }[]).map((policy) => ({
          ...policy,
          snapshot: permissionSnapshot(policy.snapshot),
        })),
      },
    };
  return value;
}

type RequestedScope = {
  filesystem: 'workspace_write' | 'full_access';
  network: 'none' | 'internet';
};
function endpoint(
  command: string,
  stop = false,
  background = false,
  child = false,
  review?: 'approve_once' | 'reject' | 'ask_user',
  childPreset?: 'explore',
  reviewDelayMs = 0,
  childCount = 1,
) {
  let actualCommand = command;
  const childTask = childPreset
    ? 'Inspect source read-only. Do not modify files.'
    : 'child-shell-task';
  let permissions: RequestedScope | undefined;
  let description: string | undefined;
  let workdir: string | undefined;
  const reviews: Record<string, unknown>[] = [];
  let beforeStop: ((sessionId: number) => Promise<void>) | undefined;
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content: string }[];
      let reviewPayload: Record<string, unknown> | undefined;
      if (review) {
        try {
          const parsed = JSON.parse(
            messages.filter((row) => row.role === 'user').at(-1)?.content ?? '',
          ) as Record<string, unknown>;
          if (parsed.purpose === 'authorization_check' || parsed.purpose === 'shell_risk') {
            reviewPayload = parsed;
            reviews.push(parsed);
          }
        } catch {}
      }
      if (reviewPayload && reviewDelayMs) await Bun.sleep(reviewDelayMs);
      const last = messages.reduce(
        (v, m, i) =>
          m.role === 'user' &&
          (/^(?:New task: )?新任务：(work|next|grant-[a-z-]+)$/.test(m.content) ||
            (child && m.content.replace(/^New task: /, '') === childTask))
            ? i
            : v,
        -1,
      );
      const results = messages.slice(last + 1).filter((row) => row.role === 'tool');
      const isChild = child && messages[last]?.content.replace(/^New task: /, '') === childTask;
      let sessionId: number | undefined;
      try {
        const feedback = JSON.parse(results[0]?.content ?? '') as { session_id?: unknown };
        if (typeof feedback.session_id === 'number' && Number.isSafeInteger(feedback.session_id))
          sessionId = feedback.session_id;
      } catch {}
      const calls =
        child && !isChild
          ? Array.from({ length: childCount }, (_, index) => ({
              name: 'spawn_agent',
              input: {
                message: childTask,
                task_name: `Shell fixture ${index + 1}`,
                ...(childPreset ? { agent_type: childPreset } : {}),
              },
            }))
          : [
              {
                name: 'exec_command',
                input: {
                  cmd: actualCommand,
                  ...(workdir === undefined ? {} : { workdir }),
                  yield_time_ms: 0,
                  ...(description === undefined ? {} : { description }),
                  ...(permissions ?? {}),
                },
              },
              {
                name: stop ? 'terminate_session' : 'poll_command',
                input: stop
                  ? { session_id: sessionId }
                  : { session_id: sessionId, yield_time_ms: 4000 },
              },
              { name: 'poll_command', input: { session_id: sessionId, yield_time_ms: 4000 } },
            ];
      const call =
        reviewPayload ||
        (background && results.length > 0) ||
        (!(child && !isChild) && results.length > 0 && sessionId === undefined)
          ? undefined
          : calls[results.length];
      if (call?.name === 'terminate_session') await beforeStop?.(sessionId!);
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
            : {
                content: reviewPayload
                  ? JSON.stringify(
                      reviewPayload.purpose === 'shell_risk'
                        ? {
                            risk:
                              review === 'approve_once'
                                ? 'ordinary'
                                : review === 'reject'
                                  ? 'critical'
                                  : 'high',
                            reason: 'scope rejected by reviewer',
                          }
                        : { decision: review, reason: 'scope rejected by reviewer' },
                    )
                  : 'supervised Shell facts',
              },
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
    reviews,
    permissions(value?: RequestedScope) {
      permissions = value;
    },
    workdir(value?: string) {
      workdir = value;
    },
    description(value?: string) {
      description = value;
    },
    beforeStop(callback: (sessionId: number) => Promise<void>) {
      beforeStop = callback;
    },
    command(value: string) {
      actualCommand = value;
    },
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  };
}
async function fixture(
  options: {
    mode?: 'full' | 'accept_edits' | 'auto';
    review?: 'approve_once' | 'reject' | 'ask_user';
    reviewDelayMs?: number;
    reviewTimeoutMs?: number;
    deny?: 'tool' | 'job';
    missing?: boolean;
    badAsset?: boolean;
    stop?: boolean;
    command?: string;
    background?: boolean;
    persistentPermissions?: boolean;
    hostBoundary?: boolean;
    child?: boolean;
    childCount?: number;
    delayCollection?: boolean;
    childSequenceGap?: boolean;
    childPreset?: 'explore';
    codexHome?: 'missing' | 'present' | 'relative' | 'empty' | 'nul';
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-shell-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const control = join(root, 'control');
  if (options.hostBoundary) privateDirectory(control);
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
  privateDirectory(profile.profilePath);
  const configPath = join(profile.profilePath, 'config.jsonc');
  const command =
    options.command ??
    // biome-ignore lint/suspicious/noTemplateCurlyInString: actual POSIX parameter expansion, not JavaScript
    'printf \'%s|%s|%s\' "$PWD" "$FIXED_VALUE" "${HOME-unset}"; printf once >> effect';
  const a = endpoint(
      command,
      options.stop,
      options.background,
      options.child,
      options.review,
      options.childPreset,
      options.reviewDelayMs,
      options.childCount,
    ),
    b = endpoint('printf next >> effect');
  const configuration = {
    ...(options.reviewTimeoutMs ? { autoApproval: { timeoutMs: options.reviewTimeoutMs } } : {}),
    modelId: 'model',
    models: [{ id: 'model', provider: 'compatible', model: 'local-A', baseURL: a.baseURL }],
    tools: [
      'shell.execute',
      'shell.read',
      'shell.stop',
      ...(options.child ? ['task.spawn'] : []),
    ].map((id) => ({
      id,
      definitionVersion: '1',
    })),
  };
  writeFileSync(configPath, JSON.stringify(configuration));
  const codexHome = join(root, 'codex-home');
  const sourceHome =
    options.codexHome === 'relative'
      ? 'relative-codex-home'
      : options.codexHome === 'empty'
        ? ''
        : options.codexHome === 'nul'
          ? join(root, 'invalid\0home')
          : codexHome;
  if (options.codexHome === 'present') {
    privateDirectory(codexHome);
    writeFileSync(join(codexHome, 'auth.json'), 'SYNTHETIC_PRIVATE_AUTH_MATERIAL', { mode: 0o600 });
  }
  const hostOptions: Parameters<typeof createDefaultProcessConfiguration>[0] = {
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    ...(options.codexHome ? { localCodex: createCodexLocalSource({ codexHome: sourceHome }) } : {}),
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
                    protectedRoots: [],
                    readonlyAssets: [],
                    runtimeReadOnlyRoots: [],
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
                ...['shell.execute', 'shell.read', 'shell.stop']
                  .filter((id) => options.deny !== 'tool' || id !== 'shell.execute')
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
  };
  const host = createDefaultProcessConfiguration(hostOptions);
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const artifacts = createArtifactStore({ profile, store });
  let releaseCollection!: () => void;
  const collectionReady = new Promise<void>((resolve) => {
    releaseCollection = resolve;
  });
  const runtime = createRuntime({
    ...host,
    extensions: host.extensions!.map((extension) =>
      !options.delayCollection || extension.id !== 'builtin.files'
        ? extension
        : {
            ...extension,
            actions: extension.actions?.map((action) =>
              action.id !== 'collect-outputs'
                ? action
                : {
                    ...action,
                    async prepare(input, context) {
                      await collectionReady;
                      return action.prepare(input, context);
                    },
                  },
            ),
          },
    ),
    store,
    artifacts,
    ...(options.childSequenceGap
      ? {
          outputCollections: {
            async prepare(context, identity) {
              if (context.sessionId !== 's') {
                // Durable sequence gap models a child with more local history than its root.
                const db = new Database(profile.databasePath);
                try {
                  db.run('UPDATE session SET next_seq=next_seq+100 WHERE id=?', [
                    context.sessionId,
                  ]);
                } finally {
                  db.close();
                }
              }
              return prepareOutputDirectory(runtime, context, identity);
            },
          },
        }
      : {}),
    permissions: host.permissions!,
    modelConcurrency: 1,
    processConcurrency: options.childCount ?? 1,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    id: 'w',
    rootUri: pathToFileURL(workspace).href,
    name: 'private',
    expectedStoreId,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'shell' });
  const permissionManagement = host.permissionManagement!(runtime);
  if (!options.persistentPermissions)
    await initializeLivePermissionFixture({
      runtime,
      profile,
      ...base,
      workspaceId: 'w',
      mode: options.mode ?? 'full',
      trusted: true,
      nativeShellRead: true,
    });
  if (options.persistentPermissions) {
    const initial = await permissionManagement.readMode(base);
    await permissionManagement.setMode({
      ...base,
      commandId: 'set-mode',
      mode: options.mode ?? 'accept_edits',
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
    codexHome,
    permissionManagement,
    base,
    createHost: () => createDefaultProcessConfiguration(hostOptions),
    releaseCollection,
    submit: (id = 'work') =>
      runtime.submitCommand({
        ...base,
        commandId: id,
        request: { kind: 'run.start', content: `新任务：${id}` },
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
        answer: {
          kind: 'approval',
          decision: 'approve',
          optionId: grant === 'same_command' ? fixtureScopeOption(card.request) : 'once',
        },
      });
      return card;
    },
    async close() {
      releaseCollection();
      await runtime.close();
      await artifacts.close();
      a.close();
      b.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
// The default Service may continue the parent when a late child report arrives.
// Collection retries must not replay the child's model or Shell, but cannot count
// that separately authorized parent Run as a replay of the producer.
function requestRunId(request: Record<string, unknown>): string | undefined {
  const messages = request.messages as { role: string; content: string }[];
  return messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      /^<runtime-state source="runtime.kernel">\nrun: ([^\n]+)/.exec(message.content),
    )
    .find((match) => match)?.[1];
}
async function childProducerSnapshot(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  const runs = (await f.store.getView(sessionId)).runs.map((run) => ({
    id: run.id,
    originCommandId: run.originCommandId,
    status: run.status,
  }));
  const executions = (await f.store.listExecutions(sessionId))
    .filter(
      (execution) => execution.kind === 'model' || execution.definitionId.startsWith('shell.'),
    )
    .map((execution) => ({
      id: execution.id,
      runId: execution.runId,
      definitionId: execution.definitionId,
      status: execution.status,
      resultRevision: execution.resultRevision,
    }));
  return {
    runs,
    executions,
    requests: f.a.requests.filter((request) =>
      runs.some((run) => requestRunId(request) === run.id),
    ),
  };
}
async function expectOriginalChildReport(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  requestsBefore: number,
) {
  const carrier = (await f.store.listExecutions('s')).find(
    (row) => row.childSessionId === sessionId,
  )!;
  const [target] = await f.store.readAgentTargets({
    ...f.base,
    extensionId: 'builtin.task',
    agentIds: [sessionId],
  });
  const childRunId = (carrier.result as { details: { runId: string } }).details.runId;
  expect(await f.store.getRun(childRunId)).toMatchObject({ sessionId, status: 'completed' });
  const report = await until(async () =>
    (await f.store.getView('s')).runs.find((run) => run.originCommandId.startsWith('report-')),
  );
  await f.runtime.waitForCommand(report.originCommandId, { timeoutMs: 8000 });
  expect(await f.store.getCommand(report.originCommandId)).toMatchObject({
    kind: 'job.report',
    sessionId: 's',
    status: 'applied',
    request: { executionId: carrier.id, resultRevision: carrier.resultRevision },
    receipt: { executionId: carrier.id, runId: report.id, mode: 'idle_new_turn' },
  });
  const reportRequests = f.a.requests.filter((request) => requestRunId(request) === report.id);
  expect(reportRequests).toHaveLength(1);
  // Every request arriving during collection/retry must be this exact report,
  // not an unknown Run, another child invocation, or an authorization check.
  for (const request of f.a.requests.slice(requestsBefore))
    expect(requestRunId(request)).toBe(report.id);
  const messages = reportRequests[0]!.messages as { role: string; content: string }[];
  const source = messages.find(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.startsWith(
        'Child result source (untrusted data; no additional authorization):\n',
      ),
  )!;
  expect(JSON.parse(source.content.split('\n')[1]!)).toMatchObject({
    format: 'child_result_source',
    inclusion: 'automatic',
    origin: {
      executionId: carrier.id,
      resultRevision: carrier.resultRevision,
      storeId: f.base.expectedStoreId,
    },
    child: {
      target: `a${target!.seq}`,
      dispatch_id: carrier.id,
      runId: childRunId,
      status: 'completed',
      outcome: 'succeeded',
    },
  });
  const executions = (await f.store.listExecutions('s')).filter((row) => row.runId === report.id);
  expect(executions.map((row) => row.kind)).toEqual(['model']);
  expect(executions[0]?.status).toBe('succeeded');
}
for (const scenario of ['root', 'child', 'settled-child'] as const) {
  const child = scenario !== 'root';
  nativeTest(
    `fresh Full ${scenario} Shell delivers its own immutable attachment without approval or review`,
    async () => {
      const f = await fixture({
        mode: 'full',
        hostBoundary: true,
        persistentPermissions: true,
        child,
        delayCollection: scenario === 'settled-child',
        review: 'ask_user',
        command:
          'printf not-an-attachment > workspace-only.txt; printf full-delivery > "$KITE_OUTPUT_DIR/full.txt"; printf full-done',
      });
      try {
        await f.submit();
        await f.done();
        const sessionId = child
          ? await until(async () => {
              const carrier = (await f.store.listExecutions('s')).find((row) => row.childSessionId);
              return carrier?.status === 'succeeded' ? carrier.childSessionId! : undefined;
            })
          : 's';
        const scope = { ...f.base, sessionId };
        f.releaseCollection();
        const page = await until(async () => {
          const page = await f.runtime.queryOutputFiles(scope);
          return page.items.length === 1 && page.collections[0]?.state === 'ready'
            ? page
            : undefined;
        });
        expect(page.items[0]?.name).toBe('full.txt');
        const record = await f.runtime.resolveOutputFile({ ...scope, target: page.items[0]! });
        const read = await f.runtime.readArtifact({
          ...scope,
          refId: record.reference.id,
          scope: record.reference.scope,
        });
        expect(new TextDecoder().decode(read.content)).toBe('full-delivery');
        expect(f.a.reviews).toEqual([]);
        expect((await f.runtime.listInteractions(f.base)).interactions).toEqual([]);
        const jobs = (await f.store.listExecutions(sessionId)).filter(
          (row) => row.definitionId === 'shell.command',
        );
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          status: 'succeeded',
          authorization: { dispatched: true },
          result: { details: { processTreeStopped: true } },
        });
        expect(jobs[0]?.authorization?.human).toBeUndefined();
        expect(jobs[0]?.authorization?.check).toBeUndefined();
        expect(page.items[0]?.sessionId).toBe(sessionId);
        expect(record.sourceRunId).toBe(page.items[0]!.ownerRunId);
        expect(record.sourceExecutionId).toBe(jobs[0]!.id);
        expect(record.reference.scope).toEqual({ kind: 'session', id: sessionId });
        if (child) {
          expect((await f.runtime.queryOutputFiles(f.base)).items).toEqual([]);
          const wrongScope = await f.runtime
            .resolveOutputFile({ ...f.base, target: page.items[0]! })
            .then(
              () => null,
              (error) => error,
            );
          expect(wrongScope?.code).toBe('output_target_invalid');
          const db = new Database(f.profile.databasePath, { readonly: true });
          try {
            const query = db.query(
              "SELECT * FROM command WHERE session_id=? AND kind='extension.invoke'",
            );
            query.safeIntegers(true);
            const command = query.get(sessionId) as Record<string, string | number | bigint | null>;
            const reader = {
              row(sql: string, ...args: (string | number | bigint | null)[]) {
                const query = db.query(sql);
                query.safeIntegers(true);
                return query.get(...args);
              },
            } as SqliteOperations;
            expect(isOutputCollectionCommand(reader, command)).toBe(true);
            for (const change of [
              { id: 'forged-output-collect' },
              { subject_id: 'other-subject' },
              { session_id: 's' },
              {
                request_json: JSON.stringify({
                  ...JSON.parse(String(command.request_json)),
                  input: { collectionId: page.collections[0]!.collectionId, attempt: 2 },
                }),
              },
            ] as Record<string, string | number | bigint | null>[])
              expect(isOutputCollectionCommand(reader, { ...command, ...change })).toBe(false);
          } finally {
            db.close();
          }
          expect((await f.runtime.queryOutputFiles(scope)).items).toEqual(page.items);
        }
      } finally {
        await f.close();
      }
    },
    15000,
  );
}

nativeTest(
  'settled child output still obeys revoked workspace trust without rerunning its Shell',
  async () => {
    const f = await fixture({
      mode: 'full',
      child: true,
      hostBoundary: true,
      persistentPermissions: true,
      delayCollection: true,
      command: 'printf private > "$KITE_OUTPUT_DIR/report.txt"',
      review: 'ask_user',
    });
    try {
      await f.submit();
      await f.done();
      const sessionId = await until(async () => {
        const carrier = (await f.store.listExecutions('s')).find((row) => row.childSessionId);
        return carrier?.status === 'succeeded' ? carrier.childSessionId! : undefined;
      });
      const trust = await f.permissionManagement.readTrust({ ...f.base, workspaceId: 'w' });
      await f.permissionManagement.setTrust({
        ...f.base,
        workspaceId: 'w',
        commandId: 'revoke-output-trust',
        trusted: false,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      });
      f.releaseCollection();
      const page = await until(async () => {
        const page = await f.runtime.queryOutputFiles({ ...f.base, sessionId });
        return page.collections[0]?.state === 'failed' ? page : undefined;
      });
      expect(page.items).toEqual([]);
      expect(page.collections[0]).toMatchObject({
        state: 'failed',
        errorCode: 'output_collection_permission_denied',
        publishedCount: 0,
      });
      const executions = await f.store.listExecutions(sessionId);
      expect(executions.filter((row) => row.definitionId === 'shell.command')).toHaveLength(1);
      expect(page.collections[0]?.retryUntil).toBeUndefined();
      expect(
        executions.find((row) => row.definitionId === 'builtin.files/collect'),
      ).toBeUndefined();
      const action = executions.find((row) => row.definitionId === 'builtin.files/collect-outputs');
      expect(action).toMatchObject({
        status: 'failed',
        result: {
          outcome: 'failed',
          details: { adapterAttempted: false, code: 'permission_denied' },
        },
      });
      expect((action?.result as { content?: string })?.content).toContain('workspace_untrusted');
      expect(f.a.reviews).toEqual([]);
      // Recreate the historical crash window: a durable denied Action whose
      // collection had not yet been closed. Cold recovery must preserve denial.
      const original = {
        result: action!.result,
        resultRevision: action!.resultRevision,
        status: action!.status,
      };
      await f.runtime.close();
      const db = new Database(f.profile.databasePath);
      try {
        const row = db
          .query<{ json: string }, [string]>('SELECT json FROM extension_record WHERE key=?')
          .get(page.collections[0]!.collectionId)!;
        const c = JSON.parse(row.json);
        c.state = 'pending';
        c.errorCode = null;
        c.retryUntil = null;
        db.run('UPDATE extension_record SET json=? WHERE key=?', JSON.stringify(c), c.id);
      } finally {
        db.close();
      }
      const reopened = await openSqliteStore({
        dataRoot: f.profile.dataRoot,
        profile: f.profile.profile,
      });
      try {
        const owner = await reopened.acquireSessionOwner('s', 'cold-child-output');
        expect(owner).not.toBeNull();
        const after = await reopened.getExecution(action!.id);
        expect({
          result: after!.result,
          resultRevision: after!.resultRevision,
          status: after!.status,
        }).toEqual(original);
        const collection = await reopened.getOutputCollection({
          ...f.base,
          sessionId,
          collectionId: page.collections[0]!.collectionId,
        });
        expect(collection).toMatchObject({
          state: 'failed',
          errorCode: 'output_collection_permission_denied',
          retryUntil: null,
          attempt: 1,
        });
        expect(
          (await reopened.listExecutions(sessionId)).filter(
            (e) => e.definitionId === 'shell.command',
          ),
        ).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const stopChild of [false, true])
  nativeTest(
    `${stopChild ? 'child' : 'root'} Stop includes high-sequence child output; explicit retry archives only the original staging`,
    async () => {
      const f = await fixture({
        mode: 'full',
        child: true,
        hostBoundary: true,
        persistentPermissions: true,
        delayCollection: true,
        childSequenceGap: true,
        command: 'printf stopped > "$KITE_OUTPUT_DIR/report.txt"',
      });
      try {
        await f.submit();
        await f.done();
        const sessionId = await until(async () => {
          const e = (await f.store.listExecutions('s')).find((e) => e.childSessionId);
          return e?.status === 'succeeded' ? e.childSessionId! : undefined;
        });
        const scope = { ...f.base, sessionId };
        const db = new Database(f.profile.databasePath, { readonly: true });
        try {
          const child = db
            .query<{ seq: number }, [string]>(
              "SELECT seq FROM command WHERE session_id=? AND kind='extension.invoke'",
            )
            .get(sessionId)!;
          const root = db
            .query<{ next_seq: number }, []>("SELECT next_seq FROM session WHERE id='s'")
            .get()!;
          expect(child.seq).toBeGreaterThan(root.next_seq);
        } finally {
          db.close();
        }
        const requests = f.a.requests.length;
        const producer = await childProducerSnapshot(f, sessionId);
        await f.runtime.cancelSession({
          ...(stopChild ? scope : f.base),
          commandId: 'stop-child-output',
          includeBackground: true,
        });
        f.releaseCollection();
        const page = await until(async () => {
          const p = await f.runtime.queryOutputFiles(scope);
          return p.collections[0]?.state === 'failed' ? p : undefined;
        });
        expect(page.items).toEqual([]);
        expect(page.collections[0]?.errorCode).toBe('output_collection_cancelled');
        expect(
          (await f.store.listExecutions(sessionId)).some(
            (e) => e.definitionId === 'builtin.files/collect' && e.authorization?.dispatched,
          ),
        ).toBe(false);
        expect(await childProducerSnapshot(f, sessionId)).toEqual(producer);
        if (!stopChild) expect(f.a.requests).toHaveLength(requests);
        await f.runtime.retryOutputCollection({
          ...scope,
          collectionId: page.collections[0]!.collectionId,
          expectedRevision: page.collections[0]!.revision,
        });
        const ready = await until(async () => {
          const p = await f.runtime.queryOutputFiles(scope);
          return p.collections[0]?.state === 'ready' ? p : undefined;
        });
        expect(ready.items).toHaveLength(1);
        if (stopChild) await expectOriginalChildReport(f, sessionId, requests);
        else expect(f.a.requests).toHaveLength(requests);
        expect(await childProducerSnapshot(f, sessionId)).toEqual(producer);
        expect(
          (await f.store.listExecutions(sessionId)).filter(
            (e) => e.definitionId === 'shell.command',
          ),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
    15000,
  );

nativeTest(
  'two live children keep same-named Shell deliveries in distinct source sessions',
  async () => {
    const f = await fixture({
      mode: 'full',
      child: true,
      childCount: 2,
      hostBoundary: true,
      persistentPermissions: true,
      review: 'ask_user',
      command: 'sleep 0.1; printf "%s" "$$" > "$KITE_OUTPUT_DIR/report.txt"',
    });
    try {
      await f.submit();
      await f.done();
      const carriers = await until(async () => {
        const rows = (await f.store.listExecutions('s')).filter((e) => e.childSessionId);
        return rows.length === 2 && rows.every((e) => e.status === 'succeeded') ? rows : undefined;
      });
      const targets = [],
        values = [];
      for (const carrier of carriers) {
        const scope = { ...f.base, sessionId: carrier.childSessionId! };
        const page = await until(async () => {
          const page = await f.runtime.queryOutputFiles(scope);
          return page.items.length === 1 && page.collections[0]?.state === 'ready'
            ? page
            : undefined;
        });
        const target = page.items[0]!;
        targets.push(target);
        const record = await f.runtime.resolveOutputFile({ ...scope, target });
        const bytes = await f.runtime.readArtifact({
          ...scope,
          refId: record.reference.id,
          scope: record.reference.scope,
        });
        values.push(new TextDecoder().decode(bytes.content));
        expect(target.name).toBe('report.txt');
        expect(
          (await f.store.listExecutions(scope.sessionId)).filter(
            (e) => e.definitionId === 'shell.command',
          ),
        ).toHaveLength(1);
      }
      expect(targets[0]!.fileId).not.toBe(targets[1]!.fileId);
      expect(targets[0]!.sessionId).not.toBe(targets[1]!.sessionId);
      expect(values[0]).not.toBe(values[1]);
      expect((await f.runtime.queryOutputFiles(f.base)).items).toEqual([]);
      expect(f.a.reviews).toEqual([]);
    } finally {
      await f.close();
    }
  },
  15000,
);

nativeTest(
  'failed child collection retries its exact staging after child completion without rerunning Shell',
  async () => {
    const f = await fixture({
      mode: 'full',
      child: true,
      hostBoundary: true,
      persistentPermissions: true,
      command: 'ln -s "$PWD/source.txt" "$KITE_OUTPUT_DIR/report.txt"',
    });
    try {
      writeFileSync(join(f.workspace, 'source.txt'), 'outside-not-collected');
      await f.submit();
      await f.done();
      const sessionId = await until(async () => {
        const e = (await f.store.listExecutions('s')).find((e) => e.childSessionId);
        return e?.status === 'succeeded' ? e.childSessionId! : undefined;
      });
      const scope = { ...f.base, sessionId };
      const failed = await until(async () => {
        const p = await f.runtime.queryOutputFiles(scope);
        return p.collections[0]?.state === 'failed' ? p : undefined;
      });
      expect(failed.items).toEqual([]);
      expect(failed.collections[0]?.errorCode).toBe('output_file_unsafe');
      const c = await f.store.getOutputCollection({
        ...scope,
        collectionId: failed.collections[0]!.collectionId,
      });
      const path = join(c!.allocation.outputIdentity.canonical, 'report.txt');
      rmSync(path);
      writeFileSync(path, 'recovered-exact-staging');
      const requests = f.a.requests.length;
      const producer = await childProducerSnapshot(f, sessionId);
      await f.runtime.retryOutputCollection({
        ...scope,
        collectionId: c!.id,
        expectedRevision: failed.collections[0]!.revision,
      });
      const ready = await until(async () => {
        const p = await f.runtime.queryOutputFiles(scope);
        return p.collections[0]?.state === 'ready' ? p : undefined;
      });
      const record = await f.runtime.resolveOutputFile({ ...scope, target: ready.items[0]! });
      const bytes = await f.runtime.readArtifact({
        ...scope,
        refId: record.reference.id,
        scope: record.reference.scope,
      });
      expect(new TextDecoder().decode(bytes.content)).toBe('recovered-exact-staging');
      await expectOriginalChildReport(f, sessionId, requests);
      expect(await childProducerSnapshot(f, sessionId)).toEqual(producer);
      expect(
        (await f.store.listExecutions(sessionId)).filter((e) => e.definitionId === 'shell.command'),
      ).toHaveLength(1);
      expect((await f.store.getOutputCollection({ ...scope, collectionId: c!.id }))?.attempt).toBe(
        2,
      );
    } finally {
      await f.close();
    }
  },
  15000,
);

for (const cancelled of [false, true])
  nativeTest(
    `cold root owner ${cancelled ? 'preserves cancelled' : 'dispatches pending'} child collection without model or Shell replay`,
    async () => {
      const f = await fixture({
        mode: 'full',
        child: true,
        hostBoundary: true,
        persistentPermissions: true,
        command: 'ln -s "$PWD/source.txt" "$KITE_OUTPUT_DIR/report.txt"',
      });
      let reopened: ReturnType<typeof createRuntime> | undefined;
      let artifacts: ReturnType<typeof createArtifactStore> | undefined;
      try {
        writeFileSync(join(f.workspace, 'source.txt'), 'not-collected');
        await f.submit();
        await f.done();
        const sessionId = await until(async () => {
          const e = (await f.store.listExecutions('s')).find((e) => e.childSessionId);
          return e?.status === 'succeeded' ? e.childSessionId! : undefined;
        });
        const scope = { ...f.base, sessionId };
        const failed = await until(async () => {
          const p = await f.runtime.queryOutputFiles(scope);
          return p.collections[0]?.state === 'failed' ? p : undefined;
        });
        const c = await f.store.getOutputCollection({
          ...scope,
          collectionId: failed.collections[0]!.collectionId,
        });
        const path = join(c!.allocation.outputIdentity.canonical, 'report.txt');
        rmSync(path);
        writeFileSync(path, 'cold-exact-staging');
        const requests = f.a.requests.length;
        await f.runtime.close();
        const db = new Database(f.profile.databasePath);
        try {
          const pending = { ...c!, state: 'pending', errorCode: null, retryUntil: null };
          db.run('UPDATE extension_record SET json=? WHERE key=?', [
            JSON.stringify(pending),
            c!.id,
          ]);
          db.run("UPDATE execution SET state='running',cancel_requested=? WHERE id=?", [
            cancelled ? 1 : 0,
            c!.collectorExecutionId!,
          ]);
        } finally {
          db.close();
        }
        const reader = await openSqliteStore({
          dataRoot: f.profile.dataRoot,
          profile: f.profile.profile,
          mode: 'readonly',
        });
        try {
          const before = await reader.getMetadata();
          expect(
            (await reader.getOutputCollection({ ...scope, collectionId: c!.id }))?.attempt,
          ).toBe(1);
          await reader.queryOutputFiles(scope);
          expect(await reader.getMetadata()).toEqual(before);
        } finally {
          await reader.close();
        }
        const store = await openSqliteStore({
          dataRoot: f.profile.dataRoot,
          profile: f.profile.profile,
        });
        artifacts = createArtifactStore({ profile: f.profile, store });
        const host = f.createHost();
        reopened = createRuntime({
          ...host,
          store,
          artifacts,
          permissions: host.permissions!,
          extensions: [
            ...host.extensions!,
            {
              id: 'fixture.cold-trigger',
              version: '1',
              apiMajor: 1,
              actions: [
                {
                  id: 'wake',
                  version: '1',
                  description: 'No-effect owned dispatch fixture',
                  inputSchema: { type: 'object' },
                  async prepare(input) {
                    return input;
                  },
                  async execute() {
                    return { outcome: 'succeeded' as const, content: 'no effect' };
                  },
                },
              ],
            },
          ],
        });
        host.permissionManagement!(reopened);
        // An explicit root dispatch acquires the physical owner. This deliberately
        // unknown Action is rejected; it cannot run a model or act as a collector.
        await reopened.submitCommand({
          ...f.base,
          commandId: 'cold-root-dispatch',
          request: {
            kind: 'extension.invoke',
            extensionId: 'fixture.cold-trigger',
            actionId: 'wake',
            definitionVersion: '1',
            input: {},
          },
        });
        await reopened.waitForCommand('cold-root-dispatch', { timeoutMs: 5000 });
        const page = await until(async () => {
          const p = await reopened!.queryOutputFiles(scope);
          return p.collections[0]?.state === (cancelled ? 'failed' : 'ready') ? p : undefined;
        });
        expect(page.items).toHaveLength(cancelled ? 0 : 1);
        expect((await store.getOutputCollection({ ...scope, collectionId: c!.id }))?.attempt).toBe(
          cancelled ? 1 : 2,
        );
        expect(
          (await store.listExecutions(sessionId)).filter((e) => e.definitionId === 'shell.command'),
        ).toHaveLength(1);
        expect(f.a.requests).toHaveLength(requests);
        await until(async () => (reopened!.getLifecycleState().busy ? undefined : true));
        const owner = await store.acquireSessionOwner('s', 'post-cold-probe');
        expect(owner).not.toBeNull();
        if (owner) expect(await store.releaseSessionOwner(owner)).toBe(true);
      } finally {
        await reopened?.close();
        await artifacts?.close();
        await f.close();
      }
    },
    15000,
  );

for (const mode of ['full', 'accept_edits', 'auto'] as const)
  nativeTest(
    `explicit workdir selects the actual supervised process directory and leaves Session cwd fixed: ${mode}`,
    async () => {
      const f = await fixture({ mode, hostBoundary: true, review: 'approve_once' });
      const nested = join(f.workspace, 'nested'),
        outside = join(f.root, 'outside');
      mkdirSync(nested);
      mkdirSync(outside);
      const observations: { executionId: string; definitionId: string; policy: unknown }[] = [];
      async function perform(id: string) {
        await f.submit(id);
        let done = false;
        const terminal = f.done(id).finally(() => {
          done = true;
        });
        while (!done) {
          const cards = (await f.store.listInteractions({ ...f.base, state: 'pending' }))
            .interactions;
          for (const card of cards) {
            expect(observations.some((previous) => previous.executionId === card.executionId)).toBe(
              false,
            );
            observations.push({
              executionId: card.executionId,
              definitionId: card.definitionId,
              policy: card.request,
            });
            await f.runtime.answerInteraction({
              ...f.base,
              presentationSessionId: 's',
              commandId: `answer-${card.id}`,
              interactionId: card.id,
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
            });
          }
          if (!done) await Bun.sleep(5);
        }
        await terminal;
        const rows = await f.store.listExecutions('s');
        const job = rows.filter((row) => row.definitionId === 'shell.command').at(-1)!;
        expect(job.status).toBe('succeeded');
        return job;
      }
      try {
        f.a.workdir('nested');
        f.a.command('printf once >> marker; pwd');
        const first = await perform('work');
        expect(readFileSync(join(nested, 'marker'), 'utf8')).toBe('once');
        expect(existsSync(join(f.workspace, 'marker'))).toBe(false);
        expect(first.input).toMatchObject({ workdir: 'nested' });
        f.a.workdir(outside);
        f.a.permissions({ filesystem: 'full_access', network: 'none' });
        await perform('grant-outside');
        expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('once');
        f.a.workdir(undefined);
        f.a.permissions(undefined);
        f.a.command('pwd');
        const last = await perform('next');
        const output = await f.store.listExecutionOutput({ ...f.base, executionId: last.id });
        expect(output.items.map((item) => item.content).join('')).toContain(f.workspace);
        expect(last.input).not.toHaveProperty('workdir');
        expect((await f.runtime.getWorkspace('w'))?.rootUri).toBe(pathToFileURL(f.workspace).href);
        expect(
          (await f.store.listInteractions({ ...f.base, state: 'pending' })).interactions,
        ).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
    30000,
  );
nativeTest(
  'an invalid optional Codex path does not block an ordinary manual Provider Run or its actual Host Shell',
  async () => {
    for (const codexHome of ['relative', 'empty', 'nul'] as const) {
      const f = await fixture({
        hostBoundary: true,
        codexHome,
        command: 'printf manual-provider-shell > effect',
      });
      try {
        await f.submit();
        expect((await f.done()).status).toBe('applied');
        expect((await f.store.getView('s')).runs.at(-1)?.status).toBe('completed');
        expect(
          (await f.store.listExecutions('s')).find((row) => row.definitionId === 'shell.command'),
        ).toMatchObject({ status: 'succeeded', result: { details: { processTreeStopped: true } } });
        expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('manual-provider-shell');
        expect(existsSync(f.codexHome)).toBe(false);
      } finally {
        await f.close();
      }
    }
  },
  20000,
);
nativeTest(
  'default Full Host Shell can read and write a synthetic Codex file after its absent Home appears',
  async () => {
    const f = await fixture({
      hostBoundary: true,
      codexHome: 'missing',
      command: 'printf ordinary',
    });
    try {
      await f.submit('work');
      const first = await f.done('work');
      expect(first.status).toBe('applied');
      expect(await f.runtime.getRun((first.receipt as { runId: string }).runId)).toMatchObject({
        status: 'completed',
        reason: null,
      });
      privateDirectory(f.codexHome);
      const auth = join(f.codexHome, 'auth.json');
      writeFileSync(auth, 'SYNTHETIC_PRIVATE_AUTH_MATERIAL', { mode: 0o600 });
      f.a.command(
        `if /bin/cat '${auth}' 2>/dev/null; then printf leaked; else printf read-denied; fi; if (printf stolen > '${auth}') 2>/dev/null; then printf wrote; else printf write-denied; fi; printf ordinary`,
      );
      await f.submit('next');
      const next = await f.done('next');
      expect(next.status).toBe('applied');
      expect(await f.runtime.getRun((next.receipt as { runId: string }).runId)).toMatchObject({
        status: 'completed',
        reason: null,
      });
      const executions = await f.store.listExecutions('s');
      expect(executions.filter((execution) => execution.kind === 'model').length).toBeGreaterThan(
        1,
      );
      const jobs = executions.filter((execution) => execution.definitionId === 'shell.command');
      expect(jobs).toHaveLength(2);
      expect(jobs.map((execution) => execution.status)).toEqual(['succeeded', 'succeeded']);
      const output = await f.store.listExecutionOutput({
        executionId: jobs[1]!.id,
        afterSeq: '0',
        limit: 200,
      });
      expect(
        output.items
          .filter((row) => row.stream === 'stdout')
          .map((row) => row.content)
          .join(''),
      ).toBe('SYNTHETIC_PRIVATE_AUTH_MATERIALleakedwroteordinary');
      expect(readFileSync(auth, 'utf8')).toBe('stolen');
    } finally {
      await f.close();
    }
  },
  30000,
);
nativeTest(
  'default delegated Shell preserves accepted parent/child policy snapshots for Full and Auto human fallback',
  async () => {
    const f = await fixture({
      hostBoundary: true,
      persistentPermissions: true,
      child: true,
      review: 'ask_user',
    });
    const outside = join(f.root, 'child-outside-effect');
    const dispatch = f.store.markDispatching.bind(f.store);
    const snapshots: unknown[] = [];
    f.store.markDispatching = async (input) => {
      const result = await dispatch(input);
      if ((await f.store.getExecution(input.executionId))?.definitionId === 'shell.command')
        snapshots.push(structuredClone(input.authorization.snapshot));
      return result;
    };
    const setMode = async (mode: 'full' | 'auto', commandId: string) => {
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
          .filter((row) => row.childSessionId && row.definitionId === 'agent/general')
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
      await setMode('auto', 'child-auto');
      f.a.command(`printf denied > '${outside}'; printf ask >> effect`);
      await f.submit('grant-child');
      // Unchanged finite default roles create only internal records; their
      // real Shell effects still require their own Auto fallback decisions.
      const pending = await until(async () => {
        for (const session of await f.store.listSessions()) {
          const cards = (
            await f.store.listInteractions({ ...f.base, sessionId: session.id, state: 'pending' })
          ).interactions;
          if (cards.length) return cards;
        }
        return undefined;
      });
      expect(pending.map((card) => card.definitionId)).toEqual(['shell.execute']);
      expect(pending[0]!.presentationSessionId).toBe('s');
      expect((await f.store.getExecution(pending[0]!.executionId))?.sessionId).not.toBe('s');
      expect(
        (await f.store.listExecutions('s')).filter(
          (row) =>
            row.rootWorkCommandId === 'grant-child' &&
            ['task.spawn', 'agent/general'].includes(row.definitionId),
        ),
      ).toEqual([
        expect.objectContaining({
          definitionId: 'task.spawn',
          authorization: { dispatched: true },
        }),
        expect.objectContaining({
          definitionId: 'agent/general',
          authorization: { dispatched: true },
        }),
      ]);
      await f.approve('shell.execute', 'child-approve-launch');
      expect((await f.done('grant-child')).status).toBe('applied');
      expect(await childJob()).toMatchObject({
        status: 'succeeded',
        authorization: { policy: { reason: 'parent_review' } },
        result: { details: { processTreeStopped: true } },
      });
      expect(f.a.reviews).toHaveLength(1);
      expect(readFileSync(outside, 'utf8')).toBe('full');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('fullask');
      expect(snapshots.map(permissionSnapshot)).toEqual(
        ['full', 'auto'].map((mode) => {
          const leaf = expect.objectContaining({
            namespace: 'builtin.permissions',
            version: '1',
            data: expect.objectContaining({ mode, workspaceTrust: true }),
          });
          const intersection = (parent: unknown, child: unknown) => ({
            namespace: 'agent.permission-intersection',
            version: '1',
            data: {
              policies: [
                expect.objectContaining({
                  scope: 'parent',
                  allowed: mode === 'full',
                  snapshot: parent,
                }),
                expect.objectContaining({
                  scope: 'child',
                  allowed: mode === 'full',
                  snapshot: child,
                }),
              ],
            },
          });
          return intersection(intersection(leaf, leaf), leaf);
        }),
      );
      await until(async () => {
        const view = await f.store.getView('s');
        const carrier = view.executions.find(
          (execution) =>
            execution.definitionId === 'agent/general' &&
            execution.rootWorkCommandId === 'grant-child',
        );
        if (carrier?.status !== 'succeeded' || view.runs.some((run) => run.isActive))
          return undefined;
        const childRows = await f.store.listExecutions(carrier.childSessionId!);
        if (childRows.some((row) => ['planned', 'dispatching', 'running'].includes(row.status)))
          return undefined;
        // A settled carrier can still be publishing the receipt for its deferred mailbox report.
        const { items } = await f.store.listAgentMessages(f.base);
        const mail = items.find(
          (item) =>
            item.kind === 'result' &&
            item.result.executionId === carrier.id &&
            item.result.resultRevision === carrier.resultRevision,
        );
        const report = mail && (await f.store.getCommand(mail.id));
        const receipt = report?.receipt as { outcome?: string } | undefined;
        return report &&
          (report.status !== 'accepted' || receipt?.outcome === 'report_deferred') &&
          !f.runtime.getLifecycleState().busy
          ? true
          : undefined;
      });
      const requests = f.a.requests.length;
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      const original = (await f.store.getCommand('grant-child'))!;
      expect(await f.submit('grant-child')).toEqual(original);
      await f.runtime.getView('s');
      expect(f.a.requests).toHaveLength(requests);
      const observed = await f.store.getChanges({ after: cursor });
      expect({ cursor: observed.metadata.lastChangeCursor, changes: observed.events }).toEqual({
        cursor,
        changes: [],
      });
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
    let acceptedCommandDigest: string | undefined;
    const leaf = (mode: 'full' | 'accept_edits') => ({
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
          ...(acceptedCommandDigest ? { commandDigest: acceptedCommandDigest } : {}),
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
        toolIds: ['shell.execute'],
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
      const command = `printf denied > '${outside}'; printf workspace > effect`;
      acceptedCommandDigest = await configuration.commandDigest({
        kind: 'job',
        sessionId: 'adapter-test',
        runId: null,
        executionId: 'owned-nested',
        definitionId: 'shell.command',
        definitionVersion: '1',
        input: { command },
        signal: new AbortController().signal,
      });
      const job = configuration.extensions[0]!.jobs![0]!;
      const context: JobContext = {
        sessionId: 'adapter-test',
        executionId: 'owned-nested',
        signal: new AbortController().signal,
        dispatchAuthorization: {
          revision: 'owned-final-acceptance',
          snapshot: intersect([intersect([leaf('full')]), leaf('accept_edits')]),
        },
      };
      const handle = await job.start({ command }, context);
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
        ).rejects.toThrow('shell_dispatch_scope_unavailable');
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
      review: 'ask_user',
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
    const setMode = async (mode: 'full' | 'auto', commandId: string) => {
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
      await setMode('auto', 'host-auto');
      f.a.command(`printf denied > '${outside}'; printf workspace >> effect`);
      await f.submit('grant-workspace');
      await f.approve('shell.execute', 'host-approve-tool');
      await f.done('grant-workspace');
      const job = await finishedJob();
      expect(job).toMatchObject({
        status: 'succeeded',
        authorization: { policy: { reason: 'parent_review' } },
        result: { details: { processTreeStopped: true } },
      });
      expect(f.a.reviews).toHaveLength(1);
      expect(readFileSync(outside, 'utf8')).toBe('full');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('workspace');
      expect(snapshots.map(permissionSnapshot)).toEqual([
        expect.objectContaining({
          namespace: 'builtin.permissions',
          version: '1',
          data: expect.objectContaining({ mode: 'full', workspaceTrust: true }),
        }),
        expect.objectContaining({
          namespace: 'builtin.permissions',
          version: '1',
          data: expect.objectContaining({ mode: 'auto', workspaceTrust: true }),
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
      expect(executions.filter((row) => row.definitionId === 'shell.execute')).toEqual([
        expect.objectContaining({ status: 'succeeded' }),
      ]);
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
        details: {
          has_more: false,
          terminal: true,
          ref: { executionId: job.id },
          execution: { id: job.id, status: 'succeeded' },
        },
      });
      await until(async () => (f.runtime.getLifecycleState().busy ? undefined : true));
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
  'macOS workspace writes keep the selected root when Shell starts in a nested directory',
  async () => {
    const f = await fixture({
      mode: 'accept_edits',
      persistentPermissions: true,
      hostBoundary: true,
      command:
        'pwd && printf root-owned > ../workspace-effect.txt && printf exported > "$KITE_OUTPUT_DIR/nested.txt"',
    });
    try {
      const cwd = join(f.workspace, 'nested');
      mkdirSync(cwd);
      f.a.workdir('nested');
      await f.submit();
      expect((await f.done()).status).toBe('applied');
      const jobs = (await f.store.listExecutions('s')).filter(
        (row) => row.definitionId === 'shell.command',
      );
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      const effect = join(f.workspace, 'workspace-effect.txt');
      expect({
        status: job.status,
        dispatched: job.authorization?.dispatched,
        result: job.result,
        effect: existsSync(effect) ? readFileSync(effect, 'utf8') : null,
      }).toMatchObject({
        status: 'succeeded',
        dispatched: true,
        result: { details: { exitCode: 0, processTreeStopped: true } },
        effect: 'root-owned',
      });
      const output = await f.store.listExecutionOutput({
        executionId: job.id,
        afterSeq: '0',
        limit: 200,
      });
      expect(
        output.items
          .filter((row) => row.stream === 'stdout')
          .map((row) => row.content)
          .join('')
          .trim(),
      ).toBe(cwd);
      const target = await until(async () =>
        (await f.runtime.queryOutputFiles(f.base)).items.find((item) => item.name === 'nested.txt'),
      );
      const record = await f.runtime.resolveOutputFile({ ...f.base, target });
      expect(record.sourceExecutionId).toBe(job.id);
      const artifact = await f.runtime.readArtifact({
        ...f.base,
        refId: record.reference.id,
        scope: record.reference.scope,
      });
      expect(new TextDecoder().decode(artifact.content)).toBe('exported');
      expect(f.a.reviews).toEqual([]);
      expect((await f.store.getView('s')).runs[0]).toMatchObject({ status: 'completed' });
    } finally {
      await f.close();
    }
  },
  15000,
);
nativeTest(
  'read-only task children use ordinary mode review for cat and compound Shell reads',
  async () => {
    for (const mode of ['accept_edits', 'auto', 'full'] as const) {
      const f = await fixture({
        mode,
        hostBoundary: true,
        persistentPermissions: true,
        child: true,
        childPreset: 'explore',
        review: 'approve_once',
      });
      try {
        writeFileSync(join(f.workspace, 'input.txt'), 'owned-inspection\n');
        f.a.command('cat input.txt && pwd');
        await f.submit();
        await f.done();
        const carrier = await until(async () => {
          const child = (await f.store.listExecutions('s')).find(
            (row) => row.definitionId === 'agent/explore',
          );
          return child?.childSessionId && child.status === 'succeeded' ? child : undefined;
        });
        const executions = await f.store.listExecutions(carrier.childSessionId!);
        expect(executions.find((row) => row.definitionId === 'shell.execute')).toMatchObject({
          status: 'succeeded',
          authorization: { dispatched: true },
        });
        const jobs = executions.filter((row) => row.definitionId === 'shell.command');
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          status: 'succeeded',
          authorization: { dispatched: true },
          result: { details: { processTreeStopped: true } },
        });
        expect(JSON.stringify(f.a.requests)).toContain('owned-inspection');
        expect(f.a.reviews).toHaveLength(mode === 'auto' ? 1 : 0);
        if (mode === 'auto') expect(jobs[0]?.authorization?.policy?.reason).toBe('parent_review');
        if (mode === 'auto') {
          expect(JSON.stringify(f.a.reviews)).toContain('cat input.txt && pwd');
          expect(JSON.stringify(f.a.reviews)).not.toContain(
            'Inspect source read-only. Do not modify files.',
          );
          expect(JSON.stringify(f.a.requests)).toContain(
            'Inspect source read-only. Do not modify files.',
          );
        }
        expect(
          (
            await f.store.listInteractions({
              ...f.base,
              sessionId: carrier.childSessionId!,
              state: 'pending',
            })
          ).interactions,
        ).toHaveLength(0);
      } finally {
        await f.close();
      }
    }
  },
  20000,
);
nativeTest(
  'read-only task children retain ordinary approved scopes; Auto can reject actual writes',
  async () => {
    for (const mode of ['accept_edits', 'auto', 'full'] as const) {
      const f = await fixture({
        mode,
        hostBoundary: true,
        persistentPermissions: true,
        child: true,
        childPreset: 'explore',
        review: 'reject',
      });
      try {
        const outside = join(f.root, 'outside-role-effect');
        const originalConfig = readFileSync(f.configPath, 'utf8');
        f.a.command(
          `printf role-effect > role-write.txt; printf outside > '${outside}'; printf '\\n' >> '${f.configPath}'; printf scope-probe-done`,
        );
        await f.submit();
        await f.done();
        const carrier = await until(async () => {
          const child = (await f.store.listExecutions('s')).find(
            (row) => row.definitionId === 'agent/explore',
          );
          return child?.childSessionId && child.status === 'succeeded' ? child : undefined;
        });
        const executions = await f.store.listExecutions(carrier.childSessionId!);
        const launch = executions.find((row) => row.definitionId === 'shell.execute');
        const jobs = executions.filter((row) => row.definitionId === 'shell.command');
        expect(readFileSync(f.configPath, 'utf8')).toBe(
          mode === 'full' ? `${originalConfig}\n` : originalConfig,
        );
        expect(f.a.reviews).toHaveLength(mode === 'auto' ? 1 : 0);
        if (mode === 'auto') {
          expect(launch).toMatchObject({
            status: 'failed',
            result: { details: { reason: 'scope rejected by reviewer' } },
            authorization: {
              dispatched: false,
              check: { decision: 'reject', reason: 'scope rejected by reviewer' },
            },
          });
          expect(jobs).toHaveLength(0);
          expect(existsSync(join(f.workspace, 'role-write.txt'))).toBe(false);
          expect(existsSync(outside)).toBe(false);
          const review = JSON.stringify(f.a.reviews);
          expect(review).not.toContain('Inspect source read-only. Do not modify files.');
          expect(review).toContain('printf role-effect > role-write.txt');
          expect(JSON.stringify(f.a.requests)).toContain('scope rejected by reviewer');
        } else {
          // A controlled adapter deliberately violates its read-only assignment.
          // This tests ordinary policy/sandbox limits, not model compliance.
          expect(launch).toMatchObject({
            status: 'succeeded',
            authorization: { dispatched: true },
          });
          expect(jobs).toHaveLength(1);
          expect(jobs[0]).toMatchObject({
            status: 'succeeded',
            result: { details: { processTreeStopped: true } },
          });
          expect(readFileSync(join(f.workspace, 'role-write.txt'), 'utf8')).toBe('role-effect');
          expect(existsSync(outside)).toBe(mode === 'full');
          if (mode === 'full') expect(readFileSync(outside, 'utf8')).toBe('outside');
        }
        expect(
          (
            await f.store.listInteractions({
              ...f.base,
              sessionId: carrier.childSessionId!,
              state: 'pending',
            })
          ).interactions,
        ).toHaveLength(0);
      } finally {
        await f.close();
      }
    }
  },
  20000,
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
      const digest = await first.commandDigest(original);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await first.commandDigest({
          ...original,
          executionId: 'other',
          input: { key: 'second', command: 'printf original', cancellation: 'attached' },
        }),
      ).toBe(digest);
      expect(
        await first.commandDigest({
          ...original,
          input: { key: 'second', command: 'printf changed' },
        }),
      ).not.toBe(digest);
      expect(
        await first.commandDigest({
          ...original,
          input: { key: 'second', command: 'printf original', cancellation: 'detached' },
        }),
      ).not.toBe(digest);
      const foreground: AuthorizationRequest = { ...original, definitionId: 'shell.execute' };
      const withoutDeadline = await first.commandDigest(foreground);
      expect(withoutDeadline).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await first.commandDigest({
          ...foreground,
          input: { key: 'second', command: 'printf original', cancellation: 'attached' },
        }),
      ).toBe(withoutDeadline);
      const tenMinutes = await first.commandDigest({
        ...foreground,
        input: { key: 'first', command: 'printf original', timeoutMs: 600000 },
      });
      expect(tenMinutes).toMatch(/^[a-f0-9]{64}$/);
      expect(tenMinutes).not.toBe(withoutDeadline);
      expect(
        await first.commandDigest({
          ...foreground,
          input: { key: 'second', command: 'printf original', timeoutMs: 600000 },
        }),
      ).toBe(tenMinutes);
      expect(
        await first.commandDigest({
          ...foreground,
          input: { key: 'second', command: 'printf original', timeoutMs: 1000 },
        }),
      ).not.toBe(tenMinutes);
      for (const definitionId of ['shell.execute', 'shell.launch', 'shell.command']) {
        expect(
          await first.describeRequest({ ...original, kind: 'model', definitionId, input: {} }),
        ).toBeUndefined();
      }
      expect(await first.describeRequest({ ...foreground, input: { key: 'invalid' } })).toEqual({
        hardAllowed: false,
        denialReason: 'invalid_shell_arguments',
      });
      expect(
        await first.describeRequest({ ...foreground, definitionVersion: '2' }),
      ).toBeUndefined();
      const explicitDefaults = await createShellConfiguration({
        ...configuration,
        options: {
          ...options,
          env: { PATH: '/usr/bin:/bin', FIXED: 'original' },
          graceMs: 200,
          maxQueuedBytes: 256 * 1024,
        },
      });
      expect(await explicitDefaults.commandDigest(original)).toBe(digest);
      options.env.FIXED = 'changed';
      expect(await first.commandDigest(original)).toBe(digest);
      const changedEnv = await createShellConfiguration(configuration);
      expect(await changedEnv.commandDigest(original)).not.toBe(digest);
      const otherWorkspace = join(f.root, 'other');
      mkdirSync(otherWorkspace);
      const changedWorkspace = await createShellConfiguration({
        ...configuration,
        workspaceRoot: otherWorkspace,
      });
      expect(await changedWorkspace.commandDigest(original)).not.toBe(
        await changedEnv.commandDigest(original),
      );
      expect(await first.commandDigest({ ...original, definitionVersion: '2' })).toBeUndefined();
      expect(
        await first.commandDigest({
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
const oneShotShellCommand = 'printf once >> effect';
const workspaceOutsideScope = { filesystem: 'full_access', network: 'none' } as const;

async function originalShellWork(f: Awaited<ReturnType<typeof fixture>>, commandId: string) {
  const start = (await f.store.getCommand(commandId))!;
  const runId = (start.receipt as { runId: string }).runId;
  expect(runId).toBeTruthy();
  const executions = await f.store.listExecutions('s');
  const tool = executions.find(
    (row) => row.runId === runId && row.definitionId === 'shell.execute',
  );
  expect(tool).toBeDefined();
  const interactions = (await f.store.listInteractions(f.base)).interactions;
  const jobs = executions.filter(
    (row) => row.parentExecutionId === tool!.id && row.definitionId === 'shell.command',
  );
  return {
    tool: tool!,
    jobs,
    cards: interactions.filter(
      (row) => row.executionId === tool!.id || jobs.some((job) => job.id === row.executionId),
    ),
  };
}

async function originalShellSettlement(f: Awaited<ReturnType<typeof fixture>>, commandId: string) {
  return until(async () => {
    const booked = await f.store.getCommand(commandId);
    if (!booked || booked.status === 'accepted') return;
    expect(booked.status).toBe('applied');
    const runId = (booked.receipt as { runId: string }).runId;
    if (
      !(await f.store.listExecutions('s')).some(
        (row) => row.runId === runId && row.definitionId === 'shell.execute',
      )
    )
      return;
    const work = await originalShellWork(f, commandId);
    // Fail immediately on the regression, instead of eventually timing out on a pending Job.
    expect(work.cards.filter((row) => row.definitionId === 'shell.command')).toHaveLength(0);
    const run = (await f.store.getView('s')).runs.find((row) => row.id === runId);
    return run?.status === 'completed' ? work : undefined;
  });
}

function expectParentShellDispatch(
  work: Awaited<ReturnType<typeof originalShellWork>>,
  scope: RequestedScope,
) {
  expect(work.tool.status).toBe('succeeded');
  expect(work.jobs).toHaveLength(1);
  expect(work.jobs[0]).toMatchObject({
    kind: 'job',
    definitionId: 'shell.command',
    parentExecutionId: work.tool.id,
    interactionBinding: null,
    status: 'succeeded',
    authorization: {
      dispatched: true,
      policy: {
        evidenceId: expect.any(String),
        reason: 'parent_review',
        sourceExecutionId: work.tool.id,
        requestedScope: scope,
        effectiveScope: scope,
      },
    },
    result: { details: { processTreeStopped: true } },
  });
  expect(work.jobs[0]?.authorization?.human).toBeUndefined();
}

nativeTest(
  'Shell approval E2E: one exact once choice dispatches one Job; a new identical command still asks',
  async () => {
    const f = await fixture({
      persistentPermissions: true,
      hostBoundary: true,
      command: oneShotShellCommand,
    });
    f.a.permissions(workspaceOutsideScope);
    const effect = join(f.workspace, 'effect');
    try {
      await f.submit();
      const card = await f.card('shell.execute');
      const held = await originalShellWork(f, 'work');
      expect(held.tool).toMatchObject({
        id: card.executionId,
        status: 'planned',
        input: { command: oneShotShellCommand, ...workspaceOutsideScope },
        authorization: { dispatched: false },
      });
      expect(held.cards.map((row) => row.id)).toEqual([card.id]);
      expect(held.jobs).toHaveLength(0);
      expect(existsSync(effect)).toBe(false);

      await f.approve('shell.execute', 'approve-tool');
      const accepted = await originalShellSettlement(f, 'work');
      expectParentShellDispatch(accepted, workspaceOutsideScope);
      expect(accepted.cards.map((row) => row.id)).toEqual([card.id]);
      expect(accepted.cards[0]).toMatchObject({
        state: 'answered',
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
        acceptedDecisionRevision: expect.any(String),
      });
      expect(accepted.tool.authorization?.human).toMatchObject({
        interactionId: card.id,
        accepted: true,
        optionKind: 'once',
      });
      expect(readFileSync(effect, 'utf8')).toBe('once');

      await f.submit('grant-once-repeat');
      const again = await f.card('shell.execute');
      expect(again.id).not.toBe(card.id);
      expect(again.inputDigest).toBe(card.inputDigest);
      const retry = await originalShellWork(f, 'grant-once-repeat');
      expect(retry.tool.authorization?.dispatched).toBe(false);
      expect(retry.jobs).toHaveLength(0);
      expect(readFileSync(effect, 'utf8')).toBe('once');
      await f.runtime.answerInteraction({
        ...f.base,
        presentationSessionId: 's',
        commandId: 'deny-next-identical',
        interactionId: again.id,
        expectedRevision: again.revision,
        answer: { kind: 'approval', decision: 'deny' },
      });
      const denied = await originalShellSettlement(f, 'grant-once-repeat');
      expect(denied.cards.map((row) => row.id)).toEqual([again.id]);
      expect(denied.tool).toMatchObject({
        status: 'failed',
        authorization: { dispatched: false, human: { decision: 'deny' } },
        result: { details: { code: 'approval_denied' } },
      });
      expect(denied.jobs).toHaveLength(0);
      expect(readFileSync(effect, 'utf8')).toBe('once');
    } finally {
      await f.close();
    }
  },
  25000,
);
nativeTest(
  'Shell approval E2E: one scoped choice covers its exact Job and is reused; changed Shell requests still ask',
  async () => {
    const f = await fixture({
      persistentPermissions: true,
      hostBoundary: true,
      command: oneShotShellCommand,
    });
    f.a.permissions(workspaceOutsideScope);
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
      f.a.description('Inspect initial workspace state');
      await f.submit('grant-first');
      const tool = await f.card('shell.execute');
      expect(tool.request).toMatchObject({ options: [{ kind: 'once' }, { kind: 'scope' }] });
      const optionId = fixtureScopeOption(tool.request);
      const beforeApproval = await originalShellWork(f, 'grant-first');
      expect(beforeApproval.tool).toMatchObject({
        status: 'planned',
        authorization: { dispatched: false },
      });
      expect(beforeApproval.jobs).toHaveLength(0);
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      await client.answerInteraction('s', tool.id, {
        expectedStoreId: f.base.expectedStoreId,
        commandId: 'grant-tool',
        expectedRevision: tool.revision,
        answer: { kind: 'approval', decision: 'approve', optionId },
      });
      const accepted = await originalShellSettlement(f, 'grant-first');
      expectParentShellDispatch(accepted, workspaceOutsideScope);
      expect(accepted.cards.map((row) => row.id)).toEqual([tool.id]);
      expect(accepted.cards[0]).toMatchObject({
        state: 'answered',
        answer: { kind: 'approval', decision: 'approve', optionId },
        acceptedDecisionRevision: expect.any(String),
      });
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('once');
      await until(async () => (f.runtime.getLifecycleState().busy ? undefined : true));
      const beforeRead = (await f.store.getMetadata()).lastChangeCursor;
      const beforeProvider = f.a.requests.length;
      const first = await client.listPermissionGrants('s', {
        storeId: f.base.expectedStoreId,
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.nextAfterSeq).toBeNull();
      const grant = first.items[0]!.grant;
      expect(grant).toMatchObject({
        kind: 'tool',
        interactionId: tool.id,
        executionId: accepted.tool.id,
        ruleId: 'builtin.shell.command',
        contractId: 'builtin.shell.exact-command',
        scope: { commandDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(beforeRead);
      expect(f.a.requests).toHaveLength(beforeProvider);
      f.a.description('Inspect workspace state again');
      await f.submit('grant-second');
      const repeated = await originalShellSettlement(f, 'grant-second');
      expectParentShellDispatch(repeated, workspaceOutsideScope);
      expect(repeated.cards).toHaveLength(0);
      expect(repeated.tool.id).not.toBe(accepted.tool.id);
      expect(repeated.tool.input).toMatchObject({
        command: oneShotShellCommand,
        description: 'Inspect workspace state again',
      });
      const db = new Database(f.profile.databasePath, { readonly: true });
      try {
        const recorded = db
          .query<{ dispatch_authorization_json: string }, [string]>(
            'SELECT dispatch_authorization_json FROM execution WHERE id = ?',
          )
          .get(repeated.tool.id)!;
        expect(JSON.parse(recorded.dispatch_authorization_json)).toMatchObject({
          grant: { grantId: grant.interactionId, offer: { scopeDigest: grant.scopeDigest } },
        });
      } finally {
        db.close();
      }
      expect(
        (await client.listPermissionGrants('s', { storeId: f.base.expectedStoreId })).items.map(
          (row) => row.grant.interactionId,
        ),
      ).toEqual([grant.interactionId]);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('onceonce');

      const denyChanged = async (
        id: string,
        input: { command: string; workdir?: string } & RequestedScope,
      ) => {
        await f.submit(id);
        const changed = await f.card('shell.execute');
        const pending = await originalShellWork(f, id);
        expect(changed.id).not.toBe(tool.id);
        expect(pending.tool).toMatchObject({
          status: 'planned',
          input,
          authorization: { dispatched: false },
        });
        expect(pending.jobs).toHaveLength(0);
        await client.answerInteraction('s', changed.id, {
          expectedStoreId: f.base.expectedStoreId,
          commandId: `deny-${id}`,
          expectedRevision: changed.revision,
          answer: { kind: 'approval', decision: 'deny' },
        });
        const denied = await originalShellSettlement(f, id);
        expect(denied.cards.map((row) => row.id)).toEqual([changed.id]);
        expect(denied.tool).toMatchObject({
          status: 'failed',
          authorization: { dispatched: false, human: { decision: 'deny' } },
          result: { details: { code: 'approval_denied' } },
        });
        expect(denied.jobs).toHaveLength(0);
        expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('onceonce');
      };
      const changedCommand = 'printf changed >> effect';
      f.a.command(changedCommand);
      await denyChanged('grant-changed', { command: changedCommand, ...workspaceOutsideScope });
      f.a.command(oneShotShellCommand);
      const changedScope = { filesystem: 'full_access', network: 'internet' } as const;
      f.a.permissions(changedScope);
      await denyChanged('grant-changed-scope', { command: oneShotShellCommand, ...changedScope });
      f.a.permissions(workspaceOutsideScope);
      const otherWorkdir = join(f.workspace, 'other-working-directory');
      mkdirSync(otherWorkdir);
      f.a.workdir(otherWorkdir);
      await denyChanged('grant-changed-workdir', {
        command: oneShotShellCommand,
        workdir: otherWorkdir,
        ...workspaceOutsideScope,
      });
      expect(existsSync(join(otherWorkdir, 'effect'))).toBe(false);
      f.a.workdir();
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
      await denyChanged('grant-after-clear', {
        command: oneShotShellCommand,
        ...workspaceOutsideScope,
      });
      const invalidSubject = await fetch(
        service.endpoint +
          `/v1/sessions/s/permission-grants?storeId=${original.expectedStoreId}&subjectId=other`,
        { headers: { authorization: `Bearer ${service.bootstrap.token}` } },
      );
      expect(invalidSubject.status).toBe(400);
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
      f.a.beforeStop(async (sessionId) => {
        await until(async () => {
          const original = await f.store.getExtensionRecord({
            sessionId: 's',
            extensionId: 'builtin.shell',
            key: `shell-session/${sessionId}`,
          });
          const value = original?.value;
          if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
          const ref = value.ref;
          if (
            !ref ||
            typeof ref !== 'object' ||
            Array.isArray(ref) ||
            typeof ref.executionId !== 'string' ||
            ref.originStoreId !== f.base.expectedStoreId
          )
            return undefined;
          const job = await f.store.getExecution(ref.executionId);
          if (
            job?.kind !== 'job' ||
            job.definitionId !== 'shell.command' ||
            job.sessionId !== 's' ||
            job.originStoreId !== f.base.expectedStoreId ||
            job.status !== 'running'
          )
            return undefined;
          const reference = job.reference;
          if (
            !reference ||
            typeof reference !== 'object' ||
            Array.isArray(reference) ||
            typeof reference.processGroupId !== 'number' ||
            !Number.isSafeInteger(reference.processGroupId) ||
            reference.processGroupId < 2
          )
            return undefined;
          const output = await f.store.listExecutionOutput({
            executionId: job.id,
            afterSeq: '0',
            limit: 200,
          });
          return output.items
            .filter((row) => row.stream === 'stdout')
            .map((row) => row.content)
            .join('')
            .includes('ready')
            ? job
            : undefined;
        });
      });
      await f.submit();
      await f.done();
      const rows = await f.store.listExecutions('s');
      const job = rows.find((row) => row.definitionId === 'shell.command')!;
      expect(job.status).toBe('cancelled');
      const group = (job.reference as { processGroupId: number }).processGroupId;
      expect(() => process.kill(-group, 0)).toThrow();
      const launch = rows.find((row) => row.definitionId === 'shell.execute')!;
      const sessionId = (launch.result as { details: { session_id: number } }).details.session_id;
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
            key: `shell-session/${sessionId}`,
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
              id: 'shell.execute',
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
              id: 'shell.execute',
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
      const launch = (await f.store.listExecutions('s')).find(
        (row) => row.definitionId === 'shell.execute',
      )!;
      const sessionId = (launch.result as { details: { session_id: number } }).details.session_id;
      const record = await f.store.getExtensionRecord({
        sessionId: 's',
        extensionId: 'builtin.shell',
        key: `shell-session/${sessionId}`,
      });
      expect(record?.value).toMatchObject({ ref: { originStoreId: f.base.expectedStoreId } });
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
          key: `shell-session/${sessionId}`,
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
    createShellConfiguration({ workspaceRoot: '/not-read', toolIds: ['shell.execute'] }),
  ).rejects.toMatchObject({ code: 'shell_unavailable' });
});

nativeTest(
  'attached background Shell preserves its binding and queues another Session until parent cancellation confirms the original stop',
  async () => {
    const f = await fixture({
      background: true,
      command: "printf started > started; trap '' TERM; sleep 30 & wait",
    });
    try {
      await f.submit();
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
      await initializeLivePermissionFixture({
        runtime: f.runtime,
        profile: f.profile,
        ...f.base,
        sessionId: 'other',
        workspaceId: 'w',
        mode: 'full',
        trusted: true,
        nativeShellRead: true,
      });
      await f.runtime.submitCommand({
        ...f.base,
        sessionId: 'other',
        commandId: 'queued',
        request: { kind: 'run.start', content: '新任务：next' },
      });
      const queued = await until(async () => {
        const row = (await f.store.listExecutions('other')).find(
          (item) => item.definitionId === 'shell.command',
        );
        return row?.status === 'planned' ? row : undefined;
      });
      expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
      expect((await f.store.getExecution(first.id))?.status).toBe('running');
      await f.runtime.cancelCommand({
        ...f.base,
        commandId: 'precise-parent-stop',
        targetCommandId: 'work',
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

nativeTest(
  'formal Request Approval runs opaque Workspace Shell once and independently approves outside writes and Internet',
  async () => {
    const f = await fixture({ persistentPermissions: true, hostBoundary: true });
    let connections = 0;
    const server = createServer((_request, response) => {
      connections++;
      response.end('okay');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const outside = join(f.root, 'outside-approved');
    const port = (server.address() as { port: number }).port;
    const curl = `/usr/bin/curl --connect-timeout 1 --max-time 1 -s http://127.0.0.1:${port}/`;
    const latestJob = async () =>
      (await f.store.listExecutions('s'))
        .filter((row) => row.definitionId === 'shell.command')
        .at(-1)!;
    const approveOriginal = async (prefix: string) => {
      await f.approve('shell.execute', `${prefix}-tool`);
    };
    try {
      f.a.command(
        `printf begin >> effect; printf blocked > '${outside}'; ${curl}; printf end >> effect`,
      );
      await f.submit();
      await f.done();
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('beginend');
      expect(existsSync(outside)).toBe(false);
      expect(connections).toBe(0);
      expect(
        (await f.store.listInteractions({ ...f.base, state: 'pending' })).interactions,
      ).toHaveLength(0);
      expect(await latestJob()).toMatchObject({
        status: 'succeeded',
        result: { details: { processTreeStopped: true } },
      });
      expect(
        (await f.store.listExecutions('s')).filter((row) => row.definitionId === 'shell.command'),
      ).toHaveLength(1);

      f.a.permissions({ filesystem: 'full_access', network: 'none' });
      f.a.command(`printf granted > '${outside}'; ${curl}; printf outside >> effect`);
      await f.submit('grant-outside');
      const card = await f.card('shell.execute');
      expect(card.request).toMatchObject({
        policy: { executionScope: { filesystem: 'full_access', network: 'none' } },
      });
      expect(existsSync(outside)).toBe(false);
      await approveOriginal('outside');
      const outsideWork = await originalShellSettlement(f, 'grant-outside');
      expectParentShellDispatch(outsideWork, workspaceOutsideScope);
      expect(outsideWork.cards.map((row) => row.definitionId)).toEqual(['shell.execute']);
      expect(readFileSync(outside, 'utf8')).toBe('granted');
      expect(connections).toBe(0);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('beginendoutside');

      f.a.permissions({ filesystem: 'workspace_write', network: 'internet' });
      f.a.command(`printf blocked > '${outside}'; ${curl}; printf network >> effect`);
      await f.submit('grant-network-denied');
      const deny = await f.card('shell.execute');
      expect(connections).toBe(0);
      await f.runtime.answerInteraction({
        ...f.base,
        presentationSessionId: 's',
        commandId: 'network-deny',
        interactionId: deny.id,
        expectedRevision: deny.revision,
        answer: { kind: 'approval', decision: 'deny' },
      });
      await f.done('grant-network-denied');
      expect(connections).toBe(0);
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('beginendoutside');

      await f.submit('grant-network');
      await approveOriginal('network');
      const networkWork = await originalShellSettlement(f, 'grant-network');
      expectParentShellDispatch(networkWork, {
        filesystem: 'workspace_write',
        network: 'internet',
      });
      expect(networkWork.cards.map((row) => row.definitionId)).toEqual(['shell.execute']);
      expect(connections).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('granted');
      expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('beginendoutsidenetwork');
      expect(await latestJob()).toMatchObject({
        status: 'succeeded',
        result: { details: { processTreeStopped: true } },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    }
  },
  20000,
);

nativeTest(
  'formal Auto uses actual Model review for Shell scope and explicit rejection has zero effect and visible reason',
  async () => {
    for (const decision of ['approve_once', 'reject'] as const) {
      const f = await fixture({
        mode: 'auto',
        hostBoundary: true,
        review: decision,
        command: 'printf reviewed >> effect',
      });
      try {
        f.a.description('PURPOSE_ONLY_DO_NOT_USE_AS_AUTHORIZATION');
        await f.submit();
        await f.done();
        expect(f.a.reviews.length).toBeGreaterThan(0);
        expect(JSON.stringify(f.a.reviews)).not.toContain(
          'PURPOSE_ONLY_DO_NOT_USE_AS_AUTHORIZATION',
        );
        expect(
          (await f.store.listExecutions('s')).find((row) => row.definitionId === 'shell.execute'),
        ).toMatchObject({ input: { description: 'PURPOSE_ONLY_DO_NOT_USE_AS_AUTHORIZATION' } });
        expect(
          (await f.store.listInteractions({ ...f.base, state: 'pending' })).interactions,
        ).toHaveLength(0);
        if (decision === 'approve_once') {
          expect(readFileSync(join(f.workspace, 'effect'), 'utf8')).toBe('reviewed');
          expect(
            (await f.store.listExecutions('s')).find((row) => row.definitionId === 'shell.command'),
          ).toMatchObject({
            status: 'succeeded',
            result: { details: { processTreeStopped: true } },
          });
        } else {
          expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
          expect(
            (await f.store.listExecutions('s')).find((row) => row.definitionId === 'shell.execute'),
          ).toMatchObject({
            status: 'failed',
            result: { details: { reason: 'scope rejected by reviewer' } },
            authorization: {
              dispatched: false,
              check: { decision: 'reject', reason: 'scope rejected by reviewer' },
            },
          });
          const view = await f.store.getView('s');
          expect(view.runs).toHaveLength(1);
          expect(view.runs[0]).toMatchObject({ originCommandId: 'work', status: 'completed' });
          expect(
            f.a.requests.some((request) =>
              (request.messages as { role: string; content: string }[]).some(
                (message) =>
                  message.role === 'tool' && message.content.includes('scope rejected by reviewer'),
              ),
            ),
          ).toBe(true);
          expect(await f.store.listMessages('s', { afterSeq: '0', limit: 100 })).toContainEqual(
            expect.objectContaining({ role: 'assistant', content: 'supervised Shell facts' }),
          );
          expect(
            (await f.store.listExecutions('s')).filter(
              (row) => row.definitionId === 'shell.command',
            ),
          ).toHaveLength(0);
        }
      } finally {
        await f.close();
      }
    }
  },
  15000,
);

nativeTest(
  'formal extreme dangerous literal command is refused before approval or Job effects under all three policies',
  async () => {
    for (const mode of ['accept_edits', 'auto', 'full'] as const) {
      for (const command of [
        'rm -rf /; printf unsafe > effect',
        'printf unsafe > effect; cd /etc; rm -rf ./kite-fixed-guard-never-created',
      ]) {
        const f = await fixture({
          mode,
          hostBoundary: true,
          review: 'approve_once',
          command,
        });
        try {
          await f.submit();
          await f.done();
          expect(existsSync(join(f.workspace, 'effect'))).toBe(false);
          expect(f.a.reviews).toHaveLength(0);
          expect(
            (await f.store.listInteractions({ ...f.base, state: 'pending' })).interactions,
          ).toHaveLength(0);
          expect(
            (await f.store.listExecutions('s')).filter(
              (row) => row.definitionId === 'shell.command',
            ),
          ).toHaveLength(0);
          expect(
            await f.runtime.getExecution(
              (await f.store.listExecutions('s')).find(
                (row) => row.definitionId === 'shell.execute',
              )!.id,
            ),
          ).toMatchObject({
            result: {
              content: expect.stringContaining('Reason: shell_command_hard_denied'),
              details: {
                reason: 'shell_command_hard_denied',
                adapterAttempted: false,
                dispatchCommitted: false,
              },
            },
          });
        } finally {
          await f.close();
        }
      }
    }
  },
  15000,
);

for (const expanded of [false, true])
  nativeTest(
    `Auto reviewer timeout stops before dispatch without asking for approval (expanded request: ${expanded})`,
    async () => {
      let connections = 0;
      const remote = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          connections++;
          return new Response('timeout-network-ok');
        },
      });
      const request = `/usr/bin/curl --connect-timeout 1 --max-time 2 -fsS http://127.0.0.1:${remote.port}/timeout`;
      const f = await fixture({
        mode: 'auto',
        review: 'reject',
        // Leave time for persisted preparation and HTTP admission within the three-attempt budget.
        reviewDelayMs: 1500,
        reviewTimeoutMs: 500,
        hostBoundary: true,
        command: `${request}; printf continued > timeout-local.txt`,
      });
      try {
        const outside = join(f.root, 'outside-timeout.txt');
        if (expanded) {
          f.a.command(
            `printf allowed > '${outside}'; printf forbidden > '${join(f.profile.profilePath, 'timeout-protected.txt')}'; ${request}; printf continued > timeout-local.txt`,
          );
          f.a.permissions({ filesystem: 'full_access', network: 'internet' });
        }
        await f.submit();
        await f.done();
        const rows = await f.store.listExecutions('s');
        const launch = rows.find((e) => e.definitionId === 'shell.execute')!;
        expect(rows.some((e) => e.definitionId === 'shell.command')).toBe(false);
        expect(launch).toMatchObject({
          status: 'failed',
          authorization: { dispatched: false, check: { decision: 'unavailable' } },
          result: {
            details: {
              code: 'authorization_check_timeout',
              dispatchCommitted: false,
              adapterAttempted: false,
              authorizationCheck: { decision: 'timeout' },
            },
          },
        });
        // The overall deadline can expire before the third attempt reaches the Provider.
        const [originalReview, ...reviewRetries] = f.a.reviews;
        expect(originalReview).toBeDefined();
        expect(f.a.reviews.length).toBeLessThanOrEqual(3);
        for (const retry of reviewRetries) expect(retry).toEqual(originalReview!);
        const checks = rows.filter(
          (row) => row.kind === 'model' && row.parentExecutionId === launch.id,
        );
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({
          status: 'failed',
          result: { code: 'authorization_check_timeout' },
        });
        const attempts = (
          checks[0]!.result as {
            reviewAttempts: { attempt: number; status: string; detail?: string }[];
          }
        ).reviewAttempts;
        expect(attempts.length).toBeGreaterThanOrEqual(f.a.reviews.length);
        expect(attempts.length).toBeLessThanOrEqual(3);
        expect(attempts.map((attempt) => attempt.attempt)).toEqual(
          Array.from({ length: attempts.length }, (_, index) => index + 1),
        );
        for (const attempt of attempts)
          expect(
            attempt.status === 'timed_out' ||
              (attempt.status === 'failed' && attempt.detail === 'request_timeout'),
          ).toBe(true);
        expect(existsSync(join(f.workspace, 'timeout-local.txt'))).toBe(false);
        expect(existsSync(outside)).toBe(false);
        expect(existsSync(join(f.profile.profilePath, 'timeout-protected.txt'))).toBe(false);
        expect(connections).toBe(0);
        expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
        expect((await f.runtime.listInteractions(f.base)).interactions).toHaveLength(0);
      } finally {
        await f.close();
        remote.stop(true);
      }
    },
  );
