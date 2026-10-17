import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { canonicalJson } from '../../../src/json';
import { jsonBody, type ModelBodyReference } from '../../../src/model-body';
import { readSourceRequestJournal } from '../../../src/source-request-journal';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError, type Json } from '../../../src/storage/types';

test('a long real Run seals source inputs as linear deltas and preserves every capture after host mutation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-source-journal-')));
  const profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const total = 128;
  const payload = 'original-source-evidence:'.repeat(64);
  let models = 0,
    effects = 0,
    largestCapture = 0;
  const finish: Extract<ModelEvent, { type: 'finish' }> = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model: ModelAdapter = {
    async *stream() {
      const index = models++;
      if (index < total) {
        yield {
          type: 'tool_call',
          id: `call-${index}`,
          name: 'fixture.read',
          arguments: JSON.stringify({ index, payload }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixed' };
      },
    },
    sources: {
      async capture() {
        return [];
      },
      async captureBatch(requests) {
        const tools = requests.filter((request) => request.definitionId === 'fixture.read');
        largestCapture = Math.max(largestCapture, tools.length);
        for (const request of tools) {
          const input = request.input as { index: number; payload: string };
          if (input.payload !== payload || !Number.isInteger(input.index))
            throw new AgentError('fixture_source_input_changed');
          // The trusted host receives its own capture copy, never the retained checkpoint value.
          input.payload = 'host-local mutation';
        }
        return [];
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
            description: 'Observe one original input',
            inputSchema: { type: 'object' },
            async execute(input) {
              if ((input as { payload: string }).payload !== payload)
                throw new Error('original input lost');
              effects++;
              return { outcome: 'succeeded', content: 'observed' };
            },
          },
        ],
      },
    ],
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'w',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'journal',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Observe the original inputs once.' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 30000 });
    const runId = (command.receipt as { runId: string }).runId;
    expect(await store.getRun(runId)).toMatchObject({ status: 'completed', isActive: false });
    expect(models).toBe(total + 1);
    expect(effects).toBe(total);
    expect(largestCapture).toBe(total);
    const reader = new Database(join(root, 'test', 'core.db'), { readonly: true });
    const checkpoints = reader
      .query<{ decision_source_json: string }, []>(
        "SELECT decision_source_json FROM execution WHERE session_id='s' AND kind='model' ORDER BY rowid",
      )
      .all()
      .map((item) => JSON.parse(item.decision_source_json).continuation as Record<string, Json>);
    reader.close(true);
    expect(checkpoints).toHaveLength(total + 1);
    expect(
      checkpoints.every((item) => item.version === 3 && item.sourceRequests === undefined),
    ).toBe(true);
    expect(checkpoints.every((item) => Buffer.byteLength(canonicalJson(item)) < 1200)).toBe(true);
    const finalHead = checkpoints.at(-1)!.sourceRequestJournal!;
    const identity = {
      storeId: expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      workspaceId: 'w',
      runId,
    };
    let journalBytes = 0,
      journalNodes = 0;
    const restored = await readSourceRequestJournal(
      finalHead,
      identity,
      async (reference) => {
        const content = await artifacts.readReference({ expectedStoreId, reference });
        journalBytes += content.byteLength;
        journalNodes++;
        return jsonBody(content);
      },
      new AbortController().signal,
    );
    expect(restored.map((request) => (request.input as { index: number }).index)).toEqual(
      Array.from({ length: total }, (_, index) => index),
    );
    expect(
      restored.every((request) => (request.input as { payload: string }).payload === payload),
    ).toBe(true);
    expect(journalNodes).toBe(total);
    expect(journalBytes).toBeLessThan(total * (Buffer.byteLength(payload) + 1600));
    const head = finalHead as unknown as ModelBodyReference;
    for (const changed of [
      { ...identity, runId: 'foreign' },
      { ...identity, subjectId: 'foreign' },
    ]) {
      const error = await readSourceRequestJournal(
        finalHead,
        changed,
        async (reference) =>
          jsonBody(await artifacts.readReference({ expectedStoreId, reference })),
        new AbortController().signal,
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'run_continuation_invalid' });
    }
    const loopError = await readSourceRequestJournal(
      finalHead,
      identity,
      async () => ({
        version: 1,
        runId,
        sessionId: 's',
        workspaceId: 'w',
        previous: head as unknown as Json,
        requests: [restored[0] as unknown as Json],
      }),
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(loopError).toMatchObject({ code: 'run_continuation_invalid' });
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 40000);
