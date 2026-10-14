import { expect, test } from 'bun:test';
import type { Execution, Message, ModelOutputSnapshot } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import type { TuiController } from '../../src/tui/controller';
import { TuiExecutionPanel } from '../../src/tui/execution-panel';
import { defaultTuiPreferences } from '../../src/tui/preferences';
import { TuiPresentationProvider } from '../../src/tui/presentation';
import {
  projectTuiMessages,
  TuiThoughtPhase,
  TuiToolCalls,
  TuiToolResult,
} from '../../src/tui/transcript';

const message = (
  id: string,
  seq: string,
  role: Message['role'],
  extra: Partial<Message> = {},
): Message => ({
  id,
  seq,
  role,
  sessionId: 'session',
  runId: 'run',
  status: 'complete',
  content: id,
  ...extra,
});

test('source-order transcript associates only unique original call identities, never same-name tools or another Run/Store', () => {
  const first = message('first', '9007199254740992', 'assistant', {
    toolCalls: [{ id: 'call-a', name: 'same', arguments: '{"original":true}' }],
  });
  const second = message('second', '9007199254740993', 'assistant', {
    toolCalls: [{ id: 'call-b', name: 'same', arguments: '{"original":false}' }],
  });
  const result = message('result', '9007199254740994', 'tool', {
    toolCallId: 'call-a',
    sourceIds: ['exact-execution'],
  });
  const foreignRun = message('foreign-run', '9007199254740995', 'tool', {
    toolCallId: 'call-a',
    runId: 'other-run',
  });
  const foreignStore = message('foreign-store', '9007199254740996', 'tool', {
    toolCallId: 'call-a',
    originMessage: { storeId: 'foreign', sessionId: 'session', messageId: 'old', runId: 'run' },
  });
  const items = projectTuiMessages([foreignStore, result, second, foreignRun, first]);
  expect(items.map((item) => item.message.id)).toEqual([
    'first',
    'second',
    'result',
    'foreign-run',
    'foreign-store',
  ]);
  expect(items[2]).toMatchObject({
    kind: 'tool-result',
    call: { id: 'call-a' },
    ownerMessageId: 'first',
    sourceIds: ['exact-execution'],
  });
  expect(items[3]!.kind).toBe('message');
  expect(items[4]!.kind).toBe('message');
  const duplicate = message('duplicate', '9007199254740993', 'assistant', {
    toolCalls: first.toolCalls,
  });
  expect(projectTuiMessages([first, duplicate, result])[2]!.kind).toBe('message');
  expect(first.toolCalls![0]!.arguments).toBe('{"original":true}');
});

test('verified calls preserve complete arguments/results and thought phases use only supplied timing', () => {
  const original = message('private-model-message', '1', 'assistant', {
    toolCalls: [{ id: 'preview', name: 'preview', arguments: 'short' }],
  });
  const args = '{\n  "text": "all original words",\n  "rows": [false, null, 17]\n}';
  const output: ModelOutputSnapshot['output'] = {
    content: 'actual reply',
    reasoning: 'original reasoning\nsecond thought',
    complete: true,
    toolCalls: [{ id: 'private-call', name: 'actual-tool', arguments: args }],
  };
  const result = message('private-tool-result', '2', 'tool', {
    toolCallId: 'private-call',
    content: 'original result\nline two',
    status: 'incomplete',
  });
  const items = projectTuiMessages([result, original], new Map([[original.id, output]]));
  const callItem = items[0]!;
  if (callItem.kind !== 'message' || items[1]!.kind !== 'tool-result')
    throw Error('expected exact tool association');
  expect(callItem.toolCalls[0]!.arguments).toBe(args);
  expect(callItem.reasoning).toBe(output.reasoning);
  expect(callItem.bodyAvailability).toBe('verified');
  const calls = render(<TuiToolCalls item={callItem} />);
  try {
    for (const body of ['actual-tool', 'all original words', '[false, null, 17]'])
      expect(calls.lastFrame()).toContain(body);
    expect(calls.lastFrame()).not.toContain('private-call');
    expect(calls.lastFrame()).not.toContain('preview');
  } finally {
    calls.unmount();
  }
  const detail = render(<TuiToolResult item={items[1]!} />);
  try {
    for (const body of ['original result', 'line two', 'Incomplete recorded result'])
      expect(detail.lastFrame()).toContain(body);
    expect(detail.lastFrame()).not.toContain('succeeded');
  } finally {
    detail.unmount();
  }
  const unknown = render(<TuiThoughtPhase reasoning={output.reasoning} toolCount={1} settled />);
  try {
    expect(unknown.lastFrame()).toContain('Timing unavailable');
    expect(unknown.lastFrame()).not.toContain('second thought');
  } finally {
    unknown.unmount();
  }
  const known = render(
    <TuiThoughtPhase
      reasoning={output.reasoning}
      toolCount={1}
      active
      expanded
      timing={{ elapsedMs: 1250 }}
    />,
  );
  try {
    expect(known.lastFrame()).toContain('1.3s');
    expect(known.lastFrame()).toContain('second thought');
  } finally {
    known.unmount();
  }
  const diagnostic = render(
    <TuiPresentationProvider value={{ preferences: defaultTuiPreferences, testDiagnostics: true }}>
      <TuiToolCalls item={callItem} />
    </TuiPresentationProvider>,
  );
  try {
    expect(diagnostic.lastFrame()).toContain('private-call');
  } finally {
    diagnostic.unmount();
  }
});

