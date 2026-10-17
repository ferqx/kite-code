import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { createPermissionPolicy } from '@kite-ai/agent/permissions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';

const questions = {
  questions: [
    {
      question: 'First?',
      options: [
        { label: 'q1-o2', description: 'Exact label', recommended: true },
        { label: 'Second', description: 'Other' },
      ],
    },
    {
      question: 'Free?',
      options: [
        { label: 'One', description: 'One' },
        { label: 'Two', description: 'Two' },
      ],
    },
  ],
};
async function fixture(
  input: {
    mode?: 'accept_edits' | 'auto' | 'full';
    planning?: boolean;
    tools?: unknown[];
    child?: boolean;
    explicitChild?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-ask-user-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const requests: Record<string, unknown>[] = [];
  let completionWaiting = false;
  let releaseCompletion: (() => void) | undefined;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content?: string }[];
      if (input.planning) {
        for (const message of messages) {
          let diagnostic: { kind?: string };
          try {
            diagnostic = JSON.parse(String(message.content));
          } catch {
            continue;
          }
          if (diagnostic?.kind !== 'completion_diagnostic') continue;
          // The answered question cannot satisfy planning; inspect its original repair turn.
          await new Promise<void>((resolve) => {
            releaseCompletion = resolve;
            completionWaiting = true;
          });
          break;
        }
      }
      const results = messages.filter((message) => message.role === 'tool');
      let call: { name: string; input: unknown } | undefined;
      if (!results.length)
        call =
          input.child && body.model === 'parent'
            ? {
                name: 'task',
                input: {
                  key: 'child',
                  role: 'worker',
                  input: { content: 'Ask the user' },
                  cancellation: 'attached',
                },
              }
            : { name: 'ask_user', input: questions };
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
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
            : { content: 'Finished' },
          null,
        ) +
          chunk({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const config = {
    modelId: 'fixed',
    models: [
      {
        id: 'fixed',
        provider: 'compatible',
        model: input.child ? 'parent' : 'fixed',
        baseURL: `${provider.url.href}v1`,
      },
      ...(input.child
        ? [
            {
              id: 'child',
              provider: 'compatible',
              model: 'child',
              baseURL: `${provider.url.href}v1`,
            },
          ]
        : []),
    ],
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.child ? { tools: [{ id: 'task' }] } : {}),
  };
  writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify(config));
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    credentialBackend: createTemporaryCredentialBackend(),
    planning: { requirePlan: input.planning ?? false },
    ...(input.child
      ? {
          child: [
            {
              id: 'worker',
              version: '1',
              modelId: 'child',
              ...(input.explicitChild ? { toolIds: ['ask_user'] } : {}),
            },
          ],
        }
      : {}),
    permissionPolicy: {
      readPolicy: () => ({
        mode: input.mode ?? 'full',
        workspaceTrust: true,
        revision: 'owned',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          { kind: 'model', definitionId: 'child', definitionVersion: '1' },
          ...['ask_user', 'task'].map((id) => ({
            kind: 'tool' as const,
            definitionId: id,
            definitionVersion: '1',
          })),
          { kind: 'job', definitionId: 'agent/worker', definitionVersion: '1' },
        ],
      }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    ...host,
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
  });
  const permissionManagement = host.permissionManagement?.(runtime);
  const target = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: target,
    buildId: 'default-ask-user',
    subjectId: 'owner',
    permissionManagement,
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: target,
      apiMajor: 1,
      requiredCapabilities: ['interactions', 'commands', 'model_inputs', 'permission_grants'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(workspace).href,
    name: 'Owned',
  });
  await client.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    title: 'Questions',
  });
  return {
    root,
    runtime,
    store,
    client,
    requests,
    expectedStoreId,
    databasePath: profile.databasePath,
    disableQuestions() {
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({ ...config, tools: [{ id: 'ask_user', enabled: false }] }),
      );
    },
    async waitForCompletionModel() {
      const deadline = Date.now() + 5000;
      while (!completionWaiting) {
        if (Date.now() > deadline) throw Error('ask_user_completion_model_deadline');
        await Bun.sleep(10);
      }
    },
    resumeCompletionModel() {
      releaseCompletion?.();
    },
    async close() {
      releaseCompletion?.();
      client.disposeNetwork();
      await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  await f.client.startRun('s', {
    expectedStoreId: f.expectedStoreId,
    commandId: 'run',
    kind: 'run.start',
    content: 'Ask exact questions',
  });
}
async function assertUnavailableRecovery(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  requests: Record<string, unknown>[],
) {
  expect(requests).toHaveLength(2);
  const view = await f.runtime.getView(sessionId);
  expect(view.runs).toHaveLength(1);
  const run = view.runs[0]!;
  expect(run.status).toBe('completed');
  const models = view.executions.filter((execution) => execution.kind === 'model');
  expect(models).toHaveLength(2);
  expect(
    models.every(
      (execution) =>
        execution.status === 'succeeded' &&
        execution.runId === run.id &&
        execution.originStoreId === f.expectedStoreId,
    ),
  ).toBe(true);
  const tools = view.executions.filter((execution) => execution.kind === 'tool');
  expect(tools).toHaveLength(1);
  const failed = tools[0]!;
  expect(failed).toMatchObject({
    definitionId: 'ask_user',
    definitionVersion: 'unavailable',
    status: 'failed',
    sessionId,
    runId: run.id,
    originStoreId: f.expectedStoreId,
    authorization: { dispatched: false },
    result: { content: 'tool_not_available', details: { code: 'tool_not_available' } },
  });
  const messages = await f.runtime.listMessages(sessionId);
  const answer = messages.find((message) => message.role === 'tool');
  expect(answer).toBeDefined();
  expect(answer!.sourceIds).toEqual([failed.id]);
  const first = messages.find(
    (message) => message.role === 'assistant' && message.toolCalls?.length,
  );
  expect(first!.sourceIds).toEqual([models[0]!.id]);
  expect(answer!.toolCallId).toBe(first!.toolCalls![0]!.id);
  expect(first!.toolCalls![0]!.name).toBe('ask_user');
  expect(
    messages.filter((message) => message.role === 'assistant' && message.content === 'Finished'),
  ).toMatchObject([{ runId: run.id, sourceIds: [models[1]!.id] }]);
  const delivered = (
    requests[1]!.messages as { role: string; tool_call_id?: string; content: string }[]
  ).filter((message) => message.role === 'tool');
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.tool_call_id).toBe(answer!.toolCallId);
  expect(delivered[0]!.content).toContain('tool_not_available');
  expect(
    (await f.store.listInteractions({ sessionId, expectedStoreId: f.expectedStoreId }))
      .interactions,
  ).toHaveLength(0);
  expect(await f.runtime.getCommand('answer')).toBeNull();
  const database = new Database(f.databasePath, { readonly: true });
  try {
    expect(
      database.query("SELECT id FROM command WHERE kind='interaction.answer'").all(),
    ).toHaveLength(0);
  } finally {
    database.close();
  }
}

