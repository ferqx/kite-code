import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RuntimeOptions } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import {
  createPermissionCheckContextReader,
  createPermissionPolicy,
  type PermissionPolicySnapshot,
} from '@kite-ai/agent/permissions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { parseModelPreset } from '../../src/model-options';
import { createPermissionManagement } from '../../src/permission-management';

async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('default_auto_deadline');
    await Bun.sleep(10);
  }
}
type CheckResponse = 'approve_once' | 'reject' | 'ask_user' | 'invalid' | 'failure' | 'length';
async function fixture(
  decision: CheckResponse = 'approve_once',
  options: {
    maxOutputTokens?: number;
    reasoningEffort?: 'low';
    authorizationCheck?: RuntimeOptions['authorizationCheck'];
    /** Legacy task authorization is an explicit custom policy, not the new builtin default. */
    defaultBuiltinPolicy?: true;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-auto-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const checks: {
    route: string;
    body: Record<string, unknown>;
    payload: Record<string, unknown>;
  }[] = [];
  const normalRequests: { route: string; body: Record<string, unknown> }[] = [];
  let workId = 'work',
    step = 0;
  let blockCheck = false;
  let releaseCheck!: () => void;
  const providers = ['a', 'b'].map((route) =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        const messages = body.messages as { role: string; content: string }[];
        let payload: Record<string, unknown> | undefined;
        try {
          const content = messages
            .slice()
            .reverse()
            .find((message) => message.role === 'user')?.content;
          const parsed = JSON.parse(content ?? '') as Record<string, unknown>;
          if (parsed.purpose === 'authorization_check') payload = parsed;
        } catch {}
        let call: { name: string; arguments: string } | undefined;
        let content = 'finished';
        if (payload) {
          checks.push({ route, body, payload });
          if (blockCheck) await new Promise<void>((resolve) => (releaseCheck = resolve));
          if (decision === 'failure') return new Response('fixture failure', { status: 503 });
          content = JSON.stringify({
            decision: ['invalid', 'length'].includes(decision) ? 'approve_once' : decision,
            reason: 'exact original operation only',
            ...(decision === 'invalid' ? { executionId: 'self-reported-is-not-proof' } : {}),
          });
        } else {
          normalRequests.push({ route, body });
          if (step++ === 0)
            call = {
              name: 'write_file',
              arguments: JSON.stringify({
                path: `${workId}.txt`,
                content: `actual ${workId}`,
                base: null,
              }),
            };
        }
        const chunk = {
          id: 'response',
          object: 'chat.completion.chunk',
          created: 1,
          model: `remote-${route}`,
          choices: [
            {
              index: 0,
              delta: call
                ? {
                    tool_calls: [
                      { index: 0, id: `call-${workId}`, type: 'function', function: call },
                    ],
                  }
                : { content },
              finish_reason: null,
            },
          ],
        };
        const finish = {
          ...chunk,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: call
                ? 'tool_calls'
                : payload && decision === 'length'
                  ? 'length'
                  : 'stop',
            },
          ],
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      },
    }),
  );
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'a',
    models: providers.map((provider, index) => ({
      id: ['a', 'b'][index],
      provider: 'compatible',
      model: `remote-${['a', 'b'][index]}`,
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      options: {
        temperature: 0.25,
        ...(options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
      },
    })),
    tools: [{ id: 'files.write', definitionVersion: '3' }],
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  let policy: PermissionPolicySnapshot = {
    mode: 'auto',
    workspaceTrust: true,
    revision: 'actual-auto-1',
    allowed: [
      { kind: 'model', definitionId: 'a', definitionVersion: '1' },
      { kind: 'model', definitionId: 'b', definitionVersion: '1' },
      { kind: 'tool', definitionId: 'files.write', definitionVersion: '3' },
    ],
  };
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    permissionPolicy: { readPolicy: () => policy },
    ...(options.defaultBuiltinPolicy
      ? {}
      : {
          permissions: createPermissionPolicy({
            readPolicy: () => policy,
            describeCapability: (request) => ({
              kind: request.kind,
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
              revision: 'fixture-original-task-approval',
              hardAllowed: true,
              safeRead: false,
              effects: request.kind === 'model' ? ['network'] : ['workspace_write'],
            }),
            readCheckContext: (request) =>
              createPermissionCheckContextReader({
                readRuntime: () => runtime,
                originStoreId: expectedStoreId,
                subjectId: 'owner',
              })(request),
          }),
        }),
    ...(options.authorizationCheck ? { authorizationCheck: options.authorizationCheck } : {}),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const artifacts = createArtifactStore({ profile, store });
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  const runtime = createRuntime({
    ...host,
    workspaceSerialLocks,
    permissions: host.permissions!,
    store,
    artifacts,
    modelConcurrency: 1,
  });
  host.permissionManagement?.(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    beforeResourceClose: () => workspaceSerialLocks.close(),
    profile: serverProfile,
    subjectId: 'owner',
    buildId: 'default-auto',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'interactions'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: pathToFileURL(workspace).href,
  });
  await client.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 'auto',
  });
  const control = createPermissionManagement({ runtime, profile });
  const identity = { expectedStoreId, subjectId: 'owner' };
  const mode = await control.readMode({ ...identity, sessionId: 's' });
  await control.setMode({
    ...identity,
    sessionId: 's',
    commandId: 'fixture-mode',
    mode: 'auto',
    makeDefault: false,
    ifRevision: mode.revision,
    ifDefaultRevision: mode.defaultRevision,
  });
  const trust = await control.readTrust({ ...identity, workspaceId: 'w' });
  await control.setTrust({
    ...identity,
    workspaceId: 'w',
    commandId: 'fixture-trust',
    trusted: true,
    ifRevision: trust.revision,
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
  });
  const f = {
    runtime,
    store,
    client,
    expectedStoreId,
    checks,
    normalRequests,
    workspace,
    configuration,
    get policy() {
      return policy;
    },
    set policy(value: PermissionPolicySnapshot) {
      policy = value;
    },
    set blockCheck(value: boolean) {
      blockCheck = value;
    },
    releaseCheck() {
      releaseCheck?.();
    },
    writeConfiguration() {
      writeFileSync(configurationPath, JSON.stringify(configuration));
    },
    async run(commandId = 'work', content = 'exact harmless file task') {
      if (commandId !== workId) {
        workId = commandId;
        step = 0;
      }
      return client.startRun('s', { expectedStoreId, commandId, kind: 'run.start', content });
    },
    async done(commandId = workId) {
      try {
        return await runtime.waitForCommand(commandId, { timeoutMs: 8000 });
      } catch (error) {
        const command = await runtime.getCommand(commandId);
        const executions = await store.listExecutions('s');
        const facts = [];
        for (const execution of executions) {
          facts.push({
            id: execution.id,
            kind: execution.kind,
            definition: execution.definitionId,
            status: execution.status,
            content:
              execution.result &&
              typeof execution.result === 'object' &&
              !Array.isArray(execution.result)
                ? execution.result.content
                : undefined,
          });
          if (execution.childSessionId)
            facts.push({
              childSessionId: execution.childSessionId,
              executions: (await store.listExecutions(execution.childSessionId)).map((child) => ({
                kind: child.kind,
                status: child.status,
                definition: child.definitionId,
                content:
                  child.result && typeof child.result === 'object' && !Array.isArray(child.result)
                    ? child.result.content
                    : undefined,
              })),
            });
        }
        const cards = await runtime.listInteractions({
          expectedStoreId,
          sessionId: 's',
          state: 'pending',
        });
        throw new Error(
          JSON.stringify({
            cause: error instanceof Error ? error.message : String(error),
            command: command && {
              id: command.id,
              status: command.status,
              receipt: command.receipt,
              dispatchFailure: 'dispatchFailure' in command ? command.dispatchFailure : undefined,
            },
            facts,
            pendingCards: cards.interactions.map((card) => ({ id: card.id, kind: card.kind })),
            checks: checks.length,
            normalRequests: normalRequests.length,
          }),
        );
      }
    },
    async pending() {
      return until(
        async () =>
          (await client.listInteractions('s', { storeId: expectedStoreId, state: 'pending' }))
            .interactions[0] ?? null,
      );
    },
    async approve(
      card: Awaited<ReturnType<typeof client.listInteractions>>['interactions'][number],
    ) {
      return client.answerInteraction('s', card.id, {
        expectedStoreId,
        commandId: `answer-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve' },
      });
    },
    async close() {
      releaseCheck?.();
      client.disposeNetwork();
      try {
        await service.close();
      } finally {
        for (const provider of providers) await provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
  return f;
}

test('default Auto delegates builtin file effects to their tool policy without a Shell risk check', async () => {
  const f = await fixture('approve_once', { defaultBuiltinPolicy: true });
  try {
    await f.run();
    await f.done();
    expect(readFileSync(join(f.workspace, 'work.txt'), 'utf8')).toBe('actual work');
    expect(f.checks).toHaveLength(0);
    expect(f.normalRequests).toHaveLength(2);
    expect(
      (await f.store.listExecutions('s')).filter((e) => e.kind === 'model' && e.runId === null),
    ).toHaveLength(0);
    expect(
      (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
    ).toHaveLength(0);
    const run = (await f.store.getView('s')).runs[0]!;
    expect(
      ((run.configuration as Record<string, unknown>).snapshot as Record<string, unknown>)
        .defaultAutoReview,
    ).toBe('shell_risk');
  } finally {
    await f.close();
  }
});

test('a custom task policy retains the selected SDK reviewer, durable check and exact once intent', async () => {
  const f = await fixture();
  try {
    const task = `Full task ${'完整授权上下文'.repeat(2048)}`;
    await f.run('work', task);
    await f.done();
    const write = (await f.store.listExecutions('s')).find(
      (execution) => execution.definitionId === 'files.write',
    );
    expect(write?.result).toMatchObject({ outcome: 'succeeded' });
    expect(readFileSync(join(f.workspace, 'work.txt'), 'utf8')).toBe('actual work');
    expect(f.checks).toHaveLength(1);
    expect(f.checks[0]!.route).toBe('a');
    expect(f.checks[0]!.body.model).toBe('remote-a');
    expect(f.checks[0]!.body.temperature).toBe(0.25);
    expect(f.checks[0]!.body.max_tokens).toBe(256);
    expect(f.normalRequests.every(({ body }) => body.max_tokens === undefined)).toBe(true);
    expect(f.checks[0]!.body.tools ?? []).toEqual([]);
    expect(f.checks[0]!.body.messages).toContainEqual({
      role: 'system',
      content: expect.stringContaining('Assess this operation independently'),
    });
    expect(JSON.stringify(f.checks[0]!.payload)).toContain(task);
    expect(f.checks[0]!.payload.target).toMatchObject({
      definitionId: 'files.write',
      definitionVersion: '3',
      input: { path: 'work.txt', base: null },
    });
    const executions = await f.store.listExecutions('s');
    expect(executions.every((execution) => execution.childSessionId === null)).toBe(true);
    const check = executions.find(
      (execution) => execution.kind === 'model' && execution.runId === null,
    )!;
    expect(check).toMatchObject({
      definitionId: 'a',
      status: 'succeeded',
      parentExecutionId: expect.any(String),
    });
    expect((await f.store.getCommand(check.originCommandId))!.kind).toBe('authorization.check');
    expect((await f.store.getView('s')).runs).toHaveLength(1);
    const background = await f.client.listBackgroundExecutions({
      storeId: f.expectedStoreId,
      rootSessionId: 's',
    });
    expect(background.items.every((item) => item.execution.childSessionId === null)).toBe(true);
    expect(background.items.some((item) => item.execution.id === check.id)).toBe(false);
    expect(
      (await f.runtime.listMessages('s')).every(
        (message) => !message.content.includes('authorization_check'),
      ),
    ).toBe(true);
    expect(
      (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
    ).toHaveLength(0);
    const original = await f.runtime.getCommand('work');
    await f.run('work', task);
    expect(await f.runtime.getCommand('work')).toEqual(original);
    expect(f.checks).toHaveLength(1);
    expect(f.normalRequests).toHaveLength(2);
    f.configuration.modelId = 'b';
    f.writeConfiguration();
    await f.run('work-two', 'New task: exact harmless file task');
    const next = await f.done();
    const receipt = next.receipt as { runId: string };
    expect(next.status).toBe('applied');
    expect(await f.store.getRun(receipt.runId)).toMatchObject({
      originCommandId: next.id,
      rootWorkCommandId: next.id,
      status: 'completed',
    });
    const models = (await f.store.listExecutions('s')).filter(
      (execution) => execution.kind === 'model' && execution.runId === receipt.runId,
    );
    expect(models).toHaveLength(2);
    for (const model of models)
      expect(model).toMatchObject({
        originCommandId: next.id,
        rootWorkCommandId: next.id,
        definitionId: 'b',
      });
    expect(f.checks).toHaveLength(2);
    expect(f.checks[1]!.route).toBe('b');
    expect(f.checks[1]!.body.model).toBe('remote-b');
    // Checker identity stays bound in the immutable command, not reviewer context.
    const persistedChecks = (await f.store.listExecutions('s')).filter(
      (execution) => execution.kind === 'model' && execution.runId === null,
    );
    const checker = async (modelId: string) => {
      const saved = persistedChecks.find((execution) => execution.definitionId === modelId)!;
      const command = (await f.store.getCommand(saved.originCommandId))!;
      return (
        command.request as { input: { checker: { id: string; version: string; modelId: string } } }
      ).input.checker;
    };
    const [firstChecker, nextChecker] = await Promise.all([checker('a'), checker('b')]);
    expect(firstChecker).toMatchObject({ id: 'builtin.auto', modelId: 'a' });
    expect(nextChecker).toMatchObject({ id: 'builtin.auto', modelId: 'b' });
    expect(firstChecker.version).not.toBe(nextChecker.version);
    expect(f.checks.every(({ payload }) => payload.checker === undefined)).toBe(true);
    expect(readFileSync(join(f.workspace, 'work-two.txt'), 'utf8')).toBe('actual work-two');
  } finally {
    await f.close();
  }
}, 20000);

test('custom task-policy ask_user requires the original human card without rerunning its check', async () => {
  const f = await fixture('ask_user');
  try {
    await f.run();
    const card = await f.pending();
    expect(existsSync(join(f.workspace, 'work.txt'))).toBe(false);
    expect(card.request).toMatchObject({
      definitionId: 'files.write',
      input: { path: 'work.txt', base: null },
    });
    expect(f.checks).toHaveLength(1);
    const executions = await f.store.listExecutions('s');
    expect(executions.every((execution) => execution.childSessionId === null)).toBe(true);
    expect(
      executions.filter((execution) => execution.kind === 'model' && execution.runId === null),
    ).toHaveLength(1);
    await f.approve(card);
    await f.done();
    expect(readFileSync(join(f.workspace, 'work.txt'), 'utf8')).toBe('actual work');
    expect(f.checks).toHaveLength(1);
    expect(
      (await f.runtime.getInteraction({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        interactionId: card.id,
      }))!.acceptedDecisionRevision,
    ).not.toBeNull();
  } finally {
    await f.close();
  }
}, 30000);

for (const maxOutputTokens of [32, 4096])
  test(`the selected checker caps only its output without expanding the original ${maxOutputTokens} token preset`, async () => {
    const f = await fixture('approve_once', { maxOutputTokens, reasoningEffort: 'low' });
    try {
      await f.run();
      await f.done();
      expect(f.checks).toHaveLength(1);
      expect(f.checks[0]!.body).toMatchObject({
        max_tokens: Math.min(maxOutputTokens, 256),
        temperature: 0.25,
        reasoning_effort: 'low',
      });
      expect(f.normalRequests).toHaveLength(2);
      for (const { body } of f.normalRequests)
        expect(body).toMatchObject({
          max_tokens: maxOutputTokens,
          temperature: 0.25,
          reasoning_effort: 'low',
        });
      expect(f.configuration.models[0]!.options.maxOutputTokens).toBe(maxOutputTokens);
      const check = (await f.store.listExecutions('s')).find(
        (execution) => execution.kind === 'model' && execution.runId === null,
      )!;
      const original = f.configuration.models[0]!;
      const uncappedVersion = createHash('sha256')
        .update(
          JSON.stringify({
            provider: original.provider,
            id: original.id,
            model: original.model,
            baseURL: original.baseURL,
            credentialRef: null,
            options: parseModelPreset(original.options),
          }),
        )
        .digest('hex');
      const command = (await f.store.getCommand(check.originCommandId))!;
      const { version } = (command.request as { input: { checker: { version: string } } }).input
        .checker;
      // Changed actual reviewer settings must not retain an old cold-Run identity.
      expect(version === uncappedVersion).toBe(maxOutputTokens <= 256);
      const snapshot = await f.runtime.readModelInput({
        expectedStoreId: f.expectedStoreId,
        subjectId: 'owner',
        sessionId: 's',
        executionId: check.id,
      });
      expect(snapshot.metadata.adapter).toMatchObject({
        availability: 'available',
        settings: { maxOutputTokens: Math.min(maxOutputTokens, 256), reasoningEffort: 'low' },
      });
      expect(readFileSync(join(f.workspace, 'work.txt'), 'utf8')).toBe('actual work');
    } finally {
      await f.close();
    }
  });

test('an injected checker keeps its own adapter while ordinary model output settings remain unchanged', async () => {
  const calls: string[] = [];
  const model: NonNullable<RuntimeOptions['authorizationCheck']>['model'] = {
    async *stream(request) {
      calls.push(request.modelId);
      yield {
        type: 'text_delta',
        text: JSON.stringify({ decision: 'approve_once', reason: 'custom exact task approval' }),
      };
      yield {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: null, outputTokens: null },
      };
    },
  };
  const f = await fixture('approve_once', {
    maxOutputTokens: 4096,
    authorizationCheck: { id: 'injected', version: 'own-version', modelId: 'own-route', model },
  });
  try {
    await f.run();
    await f.done();
    expect(calls).toEqual(['own-route']);
    expect(f.checks).toEqual([]);
    expect(f.normalRequests).toHaveLength(2);
    expect(f.normalRequests.every(({ body }) => body.max_tokens === 4096)).toBe(true);
    const check = (await f.store.listExecutions('s')).find(
      (execution) => execution.kind === 'model' && execution.runId === null,
    )!;
    expect(check).toMatchObject({ definitionId: 'own-route', status: 'succeeded' });
    expect(readFileSync(join(f.workspace, 'work.txt'), 'utf8')).toBe('actual work');
  } finally {
    await f.close();
  }
});

for (const decision of ['invalid', 'failure', 'length'] as const)
  test(`custom task-policy ${decision} is a readable technical failure returned to the next Model without a human card or effects`, async () => {
    const f = await fixture(decision);
    try {
      await f.run();
      await f.done();
      expect(existsSync(join(f.workspace, 'work.txt'))).toBe(false);
      expect(f.checks).toHaveLength(1);
      expect(f.normalRequests).toHaveLength(2);
      expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
      const executions = await f.store.listExecutions('s');
      expect(executions.every((execution) => execution.childSessionId === null)).toBe(true);
      const check = executions.find(
        (execution) => execution.kind === 'model' && execution.runId === null,
      )!;
      expect(check.status).toBe('failed');
      const tool = executions.find((execution) => execution.kind === 'tool')!;
      const content = (tool.result as { content: string }).content;
      expect(content).toContain('No approval or rejection decision was made');
      expect(content).toContain('This operation was not executed');
      if (decision === 'length') expect(content).toContain('output token limit');
      expect(content).not.toContain('Do not bypass this refusal');
      expect(tool).toMatchObject({
        status: 'failed',
        authorization: { dispatched: false, check: { decision: 'unavailable' } },
        result: {
          details: {
            code: 'authorization_check_unavailable',
            dispatchCommitted: false,
            adapterAttempted: false,
            authorizationCheck: {
              decision: 'unavailable',
              executionId: check.id,
              failureCode:
                decision === 'failure'
                  ? 'MODEL_ATTEMPT_RETRYABLE_FAILURE:provider_unavailable'
                  : decision === 'length'
                    ? 'authorization_check_output_limit'
                    : 'authorization_check_output_invalid',
            },
          },
        },
      });
      const messages = f.normalRequests[1]!.body.messages as { role: string; content: string }[];
      const received = messages.find((message) => message.role === 'tool')?.content ?? '';
      expect(received).toContain(content);
      expect(received).toContain('This request was not executed and produced no effects');
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);

test('custom task approval cannot pass untrusted, missing allowlist, policy revocation or cancellation', async () => {
  for (const change of ['untrusted', 'allowlist', 'revoke', 'cancel'] as const) {
    const f = await fixture();
    try {
      if (change === 'untrusted') f.policy = { ...f.policy, workspaceTrust: false };
      if (change === 'allowlist')
        f.policy = {
          ...f.policy,
          allowed: f.policy.allowed.filter((entry) => entry.kind === 'model'),
        };
      if (change === 'revoke' || change === 'cancel') f.blockCheck = true;
      await f.run();
      if (change === 'revoke' || change === 'cancel') {
        await until(async () => (f.checks.length ? true : null));
        expect(existsSync(join(f.workspace, 'work.txt'))).toBe(false);
        if (change === 'revoke')
          f.policy = { ...f.policy, workspaceTrust: false, revision: 'revoked' };
        else
          await f.runtime.cancelCommand({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            commandId: 'cancel',
            subjectId: 'owner',
            targetCommandId: 'work',
          });
        f.releaseCheck();
      }
      await f.done();
      expect(existsSync(join(f.workspace, 'work.txt'))).toBe(false);
      expect(f.checks).toHaveLength(change === 'untrusted' || change === 'allowlist' ? 0 : 1);
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId, state: 'pending' }))
          .interactions,
      ).toHaveLength(0);
      const tool = (await f.store.listExecutions('s')).find(
        (execution) => execution.kind === 'tool',
      )!;
      expect(['failed', 'cancelled']).toContain(tool.status);
    } finally {
      await f.close();
    }
  }
}, 30000);

test('Auto rejection preserves the denied tool result and allows the Model to finish without file effects', async () => {
  const f = await fixture('reject');
  try {
    await f.run();
    await f.done();
    expect(existsSync(join(f.workspace, 'work.txt'))).toBe(false);
    expect(f.checks).toHaveLength(1);
    expect(f.normalRequests).toHaveLength(2);
    expect((await f.runtime.getView('s')).runs[0]!.status).toBe('completed');
    expect(
      (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'files.write',
      )!.status,
    ).toBe('failed');
    expect(
      (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
