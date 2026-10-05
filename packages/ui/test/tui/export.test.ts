import { expect, test } from 'bun:test';
import type { Message, ModelOutputSnapshot, SessionView } from '@kite-ai/client';
import {
  parseTuiCommand,
  serializeLoadedText,
  TuiController,
  type TuiLoadedTextExport,
  type TuiPort,
} from '../../src/tui';

function setup() {
  let reads = 0;
  const saved: TuiLoadedTextExport[] = [];
  const message: Message = {
    id: 'assistant',
    sessionId: 'a',
    runId: 'run',
    seq: '2',
    role: 'assistant',
    status: 'complete',
    content: 'preview',
    outputBody: {
      kind: 'model_output',
      executionId: 'exec',
      complete: true,
      contentBytes: '9',
      reasoningBytes: '6',
      toolCallCount: 0,
    },
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'never',
    listSessions: async () => [],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        session: { id, workspaceId: 'w' },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView,
      messages:
        id === 'a'
          ? [
              {
                ...message,
                id: 'user',
                seq: '1',
                role: 'user',
                content: 'original task',
                outputBody: undefined,
              },
              message,
              {
                ...message,
                id: 'tool',
                seq: '3',
                role: 'tool',
                content: 'not exportable',
                outputBody: undefined,
              },
            ]
          : [],
      interactions: [],
    }),
    readModelOutput: async () => {
      reads++;
      return {
        storeId: 'store',
        sessionId: 'a',
        runId: 'run',
        executionId: 'exec',
        output: {
          content: `${'中'.repeat(3 * 1024 * 1024)}FULL_TAIL`,
          reasoning: 'reason\nREASON_TAIL',
          toolCalls: [],
          complete: true,
        },
      } as unknown as ModelOutputSnapshot;
    },
    submit: async () => {
      throw Error('no Model');
    },
    answer: async () => {
      throw Error('no answer');
    },
    cancel: async () => {
      throw Error('no cancel');
    },
    getCommand: async () => {
      throw Error('no command');
    },
    exportLoadedText: {
      write: async (value) => {
        saved.push(value);
        return { path: 'owned.md' };
      },
    },
  };
  return { controller: new TuiController(port), port, message, saved, reads: () => reads };
}
test('loaded-only export preserves full text and reasoning, marks unread preview and performs zero extra reads', async () => {
  const f = setup();
  await f.controller.select('a');
  await f.controller.routeCommand('/export');
  expect(f.reads()).toBe(0);
  expect(serializeLoadedText(f.saved[0]!)).toContain('Loaded preview only');
  expect(serializeLoadedText(f.saved[0]!)).not.toContain('not exportable');
  await f.controller.loadOutput(f.message);
  await f.controller.routeCommand('/export');
  expect(f.reads()).toBe(1);
  const text = serializeLoadedText(f.saved[1]!);
  expect(text).toContain('FULL_TAIL');
  expect(text).toContain('> reason\n> REASON_TAIL');
  expect(text.length).toBeGreaterThan(3 * 1024 * 1024);
  expect(text).not.toContain('preview only');
  expect(f.saved[1]!.sessionId).toBe('a');
  expect(Object.isFrozen(f.saved[1]!.messages)).toBe(true);
  expect(() => parseTuiCommand('/export other')).toThrow();
});
test('late export, closed view and write failure never publish success into another selected Session', async () => {
  const f = setup();
  await f.controller.select('a');
  let finish!: (value: { path: string }) => void;
  let signal: AbortSignal | undefined;
  f.port.exportLoadedText = {
    write: async (_value, s) => {
      signal = s;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const pending = f.controller.routeCommand('/export');
  await f.controller.select('b');
  expect(signal?.aborted).toBe(true);
  finish({ path: 'late.md' });
  await pending;
  expect(f.controller.state.notice).toBeUndefined();
  f.port.exportLoadedText = {
    write: async () => {
      throw Error('disk full');
    },
  };
  await f.controller.routeCommand('/export');
  expect(f.controller.state.error).toBe('Export failed');
  expect(f.controller.state.notice).toBeUndefined();
});
