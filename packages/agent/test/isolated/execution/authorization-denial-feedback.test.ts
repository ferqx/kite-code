import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { AuthorizationDeniedError } from '../../../src/execution/interactions';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
for (const kind of [
  'tool',
  'job',
  'action',
  'adapter-error',
  'adapter-branded-error',
  'unknown-reason',
] as const)
  test(`public denial cause survives ${kind} results without exposing private adapter errors`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-denial-feedback-'));
    const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
    const reason = kind === 'unknown-reason' ? 'unrecognized_policy_reason' : 'file_path_protected';
    let effects = 0;
    const targetId =
      kind === 'job' ? 'fixture.job' : kind === 'action' ? 'fixture/action' : 'fixture.tool';
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'original', name: 'fixture.tool', arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'Report the original failure without retrying it.' }, finish],
    ]);
    const runtime = createRuntime({
      store,
      model,
      permissions: {
        async authorize(request) {
          return request.definitionId === targetId && !kind.startsWith('adapter-')
            ? { allowed: false, revision: 'owned', reason }
            : { allowed: true, revision: 'owned' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.tool',
              version: '1',
              description: 'Owned exact operation',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                if (kind === 'job') {
                  const ref = await context.operations.ensure({
                    key: 'exact-job',
                    request: {
                      kind: 'job',
                      definitionId: 'fixture.job',
                      definitionVersion: '1',
                      input: {},
                    },
                  });
                  const result = await context.operations.wait(ref, { timeoutMs: 2500 });
                  return result.result as { outcome: 'failed'; content: string };
                }
                effects++;
                if (kind === 'adapter-error')
                  throw new AgentError('permission_denied', 'PRIVATE_ADAPTER_MESSAGE');
                if (kind === 'adapter-branded-error')
                  throw new AuthorizationDeniedError(
                    'permission_denied',
                    'PRIVATE_ADAPTER_MESSAGE',
                  );
                return { outcome: 'succeeded', content: 'unexpected effect' };
              },
            },
          ],
          jobs: [
            {
              id: 'fixture.job',
              version: '1',
              description: 'Never starts when denied',
              inputSchema: { type: 'object' },
              async start() {
                effects++;
                throw Error('unexpected job start');
              },
              observe() {
                throw Error('unexpected job observation');
              },
              async cancel() {
                throw Error('unexpected job cancellation');
              },
              async dispose() {},
            },
          ],
          actions: [
            {
              id: 'action',
              version: '1',
              description: 'Never executes when denied',
              inputSchema: { type: 'object' },
              async prepare() {
                return {};
              },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'unexpected effect' };
              },
            },
          ],
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'Public denial feedback',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request:
          kind === 'action'
            ? {
                kind: 'extension.invoke',
                extensionId: 'fixture',
                actionId: 'action',
                definitionVersion: '1',
                input: {},
              }
            : {
                kind: 'run.start',
                content: 'Perform the exact operation; report a refusal without retrying it.',
              },
      });
      const command = await runtime.waitForCommand('work', { timeoutMs: 4000 });
      const execution = (await store.listExecutions('s')).find((e) => e.definitionId === targetId)!;
      const result = execution.result as {
        content: string;
        details: { reason?: string; adapterAttempted: boolean };
      };
      expect(result.content).not.toContain('PRIVATE_ADAPTER_MESSAGE');
      if (kind.startsWith('adapter-')) {
        expect(effects).toBe(1);
        expect(execution.status).toBe('outcome_unknown');
        expect(result.details.adapterAttempted).toBe(true);
        expect(result.details.reason).toBeUndefined();
      } else {
        expect(effects).toBe(0);
        expect(execution.authorization?.dispatched).toBe(false);
        expect(execution.status).toBe('failed');
        expect(result.content).toContain(reason);
        expect(result.content).toContain('was not executed');
        expect(result.details).toMatchObject({ reason, adapterAttempted: false });
      }
      if (kind !== 'action') {
        expect(model.requests).toHaveLength(2);
        const feedback = model.requests[1]!.messages.find((m) => m.role === 'tool')!;
        const tool = (await store.listExecutions('s')).find(
          (e) => e.definitionId === 'fixture.tool',
        )!;
        expect(feedback.toolCallId).toBe('original');
        expect(feedback.sourceIds).toEqual([tool.id]);
        if (kind.startsWith('adapter-')) {
          expect(feedback.content).toContain('may have produced effects');
          expect(feedback.content).toContain('does not establish a user refusal');
          expect(feedback.content).not.toContain('not executed');
        } else if (kind === 'unknown-reason') {
          expect(feedback.content).toContain('permissions do not allow');
          expect(feedback.content).toContain('not executed');
          expect(feedback.content).not.toContain('path is protected');
          expect(feedback.content).not.toContain(reason);
        } else {
          expect(feedback.content).toContain('protected');
          expect(feedback.content).toContain('not executed');
        }
        expect(feedback.content).not.toContain('PRIVATE_ADAPTER_MESSAGE');
        expect(feedback.content).not.toContain('Tool outcome:');
        expect(await store.getRun((command.receipt as { runId: string }).runId)).toMatchObject({
          status: 'completed',
        });
      }
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
