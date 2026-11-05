import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { ToolDefinition, ToolResult } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fixture(execute: ToolDefinition['execute'], sibling = false) {
  const root = mkdtempSync(join(tmpdir(), 'kite-loop-results-'));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  let siblingEffects = 0;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'original', name: 'fixture.tool', arguments: '{}' },
      ...(sibling
        ? [{ type: 'tool_call' as const, id: 'successor', name: 'fixture.next', arguments: '{}' }]
        : []),
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'The original tool result is available.' }, finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    processConcurrency: 1,
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.tool',
            version: '1',
            description: 'Original tool',
            inputSchema: { type: 'object' },
            resources: { slot: 'process' },
            execute,
          },
          {
            id: 'fixture.next',
            version: '1',
            description: 'Queued successor',
            inputSchema: { type: 'object' },
            resources: { slot: 'process' },
            async execute() {
              siblingEffects++;
              return { outcome: 'succeeded', content: 'Unexpected successor effect' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    subjectId: 'owner',
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 'Tool failures remain results',
  });
  return {
    root,
    store,
    runtime,
    model,
    expectedStoreId,
    siblingEffects: () => siblingEffects,
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        subjectId: 'owner',
        sessionId: 's',
        commandId: 'work',
        request: { kind: 'run.start', content: 'Report the actual result without replaying it.' },
      });
      const command = await runtime.waitForCommand('work', { timeoutMs: 2500 });
      return (await store.getRun((command.receipt as { runId: string }).runId))!;
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const variant of [
  'succeeded',
  'failed',
  'approval_denied',
  'outcome_unknown',
  'throws',
] as const)
  test(`durable ${variant} Tool result reaches the next Model without ending its Run`, async () => {
    let attempts = 0;
    const f = await fixture(async () => {
      attempts++;
      if (variant === 'throws') throw new Error('Adapter failed after its possible effect');
      return {
        outcome: variant === 'approval_denied' ? 'failed' : variant,
        content: variant === 'outcome_unknown' ? 'Original effect is unknown' : variant,
        details: { original: true },
      };
    });
    try {
      const run = await f.run();
      expect(attempts).toBe(1);
      const tools = (await f.store.listExecutions('s')).filter((row) => row.kind === 'tool');
      expect(tools).toHaveLength(1);
      expect(tools[0]!.status).toBe(
        variant === 'throws'
          ? 'outcome_unknown'
          : variant === 'approval_denied'
            ? 'failed'
            : variant,
      );
      expect(f.model.requests).toHaveLength(2);
      const results = f.model.requests[1]!.messages.filter((row) => row.role === 'tool');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        toolCallId: 'original',
        sourceIds: [tools[0]!.id],
      });
      if (variant === 'succeeded') expect(results[0]!.content).toBe('succeeded');
      else if (variant === 'approval_denied') {
        expect(results[0]!.content).toContain('Approval was not obtained');
        // A leaf claim is not the Core's verified human refusal or no-effect proof.
        expect(results[0]!.content).not.toContain('The user denied');
        expect(results[0]!.content).not.toContain('produced no effects');
      } else if (variant === 'failed') expect(results[0]!.content).toContain('operation failed');
      else {
        expect(results[0]!.content).toContain('may have produced effects');
        expect(results[0]!.content).toContain('do not repeat');
        if (variant === 'outcome_unknown')
          expect(results[0]!.content).toContain('Original effect is unknown');
        else {
          expect(results[0]!.content).toContain('private exception text is unavailable');
          expect(results[0]!.content).not.toContain('Adapter failed after its possible effect');
        }
      }
      expect(run).toMatchObject({ status: 'completed' });
      expect(
        (await f.store.listMessages('s')).some(
          (row) =>
            row.role === 'assistant' && row.content === 'The original tool result is available.',
        ),
      ).toBe(true);
      if (variant !== 'throws')
        expect(tools[0]!.result).toEqual({
          outcome: variant === 'approval_denied' ? 'failed' : variant,
          content: variant === 'outcome_unknown' ? 'Original effect is unknown' : variant,
          details: { original: true },
        });
      if (variant === 'throws')
        expect(tools[0]!.result).toMatchObject({
          outcome: 'outcome_unknown',
          content: 'tool_failed',
          details: { adapterAttempted: true, dispatchCommitted: true },
        });
    } finally {
      await f.close();
    }
  });

