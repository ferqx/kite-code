import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { semanticDigest } from '../../../src/json';
import { createPermissionPolicy, type PermissionMode } from '../../../src/permissions';
import { createRuntime, type RunConfiguration } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
export async function changeMode(store: Store, storeId: string, mode: PermissionMode) {
  const scope = 'session:s';
  const current = await store.readHostControl({
    expectedStoreId: storeId,
    subjectId: 'owner',
    kind: 'permission.mode',
    scope,
  });
  const safeRequest = {
    scope: 'session',
    sessionId: 's',
    mode,
    ifRevision: current.revision,
    makeDefault: false,
    ifDefaultRevision: '0',
  };
  const input = {
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: `mode-${mode}`,
    kind: 'permission.mode' as const,
    scope,
    safeRequest,
    requestDigest: await semanticDigest(safeRequest),
  };
  await store.beginHostMutation(input);
  await store.finishHostMutation({ ...input, state: 'applied', receipt: { status: 'applied' } });
  return store.readHostControl({
    expectedStoreId: storeId,
    subjectId: 'owner',
    kind: 'permission.mode',
    scope,
  });
}
export function approvalBinding(store: Store, storeId: string, root: string): RunConfiguration {
  const permissions = createPermissionPolicy({
    async readPolicy(request) {
      const session = (await store.getSession(request.sessionId))!;
      const scope = `session:${session.rootSessionId}`;
      const current = await store.readHostControl({
        expectedStoreId: storeId,
        subjectId: 'owner',
        kind: 'permission.mode',
        scope,
      });
      return {
        mode: (current.record?.safeRequest as { mode: PermissionMode })?.mode ?? 'accept_edits',
        workspaceTrust: true,
        revision: current.revision,
        controlReads: [{ kind: 'permission.mode', scope, revision: current.revision }],
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      };
    },
    describeCapability(request) {
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'capability1',
        effects: request.kind === 'model' ? ['read'] : ['external'],
        hardAllowed: true,
        safeRead: request.kind === 'model',
      };
    },
  });
  return {
    modelId: 'fixture',
    permissions,
    snapshot: { kind: 'live-approval-crash', version: 1 },
    model: {
      async *stream(request) {
        appendFileSync(join(root, 'ledger'), `model:${request.requestId}\n`);
        if (request.messages.some((message) => message.role === 'tool')) {
          yield finish;
          return;
        }
        yield {
          type: 'tool_call',
          id: 'call',
          name: 'fixture.effect',
          arguments: '{"value":"exact"}',
        };
        yield { ...finish, reason: 'tool_calls' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'exact external ledger effect',
            inputSchema: {
              type: 'object',
              required: ['value'],
              properties: { value: { type: 'string' } },
              additionalProperties: false,
            },
            async execute(input, context) {
              appendFileSync(
                join(root, 'ledger'),
                `effect:${context.executionId}:${JSON.stringify(input)}\n`,
              );
              return { outcome: 'succeeded', content: 'effect saved' };
            },
          },
        ],
      },
    ],
  };
}
if (import.meta.main) {
  const root = process.argv[2]!;
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await store.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 'fixture',
  });
  await changeMode(store, storeId, 'accept_edits');
  const binding = approvalBinding(store, storeId, root);
  const runtime = createRuntime({
    store,
    resolveRunConfiguration: async () => binding,
    permissions: binding.permissions!,
    artifacts: createArtifactStore({ profile, store }),
  });
  await runtime.submitCommand({
    expectedStoreId: storeId,
    subjectId: 'owner',
    sessionId: 's',
    commandId: 'work',
    request: { kind: 'run.start', content: 'perform exact effect' },
  });
  for (;;) {
    const interactions = await store.listInteractions({
      expectedStoreId: storeId,
      sessionId: 's',
      state: 'pending',
    });
    const card = interactions.interactions.find((value) => value.kind === 'approval');
    if (card) {
      const run = (await store.getRun(card.runId!))!,
        session = (await store.getSession('s'))!;
      console.log(
        JSON.stringify({
          storeId,
          runId: run.id,
          executionId: card.executionId,
          interactionId: card.id,
          interactionRevision: card.revision,
          expectedOwnerGeneration: session.ownerGeneration,
        }),
      );
      await new Promise<void>(() => {});
    }
    await Bun.sleep(5);
  }
}
