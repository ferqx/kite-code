import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RuntimeOptions } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { estimateModelContext } from '@kite-ai/agent/context-estimate';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelRequest } from '@kite-ai/ai';
import { createSummaryCompressor } from '../../src/compression-configuration';

async function fixture(summary: string, options: Partial<RuntimeOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-compression-window-runtime-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const requests: ModelRequest[] = [];
  const original = 'Evidence '.repeat(2000);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'fixed',
    compressor: createSummaryCompressor({ automatic: { contextWindowTokens: 1000 } }),
    model: {
      async *stream(request) {
        requests.push(request);
        const summarizing = request.messages.some((message) =>
          message.content.startsWith('Summarize the preceding recorded conversation'),
        );
        yield { type: 'text_delta', text: summarizing ? summary : original };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 10, outputTokens: 10 } };
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    ...options,
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'window boundary',
  });
  return {
    store,
    runtime,
    requests,
    original,
    expectedStoreId,
    async run(commandId: string, content = 'Summarize what is known about this project') {
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId,
        subjectId: 'owner',
        request: { kind: 'run.start', content },
      });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      const receipt = command.receipt as { businessCommandId?: string; runId: string };
      const businessCommandId = content.startsWith('New task:')
        ? receipt.businessCommandId
        : command.id;
      expect(command.status).toBe('applied');
      expect(businessCommandId).toBeString();
      const run = (await store.getRun(receipt.runId))!;
      expect(run).toMatchObject({
        originCommandId: businessCommandId,
        rootWorkCommandId: command.id,
      });
      for (const model of (await store.listExecutions('s')).filter(
        (execution) => execution.kind === 'model' && execution.runId === run.id,
      ))
        expect(model).toMatchObject({
          originCommandId: businessCommandId,
          rootWorkCommandId: command.id,
        });
      return run;
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const scenario of [
  { reason: 'compression_not_reducing', summary: 'Evidence '.repeat(6000) },
  { reason: 'compression_insufficient_space', summary: 'Evidence '.repeat(1000) },
]) {
  test(`real Core stops at ${scenario.reason} without publishing or requesting another Model`, async () => {
    const f = await fixture(scenario.summary);
    try {
      expect((await f.run('seed')).status).toBe('completed');
      const before = await f.store.listMessages('s');
      const originalMessage = before.find((message) => message.role === 'assistant')!;
      expect(originalMessage).toBeDefined();
      const run = await f.run(
        'original-task',
        'New task: Summarize what is known about this project',
      );
      expect(run).toMatchObject({ status: 'failed', reason: scenario.reason });
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]!.tools).toHaveLength(0);
      expect(f.requests[1]!.messages.some((message) => message.content === f.original)).toBe(true);
      const selected = await f.store.getModelContext({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
      });
      expect(selected.compression).toBeUndefined();
      expect(selected.messages.some((message) => message.id === originalMessage.id)).toBe(true);
      const executions = (await f.store.listExecutions('s')).filter(
        (execution) => execution.runId === run.id,
      );
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({ kind: 'model', status: 'succeeded' });
      expect(
        (executions[0]!.decisionSource as { compressionId?: string }).compressionId,
      ).toBeString();
      const tokens = (content: string) =>
        estimateModelContext({ messages: [{ role: 'assistant', content }], tools: [] }).estimate
          .totalInputTokens;
      if (scenario.reason === 'compression_insufficient_space') {
        expect(tokens(scenario.summary)).toBeLessThan(tokens(f.original));
        expect(tokens(scenario.summary)).toBeGreaterThanOrEqual(750);
      }
      const after = await f.store.listMessages('s');
      expect(after.some((message) => message.id === originalMessage.id)).toBe(true);
      expect((await f.store.getView('s')).runs.find((value) => value.id === run.id)).toMatchObject({
        status: 'failed',
        reason: scenario.reason,
      });
      expect(f.requests).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
}

test('fixed source and Tool overhead above a tiny window fails the real Run with zero Model calls', async () => {
  const f = await fixture('must never be requested', {
    compressor: createSummaryCompressor({ automatic: { contextWindowTokens: 32 } }),
    sources: {
      async capture() {
        return [
          {
            id: 'mandatory-source',
            kind: 'instructions',
            scope: 'workspace',
            digest: 'owned',
            content: 'Mandatory system context. '.repeat(100),
          },
        ];
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.read',
            version: '1',
            description: 'Trusted read-only project observation',
            inputSchema: { type: 'object' },
            async execute() {
              throw Error('No Tool should be dispatched');
            },
          },
        ],
      },
    ],
  });
  try {
    const run = await f.run('tiny-window');
    expect(run).toMatchObject({ status: 'failed', reason: 'compression_insufficient_space' });
    expect(f.requests).toHaveLength(0);
    expect(await f.store.listExecutions('s')).toHaveLength(0);
    const context = await f.store.getModelContext({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
    });
    expect(context.compression).toBeUndefined();
  } finally {
    await f.close();
  }
});
