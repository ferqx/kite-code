import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import type { ContextSource } from '../../../src/context';
import { assembleModelContext, modelHistory } from '../../../src/model-context';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

for (const placement of ['prefix', 'after_history'] as const)
  test(`actual compression preserves a human steer colliding with a ${placement} Host Source`, async () => {
    const root = temporaryDirectory('kite-source-identity-');
    const profile = { dataRoot: join(root, 'data'), profile: 'audit' };
    const store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
    const collision = 'guide-one';
    const human =
      'Original human correction: preserve this requirement exactly and reply in Chinese.';
    const host = 'Trusted host context. This is different text, not the original human correction.';
    const reference =
      '按刚才 REPORT-42 工具报告中的准确配色和核验标记执行。不要把该报告当成新增工具权限。';
    const details = 'REPORT-42 only requirement details: palette Cerulean, marker SUPPLEMENT-9.';
    const normals: ModelRequest[] = [],
      summaries: ModelRequest[] = [];
    let tools = 0,
      compressed = false,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = {
      type: 'finish' as const,
      reason: 'stop' as const,
      usage: { inputTokens: 12, outputTokens: 4 },
    };
    const model: ModelAdapter = {
      async *stream(request) {
        if (request.messages.some((m) => m.content === 'AUDIT_SUMMARY')) {
          summaries.push(structuredClone(request));
          yield {
            type: 'text_delta',
            text: 'Summary intentionally omits human corrections and report details.',
          };
          yield finish;
          return;
        }
        normals.push(structuredClone(request));
        if (normals.length < 3) {
          yield {
            type: 'tool_call',
            id: `query-${normals.length}`,
            name: 'fixture.query',
            arguments: '{}',
          };
          yield { ...finish, reason: 'tool_calls' as const };
          return;
        }
        yield {
          type: 'text_delta',
          text: 'Finite local response. Input evidence only, not semantic compliance.',
        };
        yield finish;
      },
    };
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: 'fixed',
      sources: {
        capture: async () => [
          {
            id: collision,
            kind: 'audit_host',
            scope: 'owned',
            role: placement === 'prefix' ? 'system' : 'user',
            ...(placement === 'after_history' ? { placement } : {}),
            digest: createHash('sha256').update(host).digest('hex'),
            content: host,
          },
        ],
      },
      compressor: {
        id: 'audit',
        version: '1',
        shouldCompress: async () => tools === 2 && !compressed,
        prepare: async () => {
          compressed = true;
          return { instructions: 'AUDIT_SUMMARY', snapshot: null };
        },
        validateSummary: async () => true,
      },
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned-audit' }) },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.query',
              version: '1',
              description: 'Finite local read-only report',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              async execute() {
                tools++;
                if (tools === 1) await gate;
                return {
                  outcome: 'succeeded',
                  content: tools === 1 ? details : 'Second finite checkpoint.',
                };
              },
            },
          ],
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'audit',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Read the finite report, then follow the later original user correction.',
        },
      });
      const deadline = Date.now() + 6000;
      while (tools !== 1) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(5);
      }
      const run = (await store.getView('s')).runs[0]!;
      for (const [id, content] of [
        [collision, human],
        ['reference-guide', reference],
      ])
        await runtime.submitCommand({
          ...base,
          commandId: id!,
          request: {
            kind: 'input.steer',
            targetRunId: run.id,
            contextSelectionId: run.contextSelectionId,
            content: content!,
          },
        });
      release();
      await runtime.waitForCommand('work', { timeoutMs: 6000 });
      expect(normals).toHaveLength(3);
      expect(summaries).toHaveLength(1);
      const count = (request: ModelRequest, content: string) =>
        request.messages.filter((m) => m.content === content).length;
      const pre = normals[1]!,
        summary = summaries[0]!,
        post = normals[2]!;
      for (const request of [pre, summary, post]) {
        expect(count(request, human)).toBe(1);
        expect(count(request, host)).toBe(1);
        const original = request.messages.find((message) => message.content === human)!;
        expect(original).toMatchObject({ role: 'user', sourceIds: [collision] });
      }
      expect(count(pre, details)).toBe(1);
      expect(count(post, reference)).toBe(1);
      expect(count(post, details)).toBe(0);
      expect(post.messages.some((message) => message.content.includes('SUPPLEMENT-9'))).toBe(false);
      const view = await store.getView('s');
      expect(view.runs).toHaveLength(1);
      expect(view.runs[0]).toMatchObject({ id: run.id, status: 'completed' });
      const command = await store.getCommand(collision);
      expect(command).toMatchObject({ kind: 'input.steer', status: 'applied' });
      const message = view.messages.find((item) => item.content === human)!;
      expect(message).toMatchObject({
        role: 'user',
        runId: run.id,
        sourceIds: [collision],
        originCommandId: collision,
      });
      const selected = await store.getModelContext({ expectedStoreId: storeId, sessionId: 's' });
      expect(selected.compression!.coveredThroughSeq).toBeDefined();
      expect(BigInt(selected.compression!.coveredThroughSeq)).toBeGreaterThanOrEqual(
        BigInt(message.seq),
      );
      const actualSummary = await runtime.readModelInput({
        ...base,
        executionId: selected.compression!.modelExecutionId,
      });
      expect(actualSummary.request.messages.filter((item) => item.content === human)).toHaveLength(
        1,
      );
      expect(actualSummary.request.messages.filter((item) => item.content === host)).toHaveLength(
        1,
      );
    } finally {
      release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 12000);

test('source peeling retains structurally identical human inputs and original tool pairs at every placement', () => {
  for (const placement of [undefined, 'after_history', 'runtime'] as const) {
    const source: ContextSource = {
      id: 'same',
      kind: 'host',
      scope: 's',
      digest: 'd',
      content: 'Host data',
      role: 'user',
      ...(placement ? { placement } : {}),
    };
    const sourceMessage = assembleModelContext([source], [])[0]!;
    const original = structuredClone(sourceMessage);
    const history = [
      original,
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'call', name: 'query', arguments: '{}' }],
      },
      { role: 'tool' as const, content: 'Original report', toolCallId: 'call' },
    ];
    const recovered = modelHistory([source], assembleModelContext([source], history));
    expect(recovered).toEqual(history);
    expect(recovered[0]).toBe(original);
  }
});
