import { expect, test } from 'bun:test';
import type { Execution, Message } from '@kite-ai/client';
import { type Message as DesktopMessage, ToolActivity } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { nativeToolMessageFact } from '../../electron/tool-message-fact';
import {
  completeNativeToolMessages,
  desktopToolMessage,
  liveToolMessages,
  NativeToolPresentation,
  nativeLiveToolPresentationReady,
} from '../../src/native-tool-messages';
import { desktopTranscript } from '../../src/native-transcript';
import { type NativeRunFact, nativeToolExecution } from '../../src/tool-messages-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const path = '/工作区/项目 雪🙂/src/说明 文档.md';
const run: NativeRunFact = {
  id: 'child-run',
  originStoreId: 'store',
  sessionId: 'child',
  status: 'running',
  isActive: true,
  createdAt: 1,
  finishedAt: null,
  reason: null,
};

function execution(
  definitionId = 'files.read',
  definitionVersion = '5',
  input: Execution['toolInput'] = { path },
): Execution {
  return {
    id: 'original-tool',
    kind: 'tool',
    originStoreId: 'store',
    sessionId: 'child',
    runId: run.id,
    definitionId,
    definitionVersion,
    toolCallId: 'original-call',
    toolInput: input,
    status: 'planned',
    result: null,
    resultRevision: '0',
    cancelRequestedAt: null,
  };
}

function history(tool: Execution): { model: Message; receipt: Message; saved: Execution } {
  const model: Message = {
    id: 'original-model',
    role: 'assistant',
    status: 'complete',
    sessionId: tool.sessionId,
    runId: tool.runId,
    seq: '1',
    content: '',
    toolCalls: [],
    outputBody: {
      kind: 'model_output',
      executionId: 'original-model-execution',
      complete: true,
      contentBytes: '0',
      reasoningBytes: '0',
      toolCallCount: 1,
    },
  };
  const receipt: Message = {
    id: 'original-receipt',
    role: 'tool',
    status: 'complete',
    sessionId: tool.sessionId,
    runId: tool.runId,
    seq: '2',
    content: 'Original tool result',
    sourceIds: [tool.id],
    toolCallId: tool.toolCallId,
  };
  return {
    model,
    receipt,
    saved: {
      ...tool,
      status: 'succeeded',
      resultRevision: '1',
      result: { outcome: 'succeeded', content: receipt.content },
    },
  };
}

