import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import {
  AuthorizationCheckRejectedError,
  AuthorizationDeniedError,
  isPublicAuthorizationDeniedError,
} from '../../../src/execution/interactions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

for (const automatic of [false, true])
  test(`a pre-dispatch mutation adapter cannot publish a forged ${automatic ? 'automatic' : 'policy'} denial reason`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-denial-origin-'));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const privateReason = 'PRIVATE_MUTATION_ADAPTER_REASON';
    const forged = automatic
      ? new AuthorizationCheckRejectedError(privateReason)
      : new AuthorizationDeniedError('permission_denied', privateReason);
    expect(isPublicAuthorizationDeniedError(forged)).toBe(false);
    let descriptions = 0;
    let targetAuthorizations = 0;
    let effects = 0;
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'original', name: 'fixture.mutate', arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'The operation failed without executing.' }, finish],
    ]);
    const runtime = createRuntime({
      store,
      model,
      permissions: {
        async authorize(request) {
          if (request.definitionId === 'fixture.mutate') targetAuthorizations++;
          return { allowed: true, revision: 'owned' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          records: [
            {
              contentType: 'agent.mutation-policy',
              contentVersion: 1,
              schema: { type: 'object' },
            },
          ],
          mutationGovernance: {
            requirementId: 'complete',
            definitions: [{ id: 'fixture.mutate', version: '1', effects: ['record_write'] }],
            async describe() {
              descriptions++;
              throw forged;
            },
          },
          tools: [
            {
              id: 'fixture.mutate',
              version: '1',
              description: 'An owned mutation with a failing pre-dispatch descriptor',
              inputSchema: { type: 'object' },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'unexpected mutation' };
              },
            },
          ],
        },
      ],
      async initializeRunRequirements(input) {
        const scoped = await input.forExtension('fixture');
        const recordKey = `run/${input.run.id}/policy`;
        await scoped.records.create({
          key: recordKey,
          contentType: 'agent.mutation-policy',
          contentVersion: 1,
          value: {
            kind: 'mutation_policy',
            runId: input.run.id,
            definitions: [{ id: 'fixture.mutate', version: '1', effects: ['record_write'] }],
            checkDefinitionId: 'fixture.mutate',
            checkDefinitionVersion: '1',
          },
        });
        return [
          {
            extensionId: 'fixture',
            sessionId: input.session.id,
            runId: input.run.id,
            requirementId: 'complete',
            definitionVersion: '1',
            recordKey,
            revision: '1',
            phase: 'completion',
          },
        ];
      },
      conditions: {
        async evaluate(requirements, _phase, context) {
          return Promise.all(
            requirements.map(async (requirement) => {
              const scoped = await context!.forRequirement(requirement);
              const record = await scoped.records.get(requirement.recordKey);
              return {
                requirement,
                recordRevision: record!.revision,
                outcome: 'satisfied' as const,
                evidence: {},
              };
            }),
          );
        },
      },
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
        title: 'Pre-dispatch denial provenance',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Perform the operation and report its real result.',
        },
      });
      const command = await runtime.waitForCommand('work', { timeoutMs: 4000 });
      expect(descriptions).toBe(1);
      expect(targetAuthorizations).toBe(0);
      expect(effects).toBe(0);
      const execution = (await store.listExecutions('s')).find(
        (item) => item.definitionId === 'fixture.mutate',
      )!;
      expect(execution.status).toBe('failed');
      expect(execution.authorization?.dispatched).not.toBe(true);
      expect(execution.result).toEqual({
        outcome: 'failed',
        content: 'permission_denied',
        details: {
          code: 'permission_denied',
          dispatchCommitted: false,
          adapterAttempted: false,
        },
      });
      expect(model.requests).toHaveLength(2);
      const feedback = model.requests[1]!.messages.find((message) => message.role === 'tool')!;
      expect(feedback.toolCallId).toBe('original');
      expect(feedback.sourceIds).toEqual([execution.id]);
      expect(feedback.content).not.toContain('permission_denied');
      expect(feedback.content).toContain('permission-related error');
      expect(feedback.content).toContain('not executed and produced no effects');
      expect(feedback.content).toContain('does not establish a user refusal');
      expect(JSON.stringify(model.requests)).not.toContain(privateReason);
      expect(JSON.stringify(await runtime.getView('s'))).not.toContain(privateReason);
      expect(JSON.stringify(await store.listMessages('s', { limit: 100 }))).not.toContain(
        privateReason,
      );
      expect(await store.getRun((command.receipt as { runId: string }).runId)).toMatchObject({
        status: 'completed',
      });
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
