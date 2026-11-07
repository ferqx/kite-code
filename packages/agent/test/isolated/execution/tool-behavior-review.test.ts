import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension, ToolDefinition } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import { createToolBehaviorRegistry, type TrustedToolBehavior } from '../../../src/tool-behavior';

const stop: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
for (const scenario of [
  'inline',
  'artifact',
  'missing-receipt',
  'wrong-contract',
  'wrong-target',
  'incomplete-output',
] as const)
  test(`non-builtin review format: ${scenario}`, async () => {
    const large = scenario === 'artifact';
    const rejected = !['inline', 'artifact'].includes(scenario);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-behavior-review-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'new' };
    let store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    if (scenario === 'inline')
      for (const method of [
        'ensureAuthorizationReview',
        'getAuthorizationReview',
        'invalidateAuthorizationReview',
      ])
        expect(Reflect.get(store, method)).toBeUndefined();
    let effects = 0,
      reviews = 0,
      interpretations = 0;
    if (rejected && scenario !== 'incomplete-output') {
      const finish = store.finishAuthorizationCheck.bind(store);
      store.finishAuthorizationCheck = async (input) => {
        if (input.status === 'succeeded') {
          const altered = structuredClone(input) as any;
          if (scenario === 'missing-receipt') delete altered.result.authorizationCheckOutput;
          if (scenario === 'wrong-contract')
            altered.result.authorizationCheckOutput.behavior.contractRef = 'another-owner';
          if (scenario === 'wrong-target')
            altered.result.authorizationCheckOutput.target.executionId = 'another-target';
          return finish(altered);
        }
        return finish(input);
      };
    }
    const tool: ToolDefinition = {
      id: 'fixture.paint',
      version: '3',
      description: 'Bounded recorded fixture',
      inputSchema: { type: 'object' },
      async execute(_input, context) {
        expect(context.dispatchAuthorization?.materialReviewed).toBe(true);
        effects++;
        return { outcome: 'succeeded', content: 'painted once' };
      },
    };
    const extension: Extension = {
      id: 'fixture.painting',
      version: '1',
      apiMajor: 1,
      tools: [tool],
    };
    const behavior: TrustedToolBehavior = {
      capability: { kind: 'tool', definitionId: tool.id, definitionVersion: tool.version },
      definition: tool,
      contractRef: 'fixture.paint-review',
      configurationDigest: await semanticDigest({ grammar: 'PASS:paint' }),
      autoReview: 'check',
      async prepareReview(request) {
        return {
          instructions: 'Return PASS:paint only.',
          material: { paint: request.input },
          fingerprint: await semanticDigest(request.input),
          reusable: false,
        };
      },
      interpretReview(content) {
        interpretations++;
        return content.startsWith('PASS:paint')
          ? {
              answer: { decision: 'approve_once', reason: 'Bounded paint accepted.' },
              evidence: { classification: 'paint', originalDecision: 'pass' },
            }
          : null;
      },
    };
    const permissions = createPermissionPolicy({
      readPolicy: () => ({
        mode: 'auto',
        workspaceTrust: true,
        revision: 'current',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          behavior.capability,
        ],
      }),
      describeCapability: (request) => ({
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: 'current',
        hardAllowed: true,
        safeRead: false,
        effects: ['unknown'],
        ...(request.kind === 'tool'
          ? {
              autoReview: 'check' as const,
              reviewBehavior: {
                capability: behavior.capability,
                contractRef: behavior.contractRef,
                configurationDigest: behavior.configurationDigest,
              },
            }
          : {}),
      }),
    });
    let runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      modelId: 'fixed',
      permissions,
      extensions: [extension],
      toolBehaviors: [behavior],
      model: createFixedModel([
        [
          { type: 'tool_call', id: 'paint', name: tool.id, arguments: '{"color":"blue"}' },
          { ...stop, reason: 'tool_calls' },
        ],
        [stop],
      ]),
      authorizationCheck: {
        id: 'checker',
        version: 'fixture',
        modelId: 'reviewer',
        timeoutMs: 5000,
        model: {
          async *stream(request) {
            reviews++;
            expect(request.tools).toEqual([]);
            expect(request.messages[0]!.content).toBe('Return PASS:paint only.');
            expect(JSON.parse(request.messages[1]!.content)).toEqual({ paint: { color: 'blue' } });
            yield { type: 'text_delta', text: `PASS:paint${large ? 'x'.repeat(70 * 1024) : ''}` };
            yield { ...stop, reason: scenario === 'incomplete-output' ? 'length' : 'stop' };
          },
        },
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'paint',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'paint',
      });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'paint blue' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
      const view = await store.getView('s');
      const effect = view.executions.find((execution) => execution.definitionId === tool.id)!;
      expect(effect.status).toBe(rejected ? 'failed' : 'succeeded');
      expect(effects).toBe(rejected ? 0 : 1);
      expect(reviews).toBe(1);
      expect(interpretations).toBe(scenario === 'incomplete-output' ? 0 : 1);
      const check = view.executions.find((execution) => execution.definitionId === 'reviewer')!;
      const result = check.result as Record<string, any>;
      if (rejected) {
        expect(check.status).toBe('failed');
        expect(result.code).toBe(
          scenario === 'incomplete-output'
            ? 'authorization_check_output_limit'
            : 'authorization_check_output_invalid',
        );
        return;
      }
      expect(result.authorizationCheckOutput).toMatchObject({
        version: 1,
        behavior: { contractRef: 'fixture.paint-review' },
        target: { executionId: effect.id, attempt: effect.attempt },
        answer: { decision: 'approve_once' },
        evidence: { classification: 'paint' },
      });
      expect(!!result.modelOutput).toBe(large);
      const saved = JSON.stringify(result);
      expect((view.runs[0]!.configuration as Record<string, any>).toolBehaviors).toEqual([
        {
          capability: behavior.capability,
          contractRef: behavior.contractRef,
          configurationDigest: behavior.configurationDigest,
        },
      ]);
      await runtime.close();
      await store.close();
      store = await openSqliteStore(profile);
      runtime = createRuntime({
        store,
        modelId: 'fixed',
        permissions,
        extensions: [extension],
        toolBehaviors: [
          {
            ...behavior,
            interpretReview() {
              throw new Error('cold interpretation forbidden');
            },
          },
        ],
        authorizationCheck: {
          id: 'checker',
          version: 'fixture',
          modelId: 'reviewer',
          model: {
            async *stream() {
              yield stop;
              throw new Error('cold Provider forbidden');
            },
          },
        },
      });
      expect(JSON.stringify((await store.getExecution(check.id))!.result)).toBe(saved);
      expect((await store.getExecution(effect.id))!.status).toBe('succeeded');
      expect(effects).toBe(1);
      expect(reviews).toBe(1);
      expect(interpretations).toBe(1);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

