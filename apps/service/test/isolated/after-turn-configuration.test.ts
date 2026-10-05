import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AfterTurnPolicy, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
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
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('after_turn_configuration_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(mode: 'allow' | 'deny' | 'json_only') {
  const root = mkdtempSync(join(tmpdir(), 'kite-default-after-turn-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const childGate = gate(),
    phases: string[] = [],
    requests: Record<string, unknown>[] = [];
  const childBody = `original child result ${'c'.repeat(6000)} complete tail`;
  let unexpected = 0;
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
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const child = body.model === 'child';
      if (child) await childGate.promise;
      const messages = body.messages as { role: string; content: string | null }[];
      const call = !child && !messages.some((message) => message.role === 'tool');
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'actual-task',
                type: 'function',
                function: {
                  name: 'task',
                  arguments: JSON.stringify({
                    key: 'original-child',
                    role: 'worker',
                    input: { content: 'read' },
                    cancellation: 'detached',
                    resultDisposition: 'after_turn',
                  }),
                },
              },
            ],
          }
        : { content: child ? childBody : 'actual parent response' };
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'actual', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'parent',
    tools: [{ id: 'task', definitionVersion: '1' }],
    models: [
      { id: 'parent', provider: 'compatible', model: 'parent', baseURL: `${provider.url.href}v1` },
      { id: 'child', provider: 'compatible', model: 'child', baseURL: `${provider.url.href}v1` },
    ],
    // Preserved unknown config data is never a trusted callback or continuation authority.
    afterTurn: { enabled: true, allowed: true, revision: 'forged-json' },
  };
  writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
  const policy: AfterTurnPolicy = {
    async authorize(input) {
      input.signal.throwIfAborted();
      phases.push(input.phase);
      expect(Object.isFrozen(input.command)).toBe(true);
      expect(Object.isFrozen(input.execution)).toBe(true);
      expect(input.command.id).toBe('work');
      expect(input.execution.definitionId).toBe('task');
      expect(input.configuration.id).toBe('worker');
      expect(input.configuration.version).toBe('7');
      return { allowed: mode === 'allow', revision: 'trusted-explicit-after-turn-1' };
    },
  };
  const host = createDefaultProcessConfiguration({
    profile,
    child: [{ id: 'worker', version: '7', modelId: 'child', toolIds: [] }],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'actual-tool-policy' };
      },
    },
    ...(mode === 'json_only' ? {} : { afterTurn: policy }),
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    ...host,
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
    modelConcurrency: 1,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const identity = { expectedStoreId, subjectId: 'user', sessionId: 'root' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'temporary',
    rootUri: pathToFileURL(workspace).href,
  });
  await runtime.createSession({
    ...identity,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'actual after turn',
  });
  return {
    runtime,
    store,
    identity,
    requests,
    phases,
    childGate,
    childBody,
    policy,
    unexpected: () => unexpected,
    editLater() {
      writeFileSync(
        configurationPath,
        JSON.stringify({
          ...configuration,
          models: configuration.models.map((model) => ({
            ...model,
            baseURL: `${later.url.href}v1`,
          })),
        }),
      );
    },
    async close() {
      childGate.release();
      await runtime.close();
      provider.stop(true);
      later.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('default assembly explicitly binds trusted after_turn to its original immutable parent configuration and actual SDK child source', async () => {
  const f = await fixture('allow');
  try {
    await f.runtime.submitCommand({
      ...f.identity,
      commandId: 'work',
      request: { kind: 'run.start', content: 'work' },
    });
    expect((await f.runtime.waitForCommand('work', { timeoutMs: 7000 })).status).toBe('applied');
    await until(async () => f.requests.find((request) => request.model === 'child'));
    expect(f.phases).toEqual(['request']);
    expect((await f.runtime.getView('root')).runs.length).toBe(1);
    f.editLater();
    // A changed factory object is not substituted for the original leased binding.
    f.policy.authorize = async () => {
      throw new Error('new function must not replace original binding');
    };
    f.childGate.release();
    const report = await until(async () =>
      (await f.runtime.getView('root')).runs.find((run) =>
        run.originCommandId.startsWith('report-'),
      ),
    );
    await f.runtime.waitForCommand(report.originCommandId, { timeoutMs: 7000 });
    expect(f.phases).toEqual(['request', 'apply']);
    expect(f.unexpected()).toBe(0);
    expect(f.requests.filter((request) => request.model === 'parent').length).toBe(3);
    expect(f.requests.filter((request) => request.model === 'child').length).toBe(1);
    const actual = f.requests.at(-1)!.messages as { role: string; content: string | null }[];
    expect(actual.some((message) => message.content?.includes(f.childBody))).toBe(true);
    const view = await f.runtime.getView('root');
    expect(view.runs.every((run) => !run.isActive)).toBe(true);
    expect(view.runs.length).toBe(2);
    const carrier = view.executions.find(
      (execution) => execution.kind === 'job' && execution.childSessionId,
    );
    expect(carrier?.status).toBe('succeeded');
    const reportExecution = view.executions.find(
      (execution) => execution.kind === 'model' && execution.runId === report.id,
    );
    expect(reportExecution).toBeDefined();
    const input = await f.runtime.readModelInput({
      ...f.identity,
      executionId: reportExecution!.id,
    });
    expect(
      input.request.messages.some(
        (message) =>
          message.sourceIds?.some((id) => id.startsWith('result-')) &&
          message.content.includes(f.childBody),
      ),
    ).toBe(true);
    const before = await f.store.getMetadata();
    for (let n = 0; n < 3; n++)
      await f.runtime.readModelInput({ ...f.identity, executionId: reportExecution!.id });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
    expect(f.requests.length).toBe(4);
  } finally {
    await f.close();
  }
}, 15000);

test('a trusted deny or JSONC-only after_turn intent starts no child or report and never bypasses ordinary Tool authority', async () => {
  for (const mode of ['deny', 'json_only'] as const) {
    const f = await fixture(mode);
    try {
      await f.runtime.submitCommand({
        ...f.identity,
        commandId: 'work',
        request: { kind: 'run.start', content: 'work' },
      });
      expect((await f.runtime.waitForCommand('work', { timeoutMs: 7000 })).status).toBe('applied');
      const view = await f.runtime.getView('root');
      expect(view.runs.length).toBe(1);
      expect(view.executions.some((execution) => execution.kind === 'job')).toBe(false);
      expect(f.requests.some((request) => request.model === 'child')).toBe(false);
      expect(f.requests.length).toBe(2);
      expect(f.phases).toEqual(mode === 'deny' ? ['request'] : []);
      expect(f.unexpected()).toBe(0);
    } finally {
      await f.close();
    }
  }
}, 15000);