async function fixture(
  verify: (surface: {
    host: HTMLElement;
    render: (message: DesktopMessage | readonly DesktopMessage[] | undefined) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"/>', { pretendToBeVisual: true });
  const restoreLayout = prepareDesktopDom(dom);
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await verify({
      host,
      render: async (message) => {
        const messages = !message
          ? []
          : Array.isArray(message)
            ? message
            : [message as DesktopMessage];
        await act(async () =>
          root.render(
            messages.map((message) => (
              <ToolActivity
                key={message.presentationKey ?? message.id}
                messages={[message]}
                expanded={false}
                onToggle={() => {}}
                renderChildren={() => null}
              />
            )),
          ),
        );
      },
    });
  } finally {
    await act(async () => root.unmount());
    restoreLayout();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function live(tool: Execution, projected = false) {
  return liveToolMessages(
    {
      storeId: 'store',
      session: { id: 'child' },
      runs: [run],
      executions: [projected ? nativeToolExecution(tool) : tool],
    },
    [history(tool).model],
  ).find((entry) => nativeLiveToolPresentationReady(entry, []))?.message;
}

test('file target remains visible from planned to running and ModelOutput receipt in parent and child projections', async () => {
  await fixture(async ({ host, render }) => {
    const tool = execution();
    for (const projected of [false, true]) {
      for (const status of ['planned', 'running'] as const) {
        await render(live({ ...tool, status }, projected));
        expect(host.querySelector('.tool-step-target')?.textContent).toBe(path);
        expect(host.querySelector('.tool-step-target')?.getAttribute('title')).toBe(path);
        expect(host.textContent).toContain('读取');
        expect(host.querySelector('.file-link')).toBeNull();
      }
    }
    const { model, receipt, saved } = history(tool);
    const fact = nativeToolMessageFact({
      execution: saved,
      message: receipt,
      messages: [model, receipt],
      sessionId: 'child',
    })!;
    expect(fact.target).toBe(path);
    await render(desktopToolMessage(fact, receipt.id, receipt.content));
    expect(host.querySelector('.tool-step-target')?.textContent).toBe(path);
    expect(host.querySelector('.tool-step-target')?.getAttribute('title')).toBe(path);
    expect(host.querySelector('.file-link')).toBeNull();
    expect(host.querySelector('.composer-attachments')).toBeNull();
  });
});

test.each([
  ['files.read_path', '2', { path }, path],
  ['files.glob', '3', { pattern: '**/说明 *.md' }, '**/说明 *.md'],
  ['files.search', '5', { path: '/工作区/src', text: '待处理 雪🙂' }, '待处理 雪🙂'],
  ['files.list', '1', { path: '/工作区/项目 雪🙂' }, '/工作区/项目 雪🙂'],
  ['files.list', '1', { limit: 30 }, '.'],
  ['mcp.tools.search', '1', { query: 'find project docs 雪🙂' }, 'find project docs 雪🙂'],
  ['mcp.resources.list', '1', { serverId: 'project-docs' }, 'project-docs'],
  [
    'mcp.resources.read',
    '1',
    { serverId: 'project-docs', uri: 'docs://project/说明 文档' },
    'docs://project/说明 文档',
  ],
] as const)('%s target survives omitted Model tool calls and readonly child projection', async (id, version, input, expected) => {
  await fixture(async ({ host, render }) => {
    const tool = execution(id, version, input);
    await render(live({ ...tool, status: 'running' }, true));
    expect(host.querySelector('.tool-step-target')?.textContent).toContain(expected);
    const { model, receipt, saved } = history(tool);
    const fact = nativeToolMessageFact({
      execution: saved,
      message: receipt,
      messages: [model, receipt],
      sessionId: 'child',
    })!;
    expect(fact.target).toContain(expected);
    await render(desktopToolMessage(fact, receipt.id, receipt.content));
    expect(host.querySelector('.tool-step-target')?.textContent).toContain(expected);
    expect(host.querySelector('.file-link')).toBeNull();
  });
});

test('missing input and unknown versions do not invent live or saved file targets', async () => {
  await fixture(async ({ host, render }) => {
    for (const tool of [execution('files.read', 'future'), execution('files.read', '5', {})]) {
      await render(live(tool, true));
      expect(host.querySelector('.tool-step-target')).toBeNull();
      const { model, receipt, saved } = history(tool);
      const fact = nativeToolMessageFact({
        execution: saved,
        message: receipt,
        messages: [model, receipt],
        sessionId: 'child',
      })!;
      expect(fact.target).toBeUndefined();
      await render(
        completeNativeToolMessages([desktopToolMessage(fact, receipt.id, receipt.content)], [fact]),
      );
      expect(host.querySelector('.tool-step-target')).toBeNull();
      expect(host.textContent).not.toContain(path);
    }
  });
});

test('visible duplicate calls and mismatched original call identity cannot supply a saved file target', async () => {
  await fixture(async ({ host, render }) => {
    const tool = execution();
    const { model, receipt, saved } = history(tool);
    const call = {
      id: tool.toolCallId!,
      name: tool.definitionId,
      arguments: JSON.stringify({ path }),
    };
    model.toolCalls = [call, { ...call }];
    const cases: [Execution, Message[]][] = [
      [saved, [model, receipt]],
      [{ ...saved, toolCallId: 'another-call' }, [{ ...model, toolCalls: [] }, receipt]],
      [
        saved,
        [
          {
            ...model,
            toolCalls: [{ ...call, arguments: JSON.stringify({ path: '/wrong/target.md' }) }],
          },
          receipt,
        ],
      ],
    ];
    for (const [record, messages] of cases) {
      const fact = nativeToolMessageFact({
        execution: record,
        message: receipt,
        messages,
        sessionId: 'child',
      })!;
      expect(fact.target).toBeUndefined();
      await render(
        completeNativeToolMessages([desktopToolMessage(fact, receipt.id, receipt.content)], [fact]),
      );
      expect(host.querySelector('.tool-activity')).toBeNull();
      expect(host.querySelector('.tool-step-target')).toBeNull();
      expect(host.textContent).not.toContain(path);
      expect(host.querySelector('.file-link')).toBeNull();
    }
  });
});

test('receipt-first handoff waits for complete metadata before showing the tool with its original target', async () => {
  await fixture(async ({ host, render }) => {
    for (const projected of [false, true]) {
      const tool = execution();
      const { model, receipt, saved } = history(tool);
      await render(live({ ...tool, status: 'running' }, projected));
      expect(host.querySelector('.tool-step-target')?.textContent).toBe(path);
      const pending = desktopTranscript({
        messages: [model, receipt],
        runs: [run],
        tools: [],
        executions: [projected ? nativeToolExecution(saved) : saved],
        storeId: 'store',
        sessionId: 'child',
      }).messages;
      const pendingVisible = completeNativeToolMessages(pending, []);
      expect(pendingVisible.some((message) => message.role === 'tool')).toBe(false);
      await render(pendingVisible.filter((message) => message.role === 'tool'));
      expect(host.querySelector('.tool-activity')).toBeNull();
      expect(host.querySelector('.file-link')).toBeNull();
      const fact = nativeToolMessageFact({
        execution: saved,
        message: receipt,
        messages: [model, receipt],
        sessionId: 'child',
      })!;
      const confirmed = desktopTranscript({
        messages: [model, receipt],
        runs: [run],
        tools: [fact],
        executions: [projected ? nativeToolExecution(saved) : saved],
        storeId: 'store',
        sessionId: 'child',
      }).messages.find((message) => message.id === receipt.id)!;
      expect(confirmed.target).toBe(path);
      expect(confirmed.status).toBe('completed');
      await render(completeNativeToolMessages([confirmed], [fact]));
      expect(host.querySelector('.tool-step-target')?.textContent).toBe(path);
      expect(host.querySelector('.file-link')).toBeNull();

      const call = {
        id: tool.toolCallId!,
        name: tool.definitionId,
        arguments: JSON.stringify({ path }),
      };
      const rejected: [Execution, Message][] = [
        [saved, { ...model, toolCalls: [call, { ...call }] }],
        [{ ...saved, toolCallId: 'another-call' }, model],
        [
          saved,
          {
            ...model,
            toolCalls: [{ ...call, arguments: JSON.stringify({ path: '/wrong/target.md' }) }],
          },
        ],
      ];
      for (const [record, declaration] of rejected) {
        const unavailable = desktopTranscript({
          messages: [declaration, receipt],
          runs: [run],
          tools: [],
          executions: [projected ? nativeToolExecution(record) : record],
          storeId: 'store',
          sessionId: 'child',
        }).messages;
        const visible = completeNativeToolMessages(unavailable, []).filter(
          (message) => message.role === 'tool',
        );
        expect(visible).toHaveLength(0);
        await render(visible);
        expect(host.querySelector('.tool-activity')).toBeNull();
        expect(host.querySelector('.file-link')).toBeNull();
      }
    }
  });
});

test('batched metadata publishes only complete tool rows and revokes pending or conflicting records without a half row', async () => {
  await fixture(async ({ host, render }) => {
    const tools = Array.from({ length: 9 }, (_, index) => ({
      ...execution(),
      id: `tool-${index}`,
      toolCallId: `call-${index}`,
      toolInput: { path: `${path}/part-${index}` },
    }));
    const saved = tools.map(history);
    const model: Message = {
      ...saved[0]!.model,
      outputBody: { ...saved[0]!.model.outputBody!, toolCallCount: 9 },
    };
    const receipts = saved.map(({ receipt }, index) => ({
      ...receipt,
      id: `receipt-${index}`,
      seq: String(index + 2),
    }));
    const messages = [model, ...receipts];
    const facts = saved.map(
      ({ saved }, index) =>
        nativeToolMessageFact({
          execution: saved,
          message: receipts[index]!,
          messages,
          sessionId: 'child',
        })!,
    );
    const nonTool: DesktopMessage = {
      id: 'ordinary-user',
      role: 'user',
      text: 'Keep the parent text',
      settled: true,
    };
    for (const count of [0, 2, 9]) {
      const complete = facts.slice(0, count);
      const transcript = desktopTranscript({
        messages,
        runs: [run],
        tools: complete,
        executions: saved.map(({ saved }) => nativeToolExecution(saved)),
        storeId: 'store',
        sessionId: 'child',
      }).messages;
      const visible = completeNativeToolMessages([nonTool, ...transcript], complete);
      expect(visible).toContain(nonTool);
      const rows = visible.filter((message) => message.role === 'tool');
      expect(rows).toHaveLength(count);
      await render(rows);
      expect(host.querySelectorAll('.tool-activity')).toHaveLength(count);
      expect(host.querySelectorAll('.tool-step-target')).toHaveLength(count);
      for (const row of rows) expect(row.target).toContain(path);
    }
    const transcript = desktopTranscript({
      messages,
      runs: [run],
      tools: facts,
      storeId: 'store',
      sessionId: 'child',
    }).messages;
    const inputPending = facts.map((fact) => ({ ...fact, inputPending: true }));
    expect(
      completeNativeToolMessages(transcript, inputPending).filter(
        (message) => message.role === 'tool',
      ),
    ).toHaveLength(0);
    const pendingIds = new Set(receipts.map((message) => message.id));
    expect(
      completeNativeToolMessages(transcript, facts, pendingIds).filter(
        (message) => message.role === 'tool',
      ),
    ).toHaveLength(0);
    await render(
      completeNativeToolMessages(transcript, inputPending).filter(
        (message) => message.role === 'tool',
      ),
    );
    expect(host.querySelector('.tool-activity')).toBeNull();
    expect(host.querySelector('.file-link')).toBeNull();
  });
});

test('presentation retains only a previously complete exact tool through receipt metadata handoff and clears it across scopes or conflicts', async () => {
  await fixture(async ({ host, render }) => {
    const presentation = new NativeToolPresentation();
    const tool = execution();
    const { model, receipt, saved } = history(tool);
    const unverified = desktopTranscript({
      messages: [model, receipt],
      runs: [run],
      tools: [],
      executions: [nativeToolExecution(saved)],
      storeId: 'store',
      sessionId: 'child',
    }).messages.filter((message) => message.role === 'tool');
    expect(unverified[0]!.target).toBeUndefined();
    const unseen = presentation.project('scope-a', unverified, [], []);
    expect(unseen).toHaveLength(0);
    await render(unseen);
    expect(host.querySelectorAll('.tool-activity')).toHaveLength(0);

    const liveEntries = liveToolMessages(
      {
        storeId: 'store',
        session: { id: 'child' },
        runs: [run],
        executions: [nativeToolExecution({ ...tool, status: 'running' })],
      },
      [model],
    );
    const completeLive = presentation.project('scope-a', [], [], liveEntries);
    expect(completeLive).toHaveLength(1);
    expect(completeLive[0]!.target).toBe(path);
    expect(completeLive[0]!.status).toBe('running');
    await render(completeLive);
    expect(host.querySelector('.tool-step-target')?.textContent).toBe(path);

    const retained = presentation.project('scope-a', unverified, [], []);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.id).toBe(receipt.id);
    expect(retained[0]!.target).toBe(path);
    expect(retained[0]!.status).toBeUndefined();
    expect(retained[0]!.executionUnconfirmed).toBe(true);
    await render(retained);
    expect(host.querySelector('.tool-step-target')?.textContent).toBe(path);
    expect(host.querySelector('.file-link')).toBeNull();

    const fact = nativeToolMessageFact({
      execution: saved,
      message: receipt,
      messages: [model, receipt],
      sessionId: 'child',
    })!;
    const confirmed = desktopTranscript({
      messages: [model, receipt],
      runs: [run],
      tools: [fact],
      storeId: 'store',
      sessionId: 'child',
    }).messages.filter((message) => message.role === 'tool');
    const accepted = presentation.project('scope-a', confirmed, [fact], []);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.target).toBe(path);
    expect(accepted[0]!.status).toBe('completed');
    await render(accepted);
    expect(host.querySelector('.tool-step-target')?.textContent).toBe(path);

    expect(presentation.project('other-session', [], [], [])).toEqual([]);
    const returned = presentation.project('scope-a', unverified, [], []);
    expect(returned).toHaveLength(1);
    expect(returned[0]!.target).toBe(path);
    expect(returned[0]!.executionUnconfirmed).toBe(true);
    await render(returned);
    expect(host.querySelector('.file-link')).toBeNull();

    const bounded = new NativeToolPresentation();
    const bridge = {};
    expect(
      bounded.project('scope-a', confirmed, [fact], [], { bridge, key: 'generation/store' }),
    ).toHaveLength(1);
    expect(
      bounded.project('scope-a', unverified, [], [], { bridge, key: 'new-generation/store' }),
    ).toEqual([]);
    expect(
      bounded.project('scope-a', confirmed, [fact], [], { bridge, key: 'new-generation/store' }),
    ).toHaveLength(1);
    expect(
      bounded.project('scope-a', unverified, [], [], { bridge: {}, key: 'new-generation/store' }),
    ).toEqual([]);

    expect(
      presentation.project(
        'scope-a',
        unverified.map((message) => ({ ...message, presentationKey: 'different-exact-tool' })),
        [],
        [],
      ),
    ).toHaveLength(0);
    expect(presentation.project('scope-b', unverified, [], [])).toHaveLength(0);
    expect(presentation.project('scope-b', [], [], liveEntries)).toHaveLength(1);
    expect(
      presentation.project(
        'scope-b',
        [],
        [],
        liveEntries.map((entry) => ({
          ...entry,
          execution: { ...entry.execution, inputReady: false },
          message: { ...entry.message, target: undefined },
        })),
      ),
    ).toHaveLength(0);
    const conflict = presentation.project(
      'scope-b',
      unverified,
      [{ ...fact, inputPending: true }],
      [],
    );
    expect(conflict).toHaveLength(0);
    expect(presentation.project('scope-b', unverified, [], [])).toHaveLength(0);
    await render(conflict);
    expect(host.querySelectorAll('.tool-activity')).toHaveLength(0);
  });
});