test('trusted registration rejects a same-name replacement definition and duplicate behavior', async () => {
  const tool: ToolDefinition = {
    id: 'fixture.paint',
    version: '1',
    description: 'fixture',
    inputSchema: { type: 'object' },
    async execute() {
      return { outcome: 'succeeded', content: 'once' };
    },
  };
  const extension: Extension = { id: 'fixture', version: '1', apiMajor: 1, tools: [tool] };
  const behavior: TrustedToolBehavior = {
    capability: { kind: 'tool', definitionId: tool.id, definitionVersion: tool.version },
    definition: { ...tool },
    contractRef: 'fixture.paint',
    configurationDigest: await semanticDigest('fixture'),
  };
  expect(() =>
    createToolBehaviorRegistry({ extensions: [extension], behaviors: [behavior] }),
  ).toThrow('tool_behavior_binding_invalid');
  expect(() =>
    createToolBehaviorRegistry({
      extensions: [],
      behaviors: [{ ...behavior, definition: undefined } as unknown as TrustedToolBehavior],
    }),
  ).toThrow('tool_behavior_binding_invalid');
  expect(() =>
    createToolBehaviorRegistry({
      extensions: [extension],
      behaviors: [
        { ...behavior, definition: tool },
        { ...behavior, definition: tool },
      ],
    }),
  ).toThrow('tool_behavior_duplicate_binding');
});
