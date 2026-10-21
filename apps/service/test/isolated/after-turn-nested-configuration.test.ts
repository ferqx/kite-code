import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AfterTurnPolicy, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { readSkillSelection } from '../../src/child-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

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
  privateDirectory(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const waiting = gate();
  const calls: { model: string; messages: { role: string; content: string | null }[] }[] = [];
  const approvals: { phase: string; definitionId: string; commandId: string; runId: string }[] = [];
  let childId = '',
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
        name = 'spawn_agent';
        input = { prompt: 'initial' };
      } else if (mode === 'nested' && body.model === 'child' && count === 1) {
        name = 'spawn_agent';
        input = { prompt: 'nested', preset: 'grandworker' };
      } else if (
        mode === 'followup' &&
        body.model === 'parent' &&
        body.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === 'New task: independently authorized new work',
        ) &&
        !body.messages.some(
          (message) => message.role === 'tool' && message.content?.includes('new_turn'),
        )
      ) {
        name = 'follow_up_agent';
        input = { agent_id: childId, content: 'new explicitly requested work' };
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
    tools: ['task.spawn', 'task.follow_up'].map((id) => ({ id, definitionVersion: '1' })),
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
      if (input.execution.definitionId === 'task.spawn' && input.execution.sessionId === 'root')
        return { allowed: false, revision: 'initial-no-idle-report' };
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
    userConfigurationPath: `${profile.profilePath}/config.jsonc`,
    profile,
    afterTurn: policy,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'actual-host' };
      },
    },
    child: [
      {
        id: 'worker',
        version: '7',
        modelId: 'child',
        toolIds: mode === 'nested' ? ['task.spawn'] : [],
      },
      { id: 'grandworker', version: '8', modelId: 'grandchild', toolIds: [] },
    ],
  });
  if (mode === 'nested') {
    const spawn = host.extensions
      ?.find((extension) => extension.id === 'builtin.task')
      ?.tools?.find((tool) => tool.id === 'task.spawn');
    if (!spawn) throw Error('missing trusted nested spawn');
    const execute = spawn.execute;
    const trustedExecute: typeof execute = (input, context) =>
      execute(input, {
        ...context,
        operations: {
          ...context.operations,
          ensure(options) {
            return context.operations.ensure({
              ...options,
              cancellation: context.sessionId === 'root' ? 'attached' : 'detached',
            });
          },
        },
      });
    Object.assign(spawn, { execute: trustedExecute, resume: trustedExecute });
  }
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
  host.permissionManagement?.(runtime);
  await initializeLivePermissionFixture({
    runtime,
    profile,
    ...identity,
    workspaceId: 'w',
    mode: 'full',
    trusted: true,
  });
  return {
    profile,
    store,
    runtime,
    identity,
    waiting,
    calls,
    approvals,
    unexpected: () => unexpected,
    followup(id: string) {
      childId = id;
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
      const emptyMcp = (
        before.runs[0]!.configuration as {
          snapshot: {
            configuration: {
              mcp: {
                sources: {
                  servers: unknown[];
                  readSet: unknown;
                  inheritance: { parentSessionId: string };
                };
              };
            };
          };
        }
      ).snapshot.configuration.mcp.sources;
      expect(emptyMcp.servers).toHaveLength(0);
      expect(emptyMcp.readSet).toBeNull();
      expect(emptyMcp.inheritance.parentSessionId).toBe('root');
      let carrier = before.executions.find((e) => e.childSessionId);
      let followupRunId: string | undefined;
      if (mode === 'followup') {
        f.followup(first.childSessionId!);
        await f.runtime.submitCommand({
          ...f.identity,
          commandId: 'followup-work',
          request: {
            kind: 'run.start',
            content: 'New task: independently authorized new work',
            selectedSkills: ['AlphaGuide'],
          },
        });
        const command = await f.runtime.waitForCommand('followup-work', { timeoutMs: 7000 });
        const receipt = command.receipt as { businessCommandId: string; runId: string };
        followupRunId = receipt.runId;
        expect(command.status).toBe('applied');
        expect(await f.store.getRun(receipt.runId)).toMatchObject({
          originCommandId: receipt.businessCommandId,
          rootWorkCommandId: command.id,
          status: 'completed',
        });
        const models = (await f.store.listExecutions('root')).filter(
          (execution) => execution.kind === 'model' && execution.runId === receipt.runId,
        );
        expect(models).toHaveLength(2);
        for (const model of models)
          expect(model).toMatchObject({
            originCommandId: receipt.businessCommandId,
            rootWorkCommandId: command.id,
          });
        carrier = (await f.store.getView('root')).executions.find(
          (e) => e.childSessionId && e.id !== first.id,
        );
        expect(carrier!.childSessionId).toBe(first.childSessionId!);
        expect(carrier!.afterTurn).toMatchObject({
          definitionId: 'task.follow_up',
          parentRunId: receipt.runId,
        });
        const followupTool = (await f.store.listExecutions('root')).find(
          (execution) =>
            execution.kind === 'tool' &&
            execution.definitionId === 'task.follow_up' &&
            execution.runId === receipt.runId,
        )!;
        expect(carrier!.parentExecutionId).toBe(followupTool.id);
        expect(carrier!.afterTurn).toMatchObject({ sourceExecutionId: followupTool.id });
      }
      expect(carrier).toBeDefined();
      if (mode === 'nested') {
        const grandchild = await f.store.getView(carrier!.childSessionId!);
        const inheritedEmpty = (
          grandchild.runs[0]!.configuration as {
            snapshot: {
              configuration: {
                mcp: {
                  sources: {
                    servers: unknown[];
                    readSet: unknown;
                    inheritance: { parentSessionId: string };
                  };
                };
              };
            };
          }
        ).snapshot.configuration.mcp.sources;
        expect(inheritedEmpty.servers).toHaveLength(0);
        expect(inheritedEmpty.readSet).toBeNull();
        expect(inheritedEmpty.inheritance.parentSessionId).toBe(first.childSessionId!);
      }
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
      if (mode === 'nested')
        expect((await f.store.getRun(report.id))!.carrierExecutionId).toBe(first.id);
      expect(f.approvals.map((a) => a.phase)).toEqual(['request', 'apply']);
      expect(f.approvals[0]).toMatchObject({
        definitionId: mode === 'nested' ? 'task.spawn' : 'task.follow_up',
      });
      expect(f.approvals[1]).toEqual({ ...f.approvals[0]!, phase: 'apply' });
      expect(f.unexpected()).toBe(0);
      expect((await f.store.getExecution(first.id))!.status).toBe('succeeded');
      expect((await f.store.getRun(before.runs[0]!.id))!.status).toBe('completed');
      const funding = mode === 'nested' ? before.runs[0]! : (await f.store.getRun(followupRunId!))!;
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
      const originalDirectory = await f.store.listStableAgents({
        sessionId: 'root',
        extensionId: 'builtin.task',
        subjectId: f.identity.subjectId,
        expectedStoreId: f.identity.expectedStoreId,
      });
      expect(originalDirectory.items).toHaveLength(1);
      expect(originalDirectory.items[0]!.agentId).toBe(first.childSessionId!);
      expect(originalDirectory.items[0]!.assignmentSource.content).toBe('initial');
      expect(f.calls.filter((c) => c.model === 'parent')).toHaveLength(mode === 'nested' ? 2 : 5);
      expect(f.calls.filter((c) => c.model === 'child')).toHaveLength(mode === 'nested' ? 3 : 2);
      expect((await f.store.getExecution(carrier!.id))!.delivery).toBe('consumed');
      for (const run of [
        ...(await f.store.getView('root')).runs,
        ...(await f.store.getView(first.childSessionId!)).runs,
        ...(mode === 'nested' ? (await f.store.getView(carrier!.childSessionId!)).runs : []),
      ]) {
        const snapshot = (
          run.configuration as {
            snapshot?: { kind?: string; inputCommandId?: string; inputDigest?: string };
          }
        ).snapshot;
        if (snapshot?.kind === 'human_input_processing') {
          expect(mode).toBe('followup');
          expect(run).toMatchObject({ status: 'completed', reason: null, isActive: false });
          const raw = (await f.store.getCommand(snapshot.inputCommandId!))!;
          expect(raw).toMatchObject({
            kind: 'human.input',
            requestDigest: snapshot.inputDigest,
            request: { publicCommandId: 'followup-work' },
            receipt: { state: 'decided', processingCommandId: run.originCommandId },
          });
          const sealedReceipt = raw.receipt as {
            decisionCommandId: string;
            businessCommandId: string;
          };
          const decision = (await f.store.getCommand(sealedReceipt.decisionCommandId))!;
          expect(decision).toMatchObject({
            kind: 'human.input.decision',
            status: 'applied',
            sessionId: raw.sessionId,
            originStoreId: raw.originStoreId,
            subjectId: raw.subjectId,
            request: { inputCommandId: raw.id, inputDigest: raw.requestDigest },
            receipt: { businessCommandId: sealedReceipt.businessCommandId },
          });
          const publicCommand = (await f.store.getCommand('followup-work'))!;
          expect(publicCommand).toMatchObject({
            status: 'applied',
            receipt: {
              humanInputCommandId: raw.id,
              decisionCommandId: decision.id,
              businessCommandId: sealedReceipt.businessCommandId,
              runId: followupRunId,
            },
          });
          expect(await f.store.getCommand(sealedReceipt.businessCommandId)).toMatchObject({
            status: 'applied',
            sessionId: raw.sessionId,
            originStoreId: raw.originStoreId,
            subjectId: raw.subjectId,
            rootWorkCommandId: publicCommand.id,
            receipt: { runId: followupRunId },
          });
          const processingExecutions = (await f.store.listExecutions(run.sessionId)).filter(
            (execution) => execution.runId === run.id,
          );
          expect(processingExecutions).toHaveLength(1);
          const database = new Database(f.profile.databasePath, { readonly: true });
          try {
            for (const execution of processingExecutions) {
              expect(execution).toMatchObject({
                kind: 'model',
                status: 'failed',
                originCommandId: run.originCommandId,
                originStoreId: run.originStoreId,
                rootWorkCommandId: run.rootWorkCommandId,
                result: {
                  code: 'input_processing_decided',
                  dispatchCommitted: false,
                  incomplete: true,
                },
                input: { tools: [] },
                decisionSource: {
                  humanInputInterpretation: {
                    inputCommandId: raw.id,
                    inputDigest: raw.requestDigest,
                  },
                  continuation: {
                    runId: run.id,
                    humanInputProcessingContext: {
                      inputCommandId: raw.id,
                      inputDigest: raw.requestDigest,
                      content: (raw.request as { content: string }).content,
                    },
                  },
                  toolBindings: [],
                },
              });
              expect(
                database
                  .query('SELECT dispatched,dispatch_authorization_json FROM execution WHERE id=?')
                  .get(execution.id),
              ).toEqual({ dispatched: 0, dispatch_authorization_json: null });
            }
          } finally {
            database.close();
          }
          continue;
        }
        expect(readSkillSelection(run.configuration)).toEqual({
          requested: ['AlphaGuide'],
          resolvedIds: ['alpha'],
        });
      }
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
          approvals: f.approvals,
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
          childReports: childView
            ? await f.store.listPendingJobReports({
                ...f.identity,
                sessionId: childView.session.id,
              })
            : [],
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
