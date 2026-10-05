import { expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { defineExtension, type Json } from '../../../src/extensions';
import { createProjectSources } from '../../../src/sources';
import { openSqliteStore } from '../../../src/sqlite';

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(id: string, value: string): ModelEvent[] {
  return [
    {
      type: 'tool_call',
      id,
      name: 'fixture.write',
      arguments: JSON.stringify({ path: 'src/output.txt', value }),
    },
    { ...finish, reason: 'tool_calls' },
  ];
}

test.each([
  'addition',
  'rewrite',
  'deletion',
  'unrelated',
] as const)('real model source refresh at tool permission barrier prevents old effects: %s', async (change) => {
  const root = mkdtempSync(join(tmpdir(), 'kite-model-sources-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'unrelated'));
  const rootInstruction = join(root, 'AGENTS.md');
  writeFileSync(rootInstruction, 'old rule');
  const ledger = join(root, 'external-ledger.jsonl');
  const entered = barrier();
  const proceed = barrier();
  let enteredOnce = false;
  const executions: Json[] = [];
  const relevant = change !== 'unrelated';
  const finalValue = change === 'deletion' ? 'absent' : relevant ? 'new' : 'old';
  const model = createFixedModel(
    relevant
      ? [call('old-call', 'old'), call('new-call', finalValue), [finish]]
      : [call('old-call', 'old'), [finish]],
  );
  const extension = defineExtension({
    id: 'fixture.model-sources',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.write',
        version: '1',
        description: 'Bounded counted file effect',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, value: { type: 'string' } },
          required: ['path', 'value'],
          additionalProperties: false,
        },
        async execute(input, context) {
          context.signal.throwIfAborted();
          executions.push(structuredClone(input));
          appendFileSync(ledger, `${JSON.stringify(input)}\n`);
          return { outcome: 'succeeded', content: 'effect complete' };
        },
      },
    ],
  });
  const store = await openSqliteStore({ dataRoot: join(root, 'profile'), profile: 'disposable' });
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [extension],
    sources: createProjectSources({
      async workspaceRoot() {
        return root;
      },
      targetPaths(request) {
        const input = request.input;
        // Only this host recognizes and authorizes this structured tool target.
        return request.definitionId === 'fixture.write' &&
          input &&
          typeof input === 'object' &&
          !Array.isArray(input) &&
          input.path === 'src/output.txt'
          ? ['src/output.txt']
          : [];
      },
    }),
    permissions: {
      async authorize(request) {
        if (request.definitionId === 'fixture.write' && !enteredOnce) {
          enteredOnce = true;
          entered.release();
          await proceed.waiting;
        }
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const metadata = await store.getMetadata();
    await runtime.createWorkspace({
      expectedStoreId: metadata.storeId,
      id: 'workspace',
      rootUri: `file://${root}`,
      name: 'Disposable',
    });
    await runtime.createSession({
      expectedStoreId: metadata.storeId,
      commandId: 'create',
      sessionId: 'session',
      workspaceId: 'workspace',
      title: 'Model',
      subjectId: 'owner',
    });
    await runtime.submitCommand({
      expectedStoreId: metadata.storeId,
      commandId: 'work',
      sessionId: 'session',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Write according to current instructions' },
    });
    await entered.waiting;
    expect(executions).toHaveLength(0);
    expect(existsSync(ledger)).toBe(false);
    expect(model.requests).toHaveLength(1);
    const originalModel = await store.getExecution(model.requests[0]!.requestId);
    expect(originalModel!.decisionSource).toMatchObject({
      kind: 'model_request',
      sources: [{ content: 'old rule' }],
    });
    if (change === 'addition') writeFileSync(join(root, 'src/AGENTS.md'), 'new rule');
    else if (change === 'rewrite') {
      const before = statSync(rootInstruction);
      writeFileSync(rootInstruction, 'new rule');
      utimesSync(rootInstruction, before.atime, before.mtime);
      expect(statSync(rootInstruction).size).toBe(before.size);
    } else if (change === 'deletion') rmSync(rootInstruction);
    else writeFileSync(join(root, 'unrelated/AGENTS.md'), 'unrelated rule');
    proceed.release();
    await runtime.waitForCommand('work', { timeoutMs: 3000 });
    expect(executions).toEqual([{ path: 'src/output.txt', value: finalValue }]);
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(model.requests).toHaveLength(relevant ? 3 : 2);
    const nextInstructions = model.requests[1]!.messages.filter(
      (message) => message.role === 'system',
    ).map((message) => message.content);
    expect(nextInstructions).toEqual(
      change === 'addition'
        ? ['old rule', 'new rule']
        : change === 'deletion'
          ? []
          : [relevant ? 'new rule' : 'old rule'],
    );
    expect(await store.getExecution(model.requests[0]!.requestId)).toEqual(originalModel);
    const nextModel = await store.getExecution(model.requests[1]!.requestId);
    const source = nextModel!.decisionSource as { sources: { content: string }[] };
    expect(source.sources.map((item) => item.content)).toEqual(nextInstructions);
    const view = await store.getView('session');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]!.status).toBe('completed');
    const tools = view.executions.filter((execution) => execution.kind === 'tool');
    expect(tools).toHaveLength(relevant ? 2 : 1);
    if (relevant) {
      const oldTool = tools.find((execution) => execution.callId === 'old-call')!;
      expect(oldTool).toMatchObject({
        status: 'failed',
        result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
      });
      expect(tools.find((execution) => execution.callId === 'new-call')!.input).toEqual({
        path: 'src/output.txt',
        value: finalValue,
      });
    }
  } finally {
    proceed.release();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
