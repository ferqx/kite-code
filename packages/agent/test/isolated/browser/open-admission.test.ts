import { setTimeout as sleepTimer } from 'node:timers/promises';
import { expect, test } from '#kite-test';
import type { ExtensionRecordWrite, ToolContext, ToolResult } from '../../../src/extensions';
import { type BrowserController, createBrowserExtension } from '../../../src/tools/browser';

function fixture(
  prepareOpen: Parameters<typeof createBrowserExtension>[0]['prepareOpen'],
  cancelOpen?: Parameters<typeof createBrowserExtension>[0]['cancelOpen'],
) {
  const records = new Map<string, ExtensionRecordWrite>();
  const abort = new AbortController();
  const requests: unknown[] = [];
  const extension = createBrowserExtension({
    controller: { view: () => null } as unknown as BrowserController,
    prepareOpen,
    cancelOpen,
  });
  const tool = extension.tools!.find((value) => value.id === 'browser.open')!;
  const context = {
    sessionId: 'session',
    executionId: 'tool',
    signal: abort.signal,
    records: {
      get: async (key: string) => records.get(key) ?? null,
      write: async (value: ExtensionRecordWrite) => {
        records.set(value.key, value);
        return value;
      },
    },
    operations: {
      ensure: async (value: unknown) => {
        requests.push(value);
        return { executionId: 'job' };
      },
    },
  } as unknown as ToolContext;
  return { tool, context, requests, abort };
}
const input = { key: 'original', url: 'https://example.test/' };

test('an unanswered explicit page question creates no browser Job; acceptance continues original intent once', async () => {
  let accept!: (value: ToolResult | undefined) => void;
  const question = new Promise<ToolResult | undefined>((resolve) => {
    accept = resolve;
  });
  let questions = 0;
  const f = fixture(async (_context, intent) => {
    questions++;
    expect(intent).toEqual(input);
    return question;
  });
  const result = f.tool.execute(input, f.context);
  await sleepTimer(0);
  expect(questions).toBe(1);
  expect(f.requests).toHaveLength(0);
  accept(undefined);
  expect((await result).outcome).toBe('succeeded');
  expect(f.requests).toEqual([
    {
      key: 'original',
      cancellation: 'attached',
      request: {
        kind: 'job',
        definitionId: 'browser.session',
        definitionVersion: '1',
        input: { browserId: 'original', url: input.url },
      },
    },
  ]);
  await f.tool.execute(input, f.context);
  expect(questions).toBe(1);
  // Operations.ensure remains the sole exact-key lifetime owner.
  expect(f.requests).toHaveLength(2);
  expect((await f.tool.execute({ ...input, url: 'https://other.test/' }, f.context)).outcome).toBe(
    'failed',
  );
  expect(f.requests).toHaveLength(2);
});

for (const outcome of ['failed', 'cancelled', 'outcome_unknown'] as const)
  test(`page admission ${outcome} cannot start an attached Job`, async () => {
    const decision: ToolResult = { outcome, content: 'browser_page_authorization_unconfirmed' };
    const f = fixture(async () => decision);
    expect(await f.tool.execute(input, f.context)).toEqual(decision);
    expect(f.requests).toHaveLength(0);
  });

test('cancellation after consent but before Job creation is rechecked', async () => {
  const f = fixture(async () => {
    f.abort.abort();
    return undefined;
  });
  await expect(f.tool.execute(input, f.context)).rejects.toBeDefined();
  expect(f.requests).toHaveLength(0);
});

test('failed Job admission cancels the original unused page permit and preserves unconfirmed cleanup', async () => {
  let cancellations = 0;
  const unknown: ToolResult = {
    outcome: 'outcome_unknown',
    content: 'browser_page_grant_cancel_unconfirmed',
  };
  const f = fixture(
    async () => undefined,
    async () => {
      cancellations++;
      return unknown;
    },
  );
  f.context.operations.ensure = async () => {
    throw Error('operation_cancelled');
  };
  expect(await f.tool.execute(input, f.context)).toEqual(unknown);
  expect(cancellations).toBe(1);
  expect(f.requests).toHaveLength(0);
});