for (const mode of ['accept_edits', 'auto', 'full'] as const)
  test(`default ask_user uses actual compatible schema and public answer in ${mode}`, async () => {
    const f = await fixture({ mode, planning: mode === 'accept_edits' });
    try {
      await start(f);
      let card:
        | Awaited<ReturnType<typeof f.client.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 5000;
      while (!card) {
        const page = await f.client.listInteractions('s', { storeId: f.expectedStoreId });
        expect(page.interactions.some((item) => item.kind === 'approval')).toBe(false);
        card = page.interactions.find((item) => item.kind === 'question');
        if (Date.now() > deadline) throw Error(JSON.stringify(await f.client.getView('s')));
        if (!card) await Bun.sleep(10);
      }
      const tools = f.requests[0]!.tools as {
        function: { name: string; description: string; parameters: unknown };
      }[];
      const actual = tools.find((tool) => tool.function.name === 'ask_user')!;
      expect(actual.function.description.length).toBeGreaterThan(20);
      expect(actual.function.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['questions'],
      });
      expect(card.definitionId).toBe('ask_user');
      expect(card.definitionVersion).toBe('1');
      f.disableQuestions();
      await f.client.answerInteraction('s', card.id, {
        expectedStoreId: f.expectedStoreId,
        commandId: 'answer',
        expectedRevision: card.revision,
        answer: { kind: 'question', answers: { q1: 'q1-o1', q2: { text: 'q1-o1' } } },
      });
      if (mode === 'accept_edits') await f.waitForCompletionModel();
      else await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
      expect(f.requests).toHaveLength(mode === 'accept_edits' ? 3 : 2);
      const messages = f.requests[1]!.messages as { role: string; content: string }[];
      expect(JSON.parse(messages.find((item) => item.role === 'tool')!.content)).toMatchObject({
        answer: 'First?: q1-o2\nFree?: q1-o1',
        answers: { q1: 'q1-o2', q2: 'q1-o1' },
      });
      expect((await f.client.getExecution(card.executionId!)).status).toBe('succeeded');
      const run = (await f.client.getView('s')).runs[0]!;
      if (mode === 'accept_edits') {
        // The third request is actual required-plan completion governance, not a
        // question retry. The already answered interaction remains the only question.
        const view = await f.runtime.getView('s');
        const models = view.executions.filter((execution) => execution.kind === 'model');
        expect(models).toHaveLength(3);
        expect(
          models
            .slice(0, 2)
            .every((execution) => execution.status === 'succeeded' && execution.attempt === 1),
        ).toBe(true);
        const sources = (execution: (typeof models)[number]) =>
          (
            execution.decisionSource as {
              sources?: { id: string; kind: string; scope: string; digest: string }[];
            }
          ).sources ?? [];
        const completionModels = models.filter((execution) =>
          sources(execution).some((source) => source.kind === 'completion'),
        );
        expect(completionModels).toHaveLength(1);
        const completion = completionModels[0]!;
        expect(completion.status).toBe('dispatching');
        expect(completion.attempt).toBe(1);
        expect(completion.runId).toBe(run.id);
        expect(completion.sessionId).toBe('s');
        expect(completion.originStoreId).toBe(f.expectedStoreId);
        expect(sources(completion).filter((source) => source.kind === 'completion')).toMatchObject([
          { id: `builtin.planning:completion:${run.id}`, scope: 's' },
        ]);
        expect(
          new Set(
            models.flatMap((execution) =>
              sources(execution)
                .filter((source) => source.id.startsWith('builtin.planning:runtime:'))
                .map((source) => source.digest),
            ),
          ).size,
        ).toBe(1);
        expect(
          view.executions
            .filter((execution) => execution.definitionId === 'ask_user')
            .map((execution) => execution.id),
        ).toEqual([card.executionId!]);
        const interactions = (await f.client.listInteractions('s', { storeId: f.expectedStoreId }))
          .interactions;
        expect(interactions).toHaveLength(1);
        expect(interactions[0]).toMatchObject({ id: card.id, state: 'answered' });
        const pending = (await f.store.getRun(run.id))!;
        expect(pending.isActive).toBe(true);
        expect(pending.status).toBe('running');
        expect(
          pending.requirements.some(
            (ref) => ref.requirementId === 'plan.required' && ref.runId === run.id,
          ),
        ).toBe(true);
        await f.client.cancelRun('s', {
          expectedStoreId: f.expectedStoreId,
          commandId: 'cancel-original-plan',
          kind: 'run.cancel',
          runId: run.id,
        });
        f.resumeCompletionModel();
        await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
        const cancelled = (await f.store.getRun(run.id))!;
        expect(cancelled.id).toBe(pending.id);
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.requirements).toEqual(pending.requirements);
        expect((await f.client.getExecution(completion.id)).status).toBe('cancelled');
        expect(f.requests).toHaveLength(3);
      }
      // The exact answer succeeded independently of the still-required plan.
      expect((await f.client.getRun(run.id)).status).toBe(
        mode === 'accept_edits' ? 'cancelled' : 'completed',
      );
      expect(
        (await f.client.listPermissionGrants('s', { storeId: f.expectedStoreId })).items,
      ).toHaveLength(0);
      const saved = await f.client.getRun(run.id);
      expect(saved.configuration).toMatchObject({
        tools: [{ id: 'ask_user', version: '1' }],
        snapshot: {
          actualCapabilities: {
            tools: [{ id: 'ask_user', definitionVersion: '1', extensionId: 'builtin.ask-user' }],
          },
        },
      });
      expect((await f.client.listMessages('s')).length).toBeGreaterThanOrEqual(3);
      if (mode === 'full') {
        await f.client.startRun('s', {
          expectedStoreId: f.expectedStoreId,
          commandId: 'next',
          kind: 'run.start',
          content: 'New explicit work',
        });
        await f.runtime.waitForCommand('next', { timeoutMs: 5000 });
        const nextTools = f.requests.at(-1)!.tools as { function: { name: string } }[] | undefined;
        expect(nextTools?.some((tool) => tool.function.name === 'ask_user') ?? false).toBe(false);
        expect((await f.client.getRun(run.id)).configuration).toEqual(saved.configuration);
      }
    } finally {
      await f.close();
    }
  }, 15000);

