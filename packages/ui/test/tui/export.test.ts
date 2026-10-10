import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  canonicalModelBody,
  type Message,
  type ModelOutputSnapshot,
  type SessionView,
} from '@kite-ai/client';
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
  const content = `${'中'.repeat(3 * 1024 * 1024)}FULL_TAIL`;
  const reasoning = 'reason\nREASON_TAIL';
  const contentBytes = String(Buffer.byteLength(content));
  const reasoningBytes = String(Buffer.byteLength(reasoning));
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
      contentBytes,
      reasoningBytes,
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
      const output: ModelOutputSnapshot['output'] = {
        content,
        reasoning,
        toolCalls: [],
        complete: true,
      };
      const body = Buffer.from(canonicalModelBody(output));
      return {
        storeId: 'store',
        sessionId: 'a',
        rootSessionId: 'a',
        runId: 'run',
        executionId: 'exec',
        originCommandId: 'original-work',
        rootWorkCommandId: 'original-work',
        rootWorkSeq: '1',
        attempt: 1,
        status: 'succeeded',
        bodyHash: createHash('sha256').update(body).digest('hex'),
        bodyBytes: String(body.byteLength),
        contentBytes,
        reasoningBytes,
        snapshotCursor: '1',
        output,
      };
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
