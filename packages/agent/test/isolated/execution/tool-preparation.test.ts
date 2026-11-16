import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension, ToolDefinition } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { TrustedToolBehavior } from '../../../src/tool-behavior';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
for (const scenario of ['allow', 'hard-deny', 'revoke', 'prepare-error', 'invalid-input'] as const)
  test(`Core private preparation preserves hard gates, dispatch and disposal: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-private-preparation-'));
    const profile = { dataRoot: root, profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const canary = 'PRIVATE_PREPARATION_BODY_937';
    let prepared = 0,
      released = 0,
      disposed = 0,
      rawExecutions = 0,
      revoked = false;
    const tool: ToolDefinition = {
      id: 'fixture.private_read',
      version: '1',
      description: 'private read fixture',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      async execute() {
        rawExecutions++;
        throw Error('raw execution must not run');
      },
    };
    const extension: Extension = { id: 'fixture', version: '1', apiMajor: 1, tools: [tool] };
    const behavior: TrustedToolBehavior = {
      definition: tool,
      capability: { kind: 'tool', definitionId: tool.id, definitionVersion: tool.version },
      contractRef: 'fixture.private-read',
      configurationDigest: 'c'.repeat(64),
      async prepareTool() {
        prepared++;
        if (scenario === 'prepare-error') throw Error(canary);
        if (scenario === 'revoke') revoked = true;
        return {
          dispose() {
            disposed++;
          },
          async execute(context) {
            const row = await store.getExecution(context.executionId);
            expect(row?.status).toBe('dispatching');
            expect(context.dispatchAuthorization?.revision).toBeDefined();
            released++;
            return { outcome: 'succeeded', content: canary };
          },
        };
      },
    };
    const model = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'read',
          name: tool.id,
          arguments: JSON.stringify(scenario === 'invalid-input' ? {} : { path: 'owned' }),
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'Finished without retry.' }, finish],
    ]);
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      extensions: [extension],
      toolBehaviors: [behavior],
      artifacts: createArtifactStore({ profile, store }),
      permissions: {
        async authorize(request) {
          return request.kind === 'tool' && (scenario === 'hard-deny' || revoked)
            ? { allowed: false, revision: 'hard-deny', reason: 'fixture_revoked' }
            : { allowed: true, revision: 'allowed' };
        },
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private-read',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 's',
        commandId: 'create',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'private-read',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Read only the owned fixture; do not retry.' },
      });
      await runtime.waitForCommand('work');
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Read only the owned fixture; do not retry.' },
      });
      await runtime.waitForCommand('work');
      expect(rawExecutions).toBe(0);
      expect(prepared).toBe(['hard-deny', 'invalid-input'].includes(scenario) ? 0 : 1);
      expect(disposed).toBe(['allow', 'revoke'].includes(scenario) ? 1 : 0);
      expect(released).toBe(scenario === 'allow' ? 1 : 0);
      const row = (await store.listExecutions('s')).find((value) => value.kind === 'tool')!;
      expect(row.authorization?.dispatched === true).toBe(scenario === 'allow');
      expect(JSON.stringify(row.result).includes(canary)).toBe(scenario === 'allow');
      expect(JSON.stringify(model.requests).includes(canary)).toBe(scenario === 'allow');
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
