import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import { type PlanningOptions, planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import type { PermissionMode } from '../../src/permissions';

type Call = { name: string; input: Json } | null;
async function until<T>(read: () => Promise<T | null>) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = await read();
    if (found !== null) return found;
    if (Date.now() > deadline) throw new Error('planning_configuration_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  planning: PlanningOptions,
  toolIds: string[],
  script: (step: number, f: Fixture) => Promise<Call>,
  policy?: { mode: PermissionMode; trusted?: boolean; exclude?: string[] },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-planning-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  const steps = new Map<string, number>();
  let currentCommand = 'work';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      let review = false;
      try {
        const messages = body.messages as { role: string; content: string }[];
        review =
          JSON.parse(
            messages
              .slice()
              .reverse()
              .find((message) => message.role === 'user')?.content ?? '',
          ).purpose === 'authorization_review';
      } catch {}
      const step = steps.get(currentCommand) ?? 0;
      if (!review) steps.set(currentCommand, step + 1);
      const call: Call = review ? null : await script(step, f);
      const chunk = {
        id: 'response',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local',
        choices: [
          {
            index: 0,
            delta: call
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
                  content: review
                    ? JSON.stringify({ decision: 'approve_once', reason: 'exact fixture call' })
                    : 'finished',
                },
            finish_reason: null,
          },
        ],
      };
      const finish = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'local',
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
    ],
    tools: toolIds.map((id) => ({
      id,
      definitionVersion: id === 'files.read' ? '3' : id === 'files.write' ? '2' : '1',
    })),
    planning: { requirePlan: true },
  };
  writeFileSync(configurationPath, JSON.stringify(configuration));
  const host = createDefaultProcessConfiguration({
    profile,
    planning,
    ...(policy
      ? {
          permissionPolicy: {
            readPolicy: () => ({
              mode: policy.mode,
              workspaceTrust: policy.trusted ?? true,
              revision: 'actual-business-host-1',
              allowed: [
                { kind: 'model' as const, definitionId: 'local', definitionVersion: '1' },
                ...toolIds
                  .filter((id) => !policy.exclude?.includes(id))
                  .map((id) => ({
                    kind: 'tool' as const,
                    definitionId: id,
                    definitionVersion: id === 'files.read' ? '3' : id === 'files.write' ? '2' : '1',
                  })),
                ...['planning.write', 'planning.review', 'planning.update'].map((id) => ({
                  kind: 'job' as const,
                  definitionId: `${planningExtensionId}/${id}`,
                  definitionVersion: '1',
                })),
              ],
            }),
          },
        }
      : {
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'explicit-test-host' };
            },
          },
        }),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
  const runtime = createRuntime({
    store,
    workspaceSerialLocks,
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  host.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: `file://${workspace}`,
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'planning',
  });
  const f = {
    root,
    workspace,
    configurationPath,
    configuration,
    store,
    runtime,
    requests,
    base,
    get commandId() {
      return currentCommand;
    },
    async runId() {
      return (await store.listExecutions('s')).find(
        (x) => x.originCommandId === currentCommand && x.runId !== null,
      )!.runId!;
    },
    async record(key: string) {
      return store.getExtensionRecord({ sessionId: 's', extensionId: planningExtensionId, key });
    },
    async submit(commandId = 'work') {
      currentCommand = commandId;
      return runtime.submitCommand({
        ...base,
        commandId,
        request: { kind: 'run.start', content: commandId },
      });
    },
    async done(commandId = currentCommand) {
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      const receipt = command.receipt as Record<string, Json> | null;
      return { command, run: receipt?.runId ? await store.getRun(String(receipt.runId)) : null };
    },
    async answer(kind: 'plan_review' | 'question') {
      const card = await until(
        async () =>
          (
            await store.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
          ).interactions.find((x) => x.kind === kind) ?? null,
      );
      await runtime.answerInteraction({
        ...base,
        commandId: `answer-${card.id}`,
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer:
          kind === 'question'
            ? { kind, answers: { waive: true } }
            : { kind, decision: 'approve', mode: 'auto' },
      });
      return card;
    },
    async close() {
      try {
        await runtime.close();
      } finally {
        try {
          await workspaceSerialLocks.close();
        } finally {
          provider.stop(true);
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  };
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('default business catalogue is installed once; no host flags leaves ordinary chat unconstrained and versions reject before Provider', async () => {
  const f = await fixture({}, [], async () => null);
  try {
    expect(
      f.runtime.getExtensionCatalogue().filter((x) => x.extensionId === planningExtensionId),
    ).toHaveLength(1);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await f.runtime.queryExtension({
      sessionId: 's',
      subjectId: 'user',
      extensionId: planningExtensionId,
      queryId: 'planning.status',
      input: {},
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(f.requests).toHaveLength(0);
    await f.submit();
    const first = await f.done();
    expect(first.run?.status).toBe('completed');
    expect(first.run?.requirements).toEqual([]);
    expect(first.run?.configuration).toMatchObject({
      snapshot: { planning: { fileHashChecker: null, commandChecker: null, mcpCheckers: [] } },
    });
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'idle-action',
      request: {
        kind: 'extension.invoke',
        extensionId: planningExtensionId,
        actionId: 'planning.write',
        definitionVersion: '1',
        input: {
          planId: 'idle-plan',
          expectedVersion: null,
          title: 'Idle action',
          body: 'Pure local metadata',
          steps: [{ id: 'a', title: 'metadata' }],
        },
      },
    });
    const action = await f.runtime.waitForCommand('idle-action', { timeoutMs: 5000 });
    const actionReceipt = action.receipt as Record<string, Json>;
    const execution = await f.store.getExecution(String(actionReceipt.executionId));
    expect(execution?.kind).toBe('job');
    expect(execution?.runId).toBeNull();
    expect(execution?.status).toBe('succeeded');
    expect(f.requests).toHaveLength(1);
    const queryCursor = (await f.store.getMetadata()).lastChangeCursor;
    const views = await f.runtime.queryExtension({
      sessionId: 's',
      subjectId: 'user',
      extensionId: planningExtensionId,
      queryId: 'planning.status',
      input: {},
    });
    expect(JSON.stringify(views)).toContain('idle-plan');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(queryCursor);

    writeFileSync(
      f.configurationPath,
      JSON.stringify({
        ...f.configuration,
        tools: [{ id: 'planning.read', definitionVersion: 'wrong' }],
      }),
    );
    await f.submit('wrong-version');
    const rejected = await f.done();
    expect(rejected.command.status).toBe('rejected');
    expect((rejected.command.receipt as Record<string, Json>)?.reason).toBe(
      'tool_definition_version_unavailable',
    );
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('requirePlan initializes before first real Provider call; user review and actual file receipt complete the exact plan', async () => {
  const f = await fixture(
    { requirePlan: true },
    ['planning.write', 'planning.review', 'planning.update', 'files.write'],
    async (step, f): Promise<Call> => {
      const runId = await f.runId();
      if (step === 0) {
        const run = await f.store.getRun(runId);
        expect(run?.requirements[0]?.originStoreId).toBe(f.base.expectedStoreId);
        expect(await f.record(`run/${runId}/plan.required`)).not.toBeNull();
        return {
          name: 'planning.write',
          input: {
            planId: 'p',
            expectedVersion: null,
            title: 'Private plan',
            body: 'Write one harmless ledger',
            steps: [{ id: 'a', title: 'write' }],
          },
        };
      }
      const current = (await f.record('plan.current'))!.value as Record<string, Json>;
      if (step === 1)
        return {
          name: 'planning.review',
          input: { planId: current.planId!, version: current.version!, digest: current.digest! },
        };
      if (step === 2)
        return {
          name: 'files.write',
          input: { path: 'ledger.txt', content: 'one actual effect', base: null },
        };
      if (step === 3) {
        const actual = (await f.store.listExecutions('s')).find(
          (x) => x.runId === runId && x.definitionId === 'files.write',
        )!;
        return {
          name: 'planning.update',
          input: {
            runId,
            planId: current.planId!,
            version: current.version!,
            digest: current.digest!,
            expectedProgressRevision: null,
            stepId: 'a',
            status: 'completed',
            executionId: actual.id,
            completePlan: true,
          },
        };
      }
      return null;
    },
  );
  try {
    await f.submit();
    const card = await f.answer('plan_review');
    expect(card.definitionId).toBe('planning.review');
    const done = await f.done();
    const executions = await f.store.listExecutions('s');
    const file = executions.find(
      (row) => row.runId === done.run?.id && row.definitionId === 'files.write',
    )!;
    const progress = (await f.record('progress/p/1'))?.value as Record<string, Json> | undefined;
    console.log(
      JSON.stringify({
        planningEvidence: {
          storeId: f.base.expectedStoreId,
          commandId: 'work',
          runId: done.run?.id,
          runStatus: done.run?.status,
          review: { interactionId: card.id, executionId: card.executionId, source: card.source },
          file: {
            id: file.id,
            status: file.status,
            runId: file.runId,
            originStoreId: file.originStoreId,
            rootWorkCommandId: file.rootWorkCommandId,
            definitionVersion: file.definitionVersion,
            decisionSource: file.decisionSource,
            result: file.result,
          },
          progress,
        },
      }),
    );
    expect(done.run?.status).toBe('completed');
    expect(readFileSync(join(f.workspace, 'ledger.txt'), 'utf8')).toBe('one actual effect');
    expect(file).toMatchObject({
      status: 'succeeded',
      runId: done.run!.id,
      originStoreId: f.base.expectedStoreId,
      rootWorkCommandId: 'work',
      definitionVersion: '2',
    });
    expect(progress).toMatchObject({
      runId: done.run!.id,
      planId: 'p',
      version: 1,
      completePlan: true,
      steps: {
        a: {
          status: 'completed',
          receipt: { executionId: file.id, definitionId: 'files.write', definitionVersion: '2' },
        },
      },
    });

    expect(
      (await f.store.listExecutions('s')).filter((x) => x.definitionId === 'files.write'),
    ).toHaveLength(1);
    expect(JSON.stringify(f.requests)).toContain('current_plan');
  } finally {
    await f.close();
  }
}, 15000);

test('required validation saves an exact user waiver; a later Run cannot reuse it and missing receipt evidence fails completion', async () => {
  const f = await fixture(
    { requiredValidation: true, allowWaiver: true },
    ['validation.request_waiver', 'validation.define', 'validation.check'],
    async (step, f): Promise<Call> => {
      const runId = await f.runId();
      if (f.commandId === 'work')
        return step === 0
          ? {
              name: 'validation.request_waiver',
              input: {
                recordKey: `run/${runId}/validation.required`,
                reason: 'Explicit local waiver',
              },
            }
          : null;
      if (step === 0)
        return {
          name: 'validation.define',
          input: {
            runId,
            checks: [
              {
                kind: 'receipt',
                target: {
                  executionId: 'nonexistent-target',
                  attempt: 1,
                  definitionId: 'files.write',
                  definitionVersion: '2',
                  inputDigest: 'missing',
                  resultRevision: '1',
                },
              },
            ],
          },
        };
      if (step === 1) return { name: 'validation.check', input: { runId } };
      return null;
    },
  );
  try {
    await f.submit();
    const card = await f.answer('question');
    const first = await f.done();
    expect(first.run?.status).toBe('completed');
    const oldHead = (await f.record(`run/${first.run!.id}/validation.required/waiver.current`))!;
    const oldKey = String((oldHead.value as Record<string, Json>).key);
    expect(JSON.stringify((await f.record(oldKey))!.value)).toContain(card.id);
    await f.submit('next');
    const second = await f.done();
    expect(second.run?.status).toBe('failed');
    expect(second.run?.id).not.toBe(first.run?.id);
    expect(await f.record(`run/${second.run!.id}/validation.required/waiver.current`)).toBeNull();
    expect(
      (await f.store.listExecutions('s')).filter(
        (x) => x.definitionId === 'validation.request_waiver',
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('global exact Planning Action uses trusted Ask/Accept Edits record approval, Full bypass, and untrusted denial without any Model', async () => {
  for (const mode of ['ask', 'accept_edits', 'full'] as const) {
    const f = await fixture({}, [], async () => null, { mode });
    try {
      await f.runtime.submitCommand({
        ...f.base,
        commandId: 'idle-governance',
        request: {
          kind: 'extension.invoke',
          extensionId: planningExtensionId,
          actionId: 'planning.write',
          definitionVersion: '1',
          input: {
            planId: 'approved-record',
            expectedVersion: null,
            title: 'Record only',
            body: 'No workspace mutation',
            steps: [{ id: 'one', title: 'Record step' }],
          },
        },
      });
      if (mode !== 'full') {
        const card = await until(
          async () =>
            (
              await f.store.listInteractions({
                expectedStoreId: f.base.expectedStoreId,
                sessionId: 's',
                state: 'pending',
              })
            ).interactions.find((x) => x.kind === 'approval') ?? null,
        );
        expect(card.definitionId).toBe(`${planningExtensionId}/planning.write`);
        expect(card.request).toMatchObject({ policy: { effects: ['record_write'], mode } });
        expect(await f.record('plan.current')).toBeNull();
        expect(f.requests).toHaveLength(0);
        await f.runtime.answerInteraction({
          ...f.base,
          commandId: 'approve-idle',
          presentationSessionId: 's',
          interactionId: card.id,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        });
      }
      const done = await f.runtime.waitForCommand('idle-governance', { timeoutMs: 5000 });
      const execution = await f.store.getExecution(
        String((done.receipt as Record<string, Json>).executionId),
      );
      expect(execution).toMatchObject({ kind: 'job', runId: null, status: 'succeeded' });
      expect(await f.record('plan.current')).not.toBeNull();
      expect(f.requests).toHaveLength(0);
      expect((await f.store.getView('s')).runs).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
  const denied = await fixture({}, [], async () => null, { mode: 'full', trusted: false });
  try {
    await denied.runtime.submitCommand({
      ...denied.base,
      commandId: 'untrusted-action',
      request: {
        kind: 'extension.invoke',
        extensionId: planningExtensionId,
        actionId: 'planning.write',
        definitionVersion: '1',
        input: {
          planId: 'denied',
          expectedVersion: null,
          title: 'deny',
          body: 'deny',
          steps: [{ id: 'a', title: 'a' }],
        },
      },
    });
    const command = await denied.runtime.waitForCommand('untrusted-action', { timeoutMs: 5000 });
    expect(command.status).toBe('applied');
    expect(
      await denied.store.getExecution(
        String((command.receipt as Record<string, Json>).executionId),
      ),
    ).toMatchObject({ status: 'failed', result: { content: 'permission_denied' } });
    expect(await denied.record('plan.current')).toBeNull();
    expect(denied.requests).toHaveLength(0);
  } finally {
    await denied.close();
  }
}, 15000);

test('actual host checker identities are frozen in Run snapshot; parent record authorization cannot grant its nested file read', async () => {
  const host = {
    fileHashChecker: { definitionId: 'files.read', definitionVersion: '3' },
    commandChecker: { definitionId: 'shell.command', definitionVersion: '1' },
    mcpCheckers: [
      {
        id: 'read',
        definitionId: 'host.mcp.read',
        definitionVersion: 'host-v1',
        sourceDefinitionId: 'host.mcp.write',
        sourceDefinitionVersion: 'source-v1',
      },
    ],
  };
  const f = await fixture(
    host,
    ['validation.define', 'validation.check', 'files.read'],
    async (step, f): Promise<Call> => {
      if (step === 0)
        return {
          name: 'validation.define',
          input: {
            runId: await f.runId(),
            checks: [{ kind: 'file_hash', path: 'private.txt', sha256: '0'.repeat(64) }],
          },
        };
      if (step === 1) return { name: 'validation.check', input: { runId: await f.runId() } };
      return null;
    },
    { mode: 'full', exclude: ['files.read'] },
  );
  try {
    host.commandChecker.definitionVersion = 'later';
    host.mcpCheckers[0]!.sourceDefinitionVersion = 'later';
    writeFileSync(join(f.workspace, 'private.txt'), 'actual private fixture');
    writeFileSync(
      f.configurationPath,
      JSON.stringify({
        ...f.configuration,
        planning: {
          fileHashChecker: { definitionId: 'fake', definitionVersion: 'fake' },
          commandChecker: { definitionId: 'fake', definitionVersion: 'fake' },
          mcpCheckers: [{ id: 'fake' }],
        },
      }),
    );
    await f.submit();
    const done = await f.done();
    expect(done.run!.configuration).toMatchObject({
      snapshot: {
        planning: {
          fileHashChecker: { definitionId: 'files.read', definitionVersion: '3' },
          commandChecker: { definitionId: 'shell.command', definitionVersion: '1' },
          mcpCheckers: [
            {
              id: 'read',
              definitionId: 'host.mcp.read',
              definitionVersion: 'host-v1',
              sourceDefinitionId: 'host.mcp.write',
              sourceDefinitionVersion: 'source-v1',
            },
          ],
        },
      },
    });
    const executions = await f.store.listExecutions('s');
    expect(executions.find((x) => x.definitionId === 'validation.define')!.status).toBe(
      'succeeded',
    );
    const checker = executions.find((x) => x.definitionId === 'files.read')!;
    expect(checker.status).toBe('failed');
    expect(checker.parentExecutionId).toBe(
      executions.find((x) => x.definitionId === 'validation.check')!.id,
    );
    expect(checker.result).toMatchObject({ content: 'permission_denied' });
    expect(readFileSync(join(f.workspace, 'private.txt'), 'utf8')).toBe('actual private fixture');
  } finally {
    await f.close();
  }
}, 15000);

test('record-write permission approval does not answer the separate exact validation waiver question', async () => {
  const f = await fixture(
    { requiredValidation: true, allowWaiver: true },
    ['validation.request_waiver'],
    async (step, f) =>
      step === 0
        ? {
            name: 'validation.request_waiver',
            input: {
              recordKey: `run/${await f.runId()}/validation.required`,
              reason: 'Explicit exception',
            },
          }
        : null,
    { mode: 'ask' },
  );
  try {
    await f.submit();
    const approval = await until(
      async () =>
        (
          await f.store.listInteractions({
            expectedStoreId: f.base.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions.find((x) => x.kind === 'approval') ?? null,
    );
    expect(approval.request).toMatchObject({ policy: { effects: ['record_write'] } });
    await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'approve-waiver-tool',
      presentationSessionId: 's',
      interactionId: approval.id,
      expectedRevision: approval.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    const question = await f.answer('question');
    expect(question.id).not.toBe(approval.id);
    expect(question.executionId).toBe(approval.executionId);
    expect(question.request).toMatchObject({ kind: 'validation_waiver' });
    const done = await f.done();
    expect(done.run!.status).toBe('completed');
    expect(
      (await f.store.getInteraction({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        interactionId: approval.id,
      }))!.kind,
    ).toBe('approval');
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);
