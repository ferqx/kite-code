import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

test('removed model reader cannot recover omitted receipts; compaction preserves unknown history without host replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-execution-evidence-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
  writeFileSync(join(root, 'user-dirty.txt'), 'pre-existing user content');
  let calls = 0,
    modelCalls = 0,
    summaries = 0;
  const requests: ModelRequest[] = [];
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model: ModelAdapter = {
    async *stream(request) {
      if (request.messages.some((message) => message.content === 'SUMMARIZE_EVIDENCE_FIXTURE')) {
        yield {
          type: 'text_delta',
          text: `Checkpoint ${summaries}: original paths and receipts deliberately omitted.`,
        };
        yield finish;
        return;
      }
      requests.push(request);
      const index = modelCalls++;
      expect(request.tools?.some((tool) => tool.id === 'read_execution_evidence')).toBe(false);
      if (index === 0) {
        yield { type: 'tool_call', id: 'once', name: 'fixture.edit', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        // A controlled model reports the missing evidence; this is not a real-model guarantee.
        yield {
          type: 'text_delta',
          text: 'Original receipt unavailable; outcome remains unknown.',
        };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    compressor: {
      id: 'fixture.evidence',
      version: '1',
      async shouldCompress() {
        return calls === 1 && summaries < 1;
      },
      async prepare() {
        summaries++;
        return { instructions: 'SUMMARIZE_EVIDENCE_FIXTURE', snapshot: { summaries } };
      },
    },
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.edit',
            version: '1',
            description: 'Actual unknown file publication',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            async execute() {
              calls++;
              writeFileSync(join(root, 'agent.txt'), 'one actual effect');
              return {
                outcome: 'outcome_unknown',
                content: 'Publication occurred; original receipt is unconfirmed.',
              };
            },
          },
        ],
      },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'workspace',
      title: 'Evidence',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: {
        kind: 'run.start',
        content: 'Inspect the original operation evidence; preserve user changes.',
      },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(summaries).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(
      requests[1]!.messages.some((message) =>
        message.content.includes('original paths and receipts deliberately omitted'),
      ),
    ).toBe(true);
    expect(
      (await store.listExecutions('session')).some(
        (entry) => entry.definitionId === 'execution_evidence.read',
      ),
    ).toBe(false);
    const original = (await store.listExecutions('session')).find(
      (entry) => entry.definitionId === 'fixture.edit',
    )!;
    expect(original.result).toMatchObject({
      outcome: 'outcome_unknown',
      content: 'Publication occurred; original receipt is unconfirmed.',
    });
    expect(readFileSync(join(root, 'user-dirty.txt'), 'utf8')).toBe('pre-existing user content');
    expect(readFileSync(join(root, 'agent.txt'), 'utf8')).toBe('one actual effect');
    expect(calls).toBe(1);
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