for (const variant of [
  'cycle',
  'toJSON',
  'mutating-toJSON',
  'BigInt',
  'nonfinite',
  'details-getter',
  'outcome-getter',
] as const)
  test(`invalid ${variant} Tool result becomes one original unknown result and reaches the next Model`, async () => {
    let attempts = 0,
      hooks = 0;
    const f = await fixture(async () => {
      attempts++;
      const raw: Record<string, unknown> = {
        outcome: 'succeeded',
        content: 'Unverified adapter claim',
        details: { original: true },
      };
      if (variant === 'cycle') {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        raw.details = cycle;
      }
      if (variant === 'BigInt') raw.details = { value: 1n };
      if (variant === 'nonfinite') raw.details = { value: Number.NaN };
      if (variant === 'toJSON')
        raw.toJSON = () => {
          hooks++;
          throw Error('adapter serialization failed');
        };
      if (variant === 'mutating-toJSON') {
        raw.outcome = 'failed';
        raw.toJSON = () => {
          hooks++;
          raw.outcome = 'succeeded';
          return { outcome: 'succeeded', content: 'Forged success' };
        };
      }
      if (variant === 'details-getter' || variant === 'outcome-getter')
        Object.defineProperty(raw, variant === 'details-getter' ? 'details' : 'outcome', {
          enumerable: true,
          get() {
            hooks++;
            throw Error('adapter getter failed');
          },
        });
      return raw as unknown as ToolResult;
    }, true);
    try {
      expect(await f.run()).toMatchObject({ status: 'completed' });
      expect(attempts).toBe(1);
      expect(hooks).toBe(0);
      expect(f.siblingEffects()).toBe(0);
      const tools = (await f.store.listExecutions('s')).filter((row) => row.kind === 'tool');
      const original = tools.find((row) => row.callId === 'original')!;
      expect(original).toMatchObject({
        status: 'outcome_unknown',
        result: {
          outcome: 'outcome_unknown',
          content: 'invalid_tool_result',
          details: { code: 'invalid_tool_result', dispatchCommitted: true, adapterAttempted: true },
        },
      });
      expect(tools.find((row) => row.callId === 'successor')).toMatchObject({
        status: 'cancelled',
        authorization: { dispatched: false },
      });
      expect(f.model.requests).toHaveLength(2);
      const results = f.model.requests[1]!.messages.filter((row) => row.role === 'tool');
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        toolCallId: 'original',
        sourceIds: [original.id],
      });
      expect(results[0]!.content).toContain('returned an invalid result');
      expect(results[0]!.content).toContain('claimed outcome could not be accepted');
      expect(results[0]!.content).toContain('may have produced effects');
      expect(results[0]!.content).toContain('do not repeat');
      expect(results[0]!.content).not.toContain('invalid_tool_result');
      expect(results[0]!.content).not.toContain('Unverified adapter claim');
      expect(results[0]!.content).not.toContain('Forged success');
      expect(results[1]!.toolCallId).toBe('successor');
      expect(results[1]!.sourceIds).toEqual([tools.find((row) => row.callId === 'successor')!.id]);
    } finally {
      await f.close();
    }
  });

test('legal JSON data is detached once without losing optional omissions or own prototype-named fields', async () => {
  const details = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"source data","nested":[null,true,1,"雪"]}',
  );
  const result = {
    outcome: 'succeeded' as const,
    content: 'Original JSON result',
    details,
    modelImages: undefined,
  };
  const f = await fixture(async () => result);
  try {
    expect(await f.run()).toMatchObject({ status: 'completed' });
    const original = (await f.store.listExecutions('s')).find((row) => row.callId === 'original')!;
    expect(original.result).toEqual({
      outcome: 'succeeded',
      content: 'Original JSON result',
      details,
    });
    expect(Object.hasOwn(original.result as object, 'modelImages')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(f.model.requests[1]!.messages.find((row) => row.role === 'tool')).toMatchObject({
      toolCallId: 'original',
      sourceIds: [original.id],
      content: result.content,
    });
  } finally {
    await f.close();
  }
});

test('a Tool terminal persistence failure cannot be replaced with an invented result or next Model', async () => {
  const f = await fixture(async () => ({ outcome: 'succeeded', content: 'Original effect' }));
  const db = new Database(join(f.root, 'data', 'test', 'core.db'));
  db.exec('PRAGMA busy_timeout=1000');
  db.exec(
    "CREATE TRIGGER reject_terminal BEFORE UPDATE OF state ON execution WHEN NEW.call_id='original' AND NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'original Tool terminal denied'); END",
  );
  try {
    expect(await f.run()).toMatchObject({ status: 'failed', reason: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(f.model.requests).toHaveLength(1);
    const tool = (await f.store.listExecutions('s')).find((row) => row.callId === 'original');
    expect(tool).toMatchObject({ status: 'dispatching', result: null });
    expect((await f.store.listMessages('s')).filter((row) => row.role === 'tool')).toHaveLength(0);
  } finally {
    db.exec('DROP TRIGGER reject_terminal');
    db.close();
    await f.close();
  }
});

test('unknown result stops queued successor effects while both original calls reach the next Model', async () => {
  const f = await fixture(
    async () => ({
      outcome: 'outcome_unknown',
      content: 'Original effect is unknown; do not replay it',
    }),
    true,
  );
  try {
    await f.run();
    expect(f.siblingEffects()).toBe(0);
    expect(f.model.requests).toHaveLength(2);
    const tools = (await f.store.listExecutions('s')).filter((row) => row.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.find((row) => row.callId === 'original')).toMatchObject({
      status: 'outcome_unknown',
      result: { content: 'Original effect is unknown; do not replay it' },
    });
    expect(tools.find((row) => row.callId === 'successor')).toMatchObject({
      status: 'cancelled',
      authorization: { dispatched: false },
      result: { details: { adapterAttempted: false } },
    });
    expect(
      f.model.requests[1]!.messages.filter((row) => row.role === 'tool').map(
        (row) => row.toolCallId,
      ),
    ).toEqual(['original', 'successor']);
  } finally {
    await f.close();
  }
});

test('explicit user cancellation still stops before another Model after the original Tool settles', async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const f = await fixture(async (_input, context) => {
    enter();
    if (!context.signal.aborted)
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    return { outcome: 'cancelled', content: 'Original adapter confirmed cancellation' };
  });
  try {
    const running = f.run();
    await entered;
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'stop',
      targetCommandId: 'work',
    });
    expect(await running).toMatchObject({ status: 'cancelled' });
    expect(f.model.requests).toHaveLength(1);
    expect(
      (await f.store.listExecutions('s')).find((row) => row.callId === 'original'),
    ).toMatchObject({
      status: 'cancelled',
      result: { content: 'Original adapter confirmed cancellation' },
    });
  } finally {
    await f.close();
  }
});