for (const entry of [
  { id: 'ask_user', enabled: false },
  { id: 'ask_user', remove: true },
  { id: 'ask_user', definitionVersion: '99' },
  { id: 'ask_user', options: { invented: true } },
  { id: 'unknown-tool' },
])
  test(`configuration locally handles ${JSON.stringify(entry)}`, async () => {
    const f = await fixture({ tools: [entry] });
    try {
      await start(f);
      await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
      ).toHaveLength(0);
      if ('enabled' in entry || 'remove' in entry) {
        const tools = f.requests[0]!.tools as { function: { name: string } }[] | undefined;
        expect(tools?.some((tool) => tool.function.name === 'ask_user') ?? false).toBe(false);
        await assertUnavailableRecovery(f, 's', f.requests);
      } else {
        expect(f.requests).toHaveLength(0);
        expect((await f.client.getCommand('run')).status).toBe('rejected');
      }
    } finally {
      await f.close();
    }
  }, 15000);

for (const explicitChild of [false, true])
  test(`actual child cannot ask_user; explicit role=${explicitChild}`, async () => {
    const f = await fixture({ child: true, explicitChild });
    try {
      await start(f);
      await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
      const deadline = Date.now() + 5000;
      while (
        f.requests.filter((body) => body.model === 'child').length < 1 &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      const child = f.requests.filter((body) => body.model === 'child');
      expect(child).toHaveLength(2);
      const tools = child[0]!.tools as { function: { name: string } }[] | undefined;
      expect(tools?.some((tool) => tool.function.name === 'ask_user') ?? false).toBe(false);
      const rootView = await f.client.getView('s');
      const childSessionId = rootView.executions.find(
        (execution) => execution.childSessionId,
      )?.childSessionId;
      expect(childSessionId).toBeDefined();
      const view = await f.client.getView(childSessionId!);
      await assertUnavailableRecovery(f, childSessionId!, child);
      const configuration = view.runs[0]!.configuration as { tools: { id: string }[] };
      expect(configuration.tools.some((tool) => tool.id === 'ask_user')).toBe(false);
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 15000);

test('zero-effect host facts do not approve unknown definitions; Request Approval permits trusted workspace writes', async () => {
  for (const mode of ['accept_edits', 'auto'] as const)
    for (const effect of [[], ['unknown'], ['workspace_write']] as const) {
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode,
          workspaceTrust: true,
          revision: 'owned',
          allowed: [{ kind: 'tool', definitionId: 'exact', definitionVersion: '1' }],
        }),
        describeCapability: () => ({
          kind: 'tool',
          definitionId: 'exact',
          definitionVersion: '1',
          revision: 'trusted',
          effects: effect,
          safeRead: effect.length === 0,
          hardAllowed: true,
        }),
      });
      expect(
        (
          await policy.authorize({
            kind: 'tool',
            definitionId: 'exact',
            definitionVersion: '1',
            sessionId: 's',
            runId: null,
            executionId: 'e',
            input: {},
            signal: new AbortController().signal,
          })
        ).allowed,
      ).toBe(effect.length === 0 || (mode === 'accept_edits' && effect[0] === 'workspace_write'));
      expect(
        (
          await policy.authorize({
            kind: 'tool',
            definitionId: 'unknown',
            definitionVersion: '1',
            sessionId: 's',
            runId: null,
            executionId: 'e',
            input: {},
            signal: new AbortController().signal,
          })
        ).allowed,
      ).toBe(false);
    }
});
