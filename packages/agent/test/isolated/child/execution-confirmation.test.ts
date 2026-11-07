import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type {
  Extension,
  OperationRef,
  PermissionDecision,
  Permissions,
  ToolDefinition,
} from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { TrustedToolBehavior } from '../../../src/tool-behavior';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];

for (const unsupported of [undefined, 'parent', 'child'] as const)
  test(`real child owner confirmation uses original policies without optional snapshots: ${unsupported ?? 'supported'}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-confirmation-')));
    const store = await openSqliteStore({ dataRoot: root, profile: 'new' });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, subjectId: 'owner' };
    let effects = 0,
      reviews = 0;
    let childRef: OperationRef | undefined;
    const consumed: string[] = [];
    const effect: ToolDefinition = {
      id: 'fixture.confirmed-child',
      version: '1',
      description: 'One exact child effect confirmed by its owner',
      inputSchema: { type: 'object' },
      async execute() {
        effects++;
        return { outcome: 'succeeded', content: 'exact child effect' };
      },
    };
    const delegate: ToolDefinition = {
      id: 'fixture.delegate',
      version: '1',
      description: 'Create one actual direct child',
      inputSchema: { type: 'object' },
      async execute(_input, context) {
        childRef = await context.operations.ensure({
          key: 'child',
          request: { kind: 'agent', configurationId: 'child', input: { content: 'one effect' } },
        });
        await context.operations.wait(childRef, { signal: context.signal, timeoutMs: 4000 });
        return { outcome: 'succeeded', content: 'original child observed' };
      },
    };
    const behavior: TrustedToolBehavior = {
      definition: effect,
      capability: { kind: 'tool', definitionId: effect.id, definitionVersion: effect.version },
      contractRef: 'fixture.child-owner',
      configurationDigest: await semanticDigest({ effect: effect.id }),
      async executionConfirmation() {
        return { request: { reason: 'one exact child call' } };
      },
    };
    const policy = (scope: 'parent' | 'child'): Permissions => {
      const originals = new WeakSet<PermissionDecision>();
      return {
        async authorize(request) {
          const decision: PermissionDecision =
            request.definitionId === effect.id
              ? {
                  allowed: false,
                  revision: `${scope}-soft-challenge`,
                  ...(scope === 'parent'
                    ? { check: { request: { scope } } }
                    : { approval: { request: { scope } } }),
                }
              : { allowed: true, revision: `${scope}-allowed` };
          originals.add(decision);
          return decision;
        },
        async consumesExecutionConfirmation(_request, decision) {
          expect(originals.has(decision)).toBe(true);
          expect(decision.snapshot).toBeUndefined();
          consumed.push(scope);
          return scope !== unsupported;
        },
      };
    };
    const parentModel = createFixedModel([call(delegate.id), [finish]]);
    const childModel = createFixedModel([call(effect.id), [finish]]);
    const extension: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [delegate, effect],
    };
    const runtime = createRuntime({
      store,
      model: parentModel,
      modelId: 'parent',
      modelConcurrency: 1,
      maxConcurrentSubagents: 1,
      extensions: [extension],
      toolBehaviors: [behavior],
      permissions: policy('parent'),
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: childModel,
          modelId: 'child',
          toolIds: [effect.id],
          toolBehaviors: [behavior],
          permissions: policy('child'),
          snapshot: { fixture: 'child-confirmation' },
        },
      ],
      authorizationCheck: {
        id: 'independent',
        version: '1',
        modelId: 'reviewer',
        model: {
          async *stream() {
            reviews++;
            yield { type: 'text_delta', text: '{"decision":"approve_once","reason":"fixture"}' };
            yield finish;
          },
        },
      },
    });
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
        sessionId: 's',
        workspaceId: 'w',
        title: 'parent',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        sessionId: 's',
        request: { kind: 'run.start', content: 'delegate the exact effect' },
      });
      if (!unsupported) {
        const deadline = Date.now() + 5000;
        for (;;) {
          const cards = (
            await runtime.listInteractions({ ...base, sessionId: 's', state: 'pending' })
          ).interactions;
          const card = cards[0];
          if (card) {
            expect(card.kind).toBe('approval');
            expect(effects).toBe(0);
            await runtime.answerInteraction({
              ...base,
              commandId: 'answer',
              presentationSessionId: 's',
              interactionId: card.id,
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
            });
            break;
          }
          if (childRef?.childSessionId) {
            const actual = (await store.listExecutions(childRef.childSessionId)).find(
              (row) => row.definitionId === effect.id,
            );
            expect(actual?.status).not.toBe('failed');
          }
          if (Date.now() >= deadline) throw Error('child_confirmation_card_unavailable');
          await Bun.sleep(5);
        }
      }
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(childRef?.childSessionId).toBeString();
      const actual = (await store.listExecutions(childRef!.childSessionId!)).find(
        (row) => row.definitionId === effect.id,
      )!;
      const cards = (await runtime.listInteractions({ ...base, sessionId: 's' })).interactions;
      expect(reviews).toBe(0);
      expect(effects).toBe(unsupported ? 0 : 1);
      expect(cards).toHaveLength(unsupported ? 0 : 1);
      expect(actual.status).toBe(unsupported ? 'failed' : 'succeeded');
      expect(actual.authorization?.dispatched).toBe(!unsupported);
      if (unsupported)
        expect(actual.result).toMatchObject({
          content: 'execution_confirmation_policy_unsupported',
        });
      else {
        expect(consumed).toContain('parent');
        expect(consumed).toContain('child');
        expect(cards[0]!.acceptedDecisionRevision).not.toBeNull();
        expect(actual.authorization?.human?.accepted).toBe(true);
      }
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
