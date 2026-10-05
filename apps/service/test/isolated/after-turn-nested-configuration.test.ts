import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AfterTurnPolicy, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readSkillSelection } from '../../src/child-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 7000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error('nested_sdk_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(mode: 'nested' | 'followup') {
  const root = mkdtempSync(join(tmpdir(), 'kite-nested-sdk-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const waiting = gate();
  const calls: { model: string; messages: { role: string; content: string | null }[] }[] = [];
  const approvals: { phase: string; definitionId: string; commandId: string; runId: string }[] = [];
  let afterRunId = '',
    contextSelectionId = '',
    unexpected = 0;
  const later = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      unexpected++;
      return new Response('{}');
    },
  });
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof calls)[number];
      calls.push(body);
      const count = calls.filter((call) => call.model === body.model).length;
      let name = '',
        input: unknown;
      if (body.model === 'parent' && count === 1) {
        name = 'task';
        input = {
          key: 'first',
          role: 'worker',
          input: { content: 'initial' },
          cancellation: 'detached',
          resultDisposition: 'background',
        };
      } else if (mode === 'nested' && body.model === 'child' && count === 1) {
        name = 'task';
        input = {
          key: 'nested',
          role: 'grandworker',
          input: { content: 'nested' },
          cancellation: 'detached',
          resultDisposition: 'after_turn',
        };
      } else if (mode === 'followup' && body.model === 'parent' && count === 3) {
        name = 'followup_task';
        input = {
          taskId: 'first',
          key: 'second',
          afterRunId,
          contextSelectionId,
          content: 'new explicitly requested work',
          resultDisposition: 'after_turn',
        };
      }
      if (
        body.model === 'grandchild' ||
        (mode === 'followup' && body.model === 'child' && count === 2)
      )
        await waiting.promise;
      const delta = name
        ? {
            tool_calls: [
              {
                index: 0,
                id: `${body.model}-${count}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          }
        : { content: `${body.model} complete result ${count} full tail` };
      const frame = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${frame(delta, null)}${frame({}, name ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'parent',
    tools: ['task', 'followup_task'].map((id) => ({ id, definitionVersion: '1' })),
    skills: ['alpha', 'beta'].map((id) => ({ id, path: id })),
    models: ['parent', 'child', 'grandchild'].map((id) => ({
      id,
      provider: 'compatible',
      model: id,
      baseURL: `${provider.url.href}v1`,
    })),
  };
  for (const id of ['alpha', 'beta']) {
    mkdirSync(join(workspace, id));
    writeFileSync(
      join(workspace, id, 'SKILL.md'),
      `---\nname: ${id === 'alpha' ? 'AlphaGuide' : 'BetaGuide'}\ndescription: guidance\n---\n${id} original knowledge\n`,
    );
  }
  writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
  const policy: AfterTurnPolicy = {
    async authorize(input) {
      input.signal.throwIfAborted();
      expect(Object.isFrozen(input.command)).toBe(true);
      approvals.push({
        phase: input.phase,
        definitionId: input.execution.definitionId,
        commandId: input.command.id,
        runId: input.run.id,
      });
      return { allowed: true, revision: 'original-sdk-authorizer' };
    },
  };
  const host = createDefaultProcessConfiguration({
    profile,
    afterTurn: policy,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'actual-host' };
      },
    },
    child: [
      { id: 'worker', version: '7', modelId: 'child', toolIds: mode === 'nested' ? ['task'] : [] },
      { id: 'grandworker', version: '8', modelId: 'grandchild', toolIds: [] },
    ],
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    ...host,
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
    modelConcurrency: 1,
  });
  const identity = {
    expectedStoreId: (await store.getMetadata()).storeId,
    subjectId: 'owner',
    sessionId: 'root',
  };
  await runtime.createWorkspace({
    expectedStoreId: identity.expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    ...identity,
    commandId: 'create',
    workspaceId: 'w',
    title: 'nested SDK',
  });
  return {
    store,
    runtime,
    identity,
    waiting,
    calls,
    approvals,
    unexpected: () => unexpected,
    followup(run: string, selection: string) {
      afterRunId = run;
      contextSelectionId = selection;
    },
    replace() {
      writeFileSync(
        configPath,
        JSON.stringify({
          ...configuration,
          models: configuration.models.map((model) => ({
            ...model,
            baseURL: `${later.url.href}v1`,
          })),
        }),
      );
      policy.authorize = async () => {
        throw new Error('must retain original authorizer');
      };
    },
    async close() {
      waiting.release();
      await runtime.close();
      provider.stop(true);
      later.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const mode of ['nested', 'followup'] as const) {
  test(`default compatible SDK ${mode} after_turn retains original carrier, route, authorization and funding deadline`, async () => {
    const f = await fixture(mode);
    try {
      await f.runtime.submitCommand({
        ...f.identity,
        commandId: 'work',
        request: { kind: 'run.start', content: 'initial delegate', selectedSkills: ['AlphaGuide'] },
      });
      await f.runtime.waitForCommand('work', { timeoutMs: 7000 });
      const first = await until(async () =>
        (await f.store.getView('root')).executions.find((e) => e.childSessionId),
      );
      await f.runtime.waitForCommand(first.originCommandId, { timeoutMs: 7000 });
      const before = await f.store.getView(first.childSessionId!);
      expect(before.runs[0]!.status).toBe('completed');
      let carrier = before.executions.find((e) => e.childSessionId);
      if (mode === 'followup') {
        f.followup(before.runs[0]!.id, before.session.contextSelectionId);
        await f.runtime.submitCommand({
          ...f.identity,
          commandId: 'followup-work',
          request: {
            kind: 'run.start',
            content: 'independently authorized new work',
            selectedSkills: ['AlphaGuide'],
          },
        });
        await f.runtime.waitForCommand('followup-work', { timeoutMs: 7000 });
        carrier = (await f.store.getView('root')).executions.find(
          (e) => e.childSessionId && e.id !== first.id,
        );
        expect(carrier!.childSessionId).toBe(first.childSessionId!);
        expect(carrier!.afterTurn).toMatchObject({
          definitionId: 'followup_task',
          parentRunId: (await f.store.getView('root')).runs[1]!.id,
        });
      }
      expect(carrier).toBeDefined();
      await until(async () =>
        f.calls.find(
          (call) =>
            call.model === (mode === 'nested' ? 'grandchild' : 'child') &&
            (mode === 'nested' || f.calls.filter((c) => c.model === 'child').length === 2),
        ),
      );
      expect(f.approvals.map((a) => a.phase)).toEqual(['request']);
      f.replace();
      f.waiting.release();
      await f.runtime.waitForCommand(carrier!.originCommandId, { timeoutMs: 7000 });
      const target = mode === 'nested' ? first.childSessionId! : 'root';
      const report = await until(async () =>
        (await f.store.getView(target)).runs.find((run) =>
          run.originCommandId.startsWith('report-'),
        ),
      );
      await f.runtime.waitForCommand(report.originCommandId, { timeoutMs: 7000 });
      expect(f.approvals.map((a) => a.phase)).toEqual(['request', 'apply']);
      expect(f.approvals[0]).toMatchObject({
        definitionId: mode === 'nested' ? 'task' : 'followup_task',
      });
      expect(f.approvals[1]).toEqual({ ...f.approvals[0]!, phase: 'apply' });
      expect(f.unexpected()).toBe(0);
      expect((await f.store.getExecution(first.id))!.status).toBe('succeeded');
      expect((await f.store.getRun(before.runs[0]!.id))!.status).toBe('completed');
      const funding =
        mode === 'nested' ? before.runs[0]! : (await f.store.getView('root')).runs[1]!;
      expect(report.deadlineAt).toBe(funding.deadlineAt);
      const view = await f.store.getView(target);
      const model = view.executions.find((e) => e.kind === 'model' && e.runId === report.id)!;
      const input = await f.runtime.readModelInput({
        ...f.identity,
        sessionId: target,
        executionId: model.id,
      });
      expect(
        input.request.messages.some(
          (m) =>
            m.sourceIds?.some((id) => id.startsWith('result-')) &&
            m.content.includes(
              mode === 'nested'
                ? 'grandchild complete result 1 full tail'
                : 'child complete result 2 full tail',
            ),
        ),
      ).toBe(true);
      const originalRef = await f.store.getOperation({
        sessionId: 'root',
        extensionId: 'builtin.task',
        subjectId: f.identity.subjectId,
        originStoreId: f.identity.expectedStoreId,
        key: 'first',
      });
      expect(originalRef?.executionId).toBe(first.id);
      expect(originalRef?.childSessionId).toBe(first.childSessionId!);
      expect(f.calls.filter((c) => c.model === 'parent')).toHaveLength(mode === 'nested' ? 2 : 5);
      expect(f.calls.filter((c) => c.model === 'child')).toHaveLength(mode === 'nested' ? 3 : 2);
      expect((await f.store.getExecution(carrier!.id))!.delivery).toBe('consumed');
      for (const run of [
        ...(await f.store.getView('root')).runs,
        ...(await f.store.getView(first.childSessionId!)).runs,
        ...(mode === 'nested' ? (await f.store.getView(carrier!.childSessionId!)).runs : []),
      ])
        expect(readSkillSelection(run.configuration)).toEqual({
          requested: ['AlphaGuide'],
          resolvedIds: ['alpha'],
        });
      expect(JSON.stringify(f.calls)).not.toContain('BetaGuide');
      expect(JSON.stringify(f.calls)).toContain('AlphaGuide');
      const metadata = await f.store.getMetadata();
      await f.runtime.readModelInput({ ...f.identity, sessionId: target, executionId: model.id });
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(metadata.lastChangeCursor);
    } catch (error) {
      const rootView = await f.store.getView('root');
      const outer = rootView.executions.find((e) => e.childSessionId);
      const childView = outer ? await f.store.getView(outer.childSessionId!) : null;
      const nested = childView?.executions.find((e) => e.childSessionId);
      console.error(
        JSON.stringify({
          calls: f.calls.map((c) => c.model),
          lifecycle: f.runtime.getLifecycleState(),
          metadata: await f.store.getMetadata(),
          rootSession: rootView.session,
          rootRuns: rootView.runs.map(({ id, status, isActive, originCommandId, reason }) => ({
            id,
            status,
            isActive,
            originCommandId,
            reason,
          })),
          rootExecutions: rootView.executions.map(
            ({
              id,
              definitionId,
              kind,
              status,
              runId,
              originCommandId,
              rootWorkCommandId,
              parentExecutionId,
              childSessionId,
              ownerGeneration,
              resultRevision,
              cancelRequestedAt,
              delivery,
              deliveryReason,
              result,
            }) => ({
              id,
              definitionId,
              kind,
              status,
              runId,
              originCommandId,
              rootWorkCommandId,
              parentExecutionId,
              childSessionId,
              ownerGeneration,
              resultRevision,
              cancelRequestedAt,
              delivery,
              deliveryReason,
              result,
            }),
          ),
          commands: await Promise.all(
            ['work', 'followup-work', ...rootView.runs.map((run) => run.originCommandId)].map(
              (id) => f.store.getCommand(id),
            ),
          ),
          accepted: await f.store.listAcceptedCommands('root'),
          pendingReports: await f.store.listPendingJobReports(f.identity),
          childSession: childView?.session,
          childExecutions: childView?.executions.map(
            ({
              id,
              definitionId,
              kind,
              status,
              runId,
              originCommandId,
              parentExecutionId,
              ownerGeneration,
              resultRevision,
              cancelRequestedAt,
              delivery,
              result,
            }) => ({
              id,
              definitionId,
              kind,
              status,
              runId,
              originCommandId,
              parentExecutionId,
              ownerGeneration,
              resultRevision,
              cancelRequestedAt,
              delivery,
              result,
            }),
          ),
          outer: outer && { id: outer.id, status: outer.status },
          childRuns: childView?.runs.map((r) => ({ id: r.id, status: r.status })),
          nested: nested && { id: nested.id, status: nested.status },
          descendant: nested
            ? (await f.store.getView(nested.childSessionId!)).executions.map((e) => ({
                id: e.id,
                kind: e.kind,
                status: e.status,
                code:
                  e.result && typeof e.result === 'object' && !Array.isArray(e.result)
                    ? e.result.code
                    : null,
              }))
            : null,
        }),
      );
      throw error;
    } finally {
      await f.close();
    }
  }, 20000);
}