test('execution reader accepts a selected Tool result but only exact Jobs can invoke output, child or stop controls', async () => {
  const execution = (id: string, kind: Execution['kind']): Execution => ({
    id,
    kind,
    sessionId: 'session',
    originStoreId: 'store',
    runId: 'run',
    definitionId: id,
    definitionVersion: '1',
    status: 'running',
    resultRevision: '1',
    cancelRequestedAt: null,
    result: { text: 'complete tool content\nnext line', flags: [false, null] },
    childSessionId: 'child',
    parentExecutionId: null,
  });
  const calls: string[] = [];
  const controller = {
    state: {
      sessionId: 'session',
      snapshot: {
        storeId: 'store',
        view: {
          storeId: 'store',
          session: { id: 'session', workspaceId: 'w' },
          runs: [],
          executions: [execution('job', 'job'), execution('tool', 'tool')],
        },
        messages: [],
      },
      jobStops: new Map(),
      executionReading: {
        target: {
          storeId: 'store',
          originStoreId: 'store',
          sessionId: 'session',
          executionId: 'job',
          definitionId: 'job',
          definitionVersion: '1',
        },
        phase: 'ready',
        output: {
          highWaterSeq: '1',
          items: [
            {
              stream: 'stdout',
              seq: '1',
              throughSeq: '1',
              content: 'old exact Job output',
              droppedBytes: '0',
            },
          ],
        },
      },
      stale: false,
    },
    subscribe: () => () => {},
    closePanel: () => {},
    lookup: async () => {},
    select: async () => {},
    readExecution: async (id: string, child: boolean) => {
      calls.push(`${id}:${child}`);
    },
    stopJob: async (id: string) => {
      calls.push(`stop:${id}`);
    },
  } as unknown as TuiController;
  const app = render(<TuiExecutionPanel controller={controller} initialExecutionId="tool" />);
  try {
    expect(app.lastFrame()).toContain('› tool');
    expect(app.lastFrame()).not.toContain('old exact Job output');
    for (const text of ['complete tool content', 'next line', 'false', 'null'])
      expect(app.lastFrame()).toContain(text);
    for (const input of ['o', 'c', 's', '\r']) {
      app.stdin.write(input);
      await Bun.sleep(5);
    }
    expect(calls).toEqual([]);
    app.rerender(<TuiExecutionPanel controller={controller} initialExecutionId="job" />);
    await Bun.sleep(20);
    expect(app.lastFrame()).toContain('old exact Job output');
    app.stdin.write('c');
    await Bun.sleep(10);
    expect(calls).toEqual(['job:true']);
  } finally {
    app.unmount();
  }
});
