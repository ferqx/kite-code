import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import {
  childSpawnReportChecks,
  createChildSpawnFixture,
} from '../../e2e/live/model/child-spawn.live';
import { temporaryDirectory } from '../../fixtures/test-filesystem';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('actual worker summary need not repeat file bytes; the original write/readback remains separately required', () => {
  const report = '已将 `source.txt` 的完整原文写入工作区 `result.txt`，并核对两者一致。无阻碍。';
  expect(
    childSpawnReportChecks('worker', report, 'source-fdc6ef96-d214-48f1-9a1a-86971028bf88'),
  ).toEqual({});
});

test('actual review with exact file, cause, reproducer and source does not require an unrequested function-name quotation', () => {
  const token = 'source-148bfe78-5587-4071-93c9-20c0f79aa8f8';
  const report =
    '发现一处缺陷：\n\n- **`pricing.py:2`**：`prices[:-1]` 在求和前丢弃了最后一个价格，不符合 README 要求的“所有价格之和”。入口 `entry.py:4` 调用该函数，因此会受影响。\n- **最小触发输入**：`entry.total([1])`；实测返回 `0`，应返回 `1`。\n\n`source.txt` 的完整值：`source-148bfe78-5587-4071-93c9-20c0f79aa8f8`。';
  expect(Object.values(childSpawnReportChecks('review', report, token)).every(Boolean)).toBe(true);
  expect(
    childSpawnReportChecks('review', report, 'a different original source')[
      'child-reported-actual-random-source'
    ],
  ).toBe(false);
  expect(
    childSpawnReportChecks('review', report.replaceAll('pricing.py', 'unrelated.py'), token)[
      'child-reported-real-source-location'
    ],
  ).toBe(false);
});

test('exploration still requires the requested reachable function and exact source, independently of review coverage', () => {
  const report =
    'entry.py:3–4 的 total(prices) 调用 pricing.invoice_total(prices)；最终实现位于 pricing.py:1–2。完整值 source-observed。';
  expect(
    Object.values(childSpawnReportChecks('explore', report, 'source-observed')).every(Boolean),
  ).toBe(true);
  expect(
    childSpawnReportChecks(
      'explore',
      report.replace('invoice_total', 'unproven'),
      'source-observed',
    )['child-reported-real-source-location'],
  ).toBe(false);
});

for (const mode of ['accept_edits', 'auto', 'full'] as const)
  for (const role of ['worker', 'explore', 'review'] as const)
    test.skipIf(process.platform !== 'darwin')(
      `live preparation uses actual default computer-use and the ${role}/${mode} child capability fence without provider calls`,
      async () => {
        const root = temporaryDirectory('kite-child-spawn-live-preparation-');
        let f: Awaited<ReturnType<typeof createChildSpawnFixture>> | undefined;
        let childModels = 0;
        const model: ModelAdapter = {
          async *stream(request) {
            const execution = (await f!.store.getExecution(request.requestId))!;
            let events: ModelEvent[];
            if (execution.sessionId !== 's') {
              childModels++;
              events = request.messages.some((message) => message.role === 'tool')
                ? [
                    { type: 'text_delta', text: 'Observed the original source without changes.' },
                    finish,
                  ]
                : [
                    {
                      type: 'tool_call',
                      id: 'child-read',
                      name: 'read_file',
                      arguments: '{"path":"source.txt"}',
                    },
                    { ...finish, reason: 'tool_calls' },
                  ];
            } else if (
              request.messages.some((message) => message.content.startsWith('Child result source'))
            )
              events = [finish];
            else {
              const last = request.messages.filter((message) => message.role === 'tool').at(-1);
              events = !last
                ? [
                    {
                      type: 'tool_call',
                      id: 'original-spawn',
                      name: 'spawn_agent',
                      arguments: JSON.stringify({
                        prompt: 'Read source.txt without modifying business files.',
                        ...(role === 'worker' ? {} : { preset: role }),
                      }),
                    },
                    { ...finish, reason: 'tool_calls' },
                  ]
                : [
                    {
                      type: 'tool_call',
                      id: `wait-${request.requestId}`,
                      name: 'wait_agent_events',
                      arguments: JSON.stringify({
                        after_seq: last.toolCallId?.startsWith('wait-')
                          ? JSON.parse(last.content).next_seq
                          : '0',
                        wait_ms: 10000,
                      }),
                    },
                    { ...finish, reason: 'tool_calls' },
                  ];
            }
            for (const event of events) yield event;
          },
        };
        try {
          f = await createChildSpawnFixture({ root: join(root, 'case'), mode, model });
          await f.client.startRun('s', {
            expectedStoreId: f.expectedStoreId,
            commandId: 'work',
            kind: 'run.start',
            content: 'Delegate the one read and report its actual result.',
          });
          await f.runtime.waitForCommand('work', { timeoutMs: 10000 });
          const directory = await f.directory();
          const child = directory.executions.filter((row) => row.childSessionId);
          expect(child).toHaveLength(1);
          expect(child[0]!.status).toBe('succeeded');
          const parent = f.bindings.find((binding) => binding.actor === 'root')!;
          const childBinding = f.bindings.find((binding) => binding.actor === 'child')!;
          const parentSnapshot = parent.snapshot as Record<string, unknown>;
          const childSnapshot = childBinding.snapshot as Record<string, unknown>;
          expect(parent.toolIds).toContain('browser.execute');
          expect(parentSnapshot.skillSelection).toEqual({
            requested: null,
            resolvedIds: ['computer-use'],
          });
          expect(childSnapshot.roleId).toBe(role);
          expect(childSnapshot.skillSelection).toEqual({
            requested: null,
            resolvedIds: role === 'worker' ? ['computer-use'] : [],
          });
          expect(childBinding.toolIds.includes('browser.execute')).toBe(role === 'worker');
          expect(
            directory.executions.filter(
              (row) =>
                row.sessionId === child[0]!.childSessionId &&
                row.definitionId === 'files.read' &&
                row.status === 'succeeded',
            ),
          ).toHaveLength(1);
          expect(childModels).toBe(2);
          expect(
            f.requests.some((request) =>
              request.messages.some((message) => message.content.startsWith('Child result source')),
            ),
          ).toBe(true);
          expect(f.browserRequests).toEqual([]);
          expect(f.bindings.every((binding) => binding.checkerTimeout === 10000)).toBe(true);
        } finally {
          await f?.close();
          rmSync(root, { recursive: true, force: true });
        }
      },
      30000,
    );
