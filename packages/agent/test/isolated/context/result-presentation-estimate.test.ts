import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import type { Extension, ToolDefinition } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;

for (const mode of ['run', 'step'] as const)
  test(`context forecast uses the captured ${mode} result presentation or explicitly declines, including cold reads`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-presentation-estimate-')));
    const profile = { dataRoot: root, profile: 'test' };
    let store = await openSqliteStore(profile);
    const scope = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    let calls = 0,
      resolutions = 0,
      capabilityReads = 0;
    const requests: ModelRequest[] = [];
    let releaseModel!: () => void;
    const modelRelease = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let modelEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      modelEntered = resolve;
    });
    const tool: ToolDefinition = {
      id: 'source',
      version: '1',
      description: 'source',
      inputSchema: { type: 'object' },
      model: { name: 'source', resultVersion: '1' },
      formatModelResult: () => 'SHORT',
      async execute() {
        calls++;
        return { outcome: 'succeeded', content: 'x'.repeat(200000) };
      },
    };
    const extension: Extension = { id: 'owned', version: '1', apiMajor: 1, tools: [tool] };
    let runtime: ReturnType<typeof createRuntime>;
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: 'tool_call', id: 'read', name: 'source', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        expect(request.messages.find((message) => message.role === 'tool')?.content).toBe('SHORT');
        modelEntered();
        await modelRelease;
        yield { type: 'text_delta', text: 'done' };
        yield finish;
      },
    };
    const permissions = { authorize: async () => ({ allowed: true, revision: 'owned' }) };
    runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      permissions,
      resolveRunConfiguration: async () => {
        resolutions++;
        return {
          model,
          modelId: 'fixed',
          snapshot: {},
          extensions: mode === 'run' ? [extension] : [],
          ...(mode === 'step'
            ? {
                readStepCapabilities: async () => {
                  capabilityReads++;
                  return { extensions: [extension], snapshot: { catalogue: 'selected' } };
                },
              }
            : {}),
        };
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: scope.expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 't' });
      await runtime.submitCommand({
        ...scope,
        commandId: 'start',
        request: { kind: 'run.start', content: 'Read once.' },
      });
      await entered;
      const liveInput = { ...scope, executionId: requests[1]!.requestId };
      const beforeLive = { resolutions, capabilityReads, calls };
      if (mode === 'run')
        expect((await runtime.readContextEstimate(liveInput)).totalInputTokens).toBeLessThan(1000);
      expect({ resolutions, capabilityReads, calls }).toEqual(beforeLive);
      releaseModel();
      const applied = await runtime.waitForCommand('start', { timeoutMs: 10000 });
      expect((await store.getRun((applied.receipt as { runId: string }).runId))?.status).toBe(
        'completed',
      );
      expect(calls).toBe(1);
      expect(requests).toHaveLength(2);
      const input = { ...scope, executionId: requests[1]!.requestId };
      if (mode === 'step')
        expect(
          await runtime.readContextEstimate({ ...input, executionId: requests[0]!.requestId }).then(
            () => null,
            (error: { code: string }) => error.code,
          ),
        ).toBe('context_estimate_unavailable');
      await runtime.close();
      store = await openSqliteStore(profile);
      runtime = createRuntime({ store, model, modelId: 'fixed', permissions });
      const before = { resolutions, capabilityReads, calls, models: requests.length };
      expect(
        await runtime.readContextEstimate(input).then(
          () => null,
          (error: { code: string }) => error.code,
        ),
      ).toBe('context_estimate_unavailable');
      expect((await runtime.readModelInput(input)).request).toEqual(requests[1]!);
      expect({ resolutions, capabilityReads, calls, models: requests.length }).toEqual(before);
      await runtime.close();
      store = await openSqliteStore(profile);
      // Matching retained definitions permit a cold forecast of the original Run
      // contract. Step-only registrations remain unprovable without their binding.
      runtime = createRuntime({
        store,
        model,
        modelId: 'fixed',
        permissions,
        extensions: [extension],
      });
      if (mode === 'run')
        expect((await runtime.readContextEstimate(input)).totalInputTokens).toBeLessThan(1000);
      else
        expect(
          await runtime.readContextEstimate(input).then(
            () => null,
            (error: { code: string }) => error.code,
          ),
        ).toBe('context_estimate_unavailable');
      await runtime.close();
      store = await openSqliteStore(profile);
      runtime = createRuntime({
        store,
        model,
        modelId: 'fixed',
        permissions,
        extensions: [
          { ...extension, tools: [{ ...tool, model: { ...tool.model!, resultVersion: '2' } }] },
        ],
      });
      expect(
        await runtime.readContextEstimate(input).then(
          () => null,
          (error: { code: string }) => error.code,
        ),
      ).toBe('context_estimate_unavailable');
    } finally {
      releaseModel();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
