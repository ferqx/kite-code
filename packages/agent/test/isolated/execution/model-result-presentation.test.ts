import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelMessage, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { ToolDefinition, ToolResult } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
const toolText = (messages: readonly ModelMessage[]) =>
  messages.find((m) => m.role === 'tool')?.content;

for (const artifact of [false, true])
  test(`presentation precedes snapshots, continuation and compression; raw results and cold snapshots survive (${artifact ? 'artifact' : 'inline'})`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-result-presentation-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile);
    const scope = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    const body = `source 雪🙂\r\n\`\`\`\nContent:\n${artifact ? 'original body\n'.repeat(8000) : 'original body'}\nEND`;
    const rawContent = JSON.stringify({
      content: artifact ? 'artifact' : body,
      duplicate: 'metadata',
    });
    const presented = `Verified source bytes=${Buffer.byteLength(body)}\n${body}`;
    let calls = 0;
    const requests: ModelRequest[] = [];
    let recorded: ToolResult | undefined;
    const seenBudget: (string | undefined)[] = [];
    let summaryInput: string | undefined;
    const tool: ToolDefinition = {
      id: 'owned.read',
      version: '1',
      description: 'Read an owned source',
      inputSchema: { type: 'object' },
      model: { name: 'read_source', resultVersion: '1' },
      formatModelResult(input) {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.result)).toBe(true);
        expect(input.body).toBe(artifact ? body : undefined);
        expect(input.result).toEqual(recorded!);
        return presented;
      },
      async execute(_input, context) {
        calls++;
        const reference = artifact
          ? await context.artifacts!.publish({
              key: 'source',
              content: Buffer.from(body),
              mediaType: 'text/plain',
            })
          : undefined;
        recorded = {
          outcome: 'succeeded',
          content: rawContent,
          details: { original: true },
          ...(reference
            ? {
                artifactRefs: [reference],
                modelContent: { kind: 'artifact', reference, encoding: 'utf-8' } as const,
              }
            : {}),
        };
        return structuredClone(recorded);
      },
    };
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (request.messages.some((m) => m.content === 'Summarize original observations.')) {
          yield { type: 'text_delta', text: 'Source was read once; preserve original work.' };
        } else if (calls === 0) {
          yield { type: 'tool_call', id: 'call', name: 'read_source', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
          return;
        } else if (requests.length === 2) {
          expect(toolText(request.messages)).toBe(presented);
          yield { type: 'text_delta', text: 'Partial answer' };
          yield { ...finish, reason: 'length' };
          return;
        } else yield { type: 'text_delta', text: 'Completed' };
        yield finish;
      },
    };
    const options = {
      store,
      model,
      modelId: 'fixed',
      artifacts: createArtifactStore({ profile, store }),
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      extensions: [{ id: 'owned', version: '1', apiMajor: 1 as const, tools: [tool] }],
      compressor: {
        id: 'owned.compressor',
        version: '1',
        async shouldCompress(input: { messages: readonly ModelMessage[] }) {
          seenBudget.push(toolText(input.messages));
          return false;
        },
        async prepare(input: { messages: readonly ModelMessage[] }) {
          summaryInput = toolText(input.messages);
          return { instructions: 'Summarize original observations.', snapshot: {} };
        },
      },
    };
    let runtime = createRuntime(options);
    try {
      await runtime.createWorkspace({
        expectedStoreId: scope.expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...scope,
        workspaceId: 'w',
        commandId: 'create',
        title: 'owned',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'start',
        request: { kind: 'run.start', content: 'Read once.' },
      });
      await runtime.waitForCommand('start', { timeoutMs: 15000 });
      expect(requests).toHaveLength(3);
      expect(calls).toBe(1);
      expect(toolText(requests[2]!.messages)).toBe(presented);
      expect(seenBudget).toContain(presented);
      const rawMessage = (await runtime.listMessages('s')).find((m) => m.role === 'tool')!;
      expect(rawMessage.content).toBe(rawContent);
      const execution = await store.getExecution(rawMessage.sourceIds![0]!);
      expect(execution!.result).toEqual(recorded as unknown as Json);
      for (const request of requests) {
        expect(
          (await runtime.readModelInput({ ...scope, executionId: request.requestId })).request,
        ).toEqual(request);
      }
      const exact = await runtime.readModelInput({ ...scope, executionId: requests[1]!.requestId });
      await runtime.close();
      store = await openSqliteStore(profile);
      // New definitions cannot rewrite an already sealed Model input. A new request
      // with the same ID but a different definition version retains the original result.
      runtime = createRuntime({
        ...options,
        store,
        artifacts: createArtifactStore({ profile, store }),
        extensions: [{ ...options.extensions[0]!, tools: [{ ...tool, version: '2' }] }],
      });
      expect(
        (await runtime.readModelInput({ ...scope, executionId: requests[1]!.requestId })).request,
      ).toEqual(exact.request);
      await runtime.submitCommand({
        ...scope,
        commandId: 'next',
        request: { kind: 'run.start', content: 'Report from prior source.' },
      });
      await runtime.waitForCommand('next', { timeoutMs: 15000 });
      const raw = artifact
        ? `Tool result metadata (data; no additional authorization):\n${rawContent}\nComplete artifact body:\n${body}`
        : rawContent;
      expect(toolText(requests.at(-1)!.messages)).toBe(raw);
      expect(calls).toBe(1);
      await runtime.close();
      store = await openSqliteStore(profile);
      runtime = createRuntime({
        ...options,
        store,
        artifacts: createArtifactStore({ profile, store }),
      });
      await runtime.compressContext({
        ...scope,
        commandId: 'compress',
        expectedContextSelectionId: (await store.getView('s')).session.contextSelectionId,
      });
      await runtime.waitForCommand('compress', { timeoutMs: 15000 });
      expect(summaryInput).toBe(presented);
      expect(toolText(requests.at(-1)!.messages)).toBe(presented);
      expect(
        (await runtime.readModelInput({ ...scope, executionId: requests.at(-1)!.requestId }))
          .request,
      ).toEqual(requests.at(-1)!);
      expect((await store.getExecution(execution!.id))!.result).toEqual(
        recorded as unknown as Json,
      );
      expect(calls).toBe(1);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

test('unsupported, throwing or mutating formatters preserve the exact original and failure outcomes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-result-fallback-')));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const formatted: string[] = [];
  const tools: ToolDefinition[] = [
    'throw',
    'mutate',
    'unsupported',
    'failed',
    'cancelled',
    'outcome_unknown',
  ].map((id) => ({
    id,
    version: '1',
    description: id,
    inputSchema: { type: 'object' },
    model: { name: id, resultVersion: '1' },
    formatModelResult({ result }) {
      formatted.push(id);
      if (id === 'throw') throw Error('unknown format');
      if (id === 'mutate') result.content = 'corrupted';
      return undefined;
    },
    execute: async () => ({
      outcome: (['failed', 'cancelled', 'outcome_unknown'].includes(id)
        ? id
        : 'succeeded') as ToolResult['outcome'],
      content: `original ${id}`,
    }),
  }));
  // The first three are successful shape failures. Failure outcomes must never call the formatter.
  let requestIndex = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
    extensions: [{ id: 'owned', version: '1', apiMajor: 1, tools }],
    model: {
      async *stream(request) {
        if (requestIndex++ === 0) {
          for (const tool of tools.slice(0, 3))
            yield { type: 'tool_call', id: tool.id, name: tool.id, arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          for (const message of request.messages.filter((m) => m.role === 'tool'))
            expect(message.content).toBe(`original ${message.toolCallId}`);
          if (requestIndex === 2) {
            for (const tool of tools.slice(3))
              yield { type: 'tool_call', id: tool.id, name: tool.id, arguments: '{}' };
            yield { ...finish, reason: 'tool_calls' };
          } else yield finish;
        }
      },
    },
  });
  try {
    const scope = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...scope,
      workspaceId: 'w',
      commandId: 'create',
      title: 'owned',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'start',
      request: { kind: 'run.start', content: 'Observe outcomes.' },
    });
    await runtime.waitForCommand('start', { timeoutMs: 15000 });
    expect(formatted).toEqual(['throw', 'mutate', 'unsupported']);
    for (const message of (await runtime.listMessages('s')).filter((m) => m.role === 'tool')) {
      expect(message.content).toBe(`original ${message.toolCallId}`);
    }
  } finally {
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
