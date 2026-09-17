import { afterAll, afterEach, expect, test } from 'bun:test';
import type { RuntimeLogQueryPort } from '@kite-ai/runtime-host/storage';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { Conversation } from '../../../packages/kite-client-ui/src/Conversation';
import type { RuntimeEvent } from '../../kite-service/src/bootstrap/runtime/state-runtime';
import { childRuntimeToolCallId } from '../../kite-service/src/runtime/tool-execution/subagent-tool-identity';
import { createKiteRuntimeHistoryClient } from '../../kite-service/src/runtime-client/history-adapter';
import { projectEvent } from '../src/presentation';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
});
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(dom.window, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node,
  Element: dom.window.Element,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: TestResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
}
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('legacy multiagent history rebuilds three owned cards and hides child Tool failures', async () => {
  const sessionId = 'legacy-three-subagents';
  const raw: RuntimeEvent[] = [
    {
      type: 'user.message_appended',
      messageId: 'prompt-1',
      content: 'Inspect three areas.',
    } as RuntimeEvent,
    { type: 'turn.started', turnId: 'turn-1' } as RuntimeEvent,
  ];
  const parents: string[] = [];
  const children: string[] = [];
  const childTools: string[] = [];
  for (let index = 0; index < 3; index++) {
    const parentToolCallId = `parent-task-${index}`;
    const invocationId = `capability-${index}`;
    const childInvocationId = `child-${index}`;
    const modelInvocationId = `child-model-${index}`;
    const modelToolCallId = `child-shell-${index}`;
    const args = { command: `inspect area ${index}` };
    const childToolCallId = childRuntimeToolCallId({
      parentToolCallId,
      subagentId: childInvocationId,
      modelInvocationId,
      modelToolCallId,
      toolName: 'shell_execute',
      args,
    });
    parents.push(parentToolCallId);
    children.push(childInvocationId);
    childTools.push(childToolCallId);
    raw.push(
      {
        type: 'tool.queued',
        toolCallId: parentToolCallId,
        modelMessageId: 'model-parent',
        name: 'task',
        args: { subagent_type: 'explore', task: `Inspect ${index}` },
        presentation: 'hidden',
      } as RuntimeEvent,
      { type: 'tool.started', toolCallId: parentToolCallId } as RuntimeEvent,
      {
        type: 'capability.invocation_recorded',
        invocationId,
        toolCallId: parentToolCallId,
        capabilityId: 'builtin:task',
        capabilityRevision: '2'.repeat(64),
        argumentsDigest: '3'.repeat(64),
        authorizationDigest: '4'.repeat(64),
        admissionDigest: '5'.repeat(64),
        effectiveEffectsDigest: '6'.repeat(64),
        effectiveEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'none' },
        receiptRequirement: 'control_receipt',
        recordedAt: '2026-09-01T00:00:00.000Z',
      } as RuntimeEvent,
      {
        type: 'capability.subagent_dispatch_intent_recorded',
        invocationId,
        attempt: 1,
        purpose: 'start',
        childInvocationId,
        taskArtifact: {
          artifactId: `pa_${'7'.repeat(64)}`,
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'8'.repeat(64)}`,
          byteLength: 128,
        },
        dispatchIntentDigest: `sha256:${'9'.repeat(64)}`,
        recordedAt: '2026-09-01T00:00:01.000Z',
      } as RuntimeEvent,
      // Older journals emitted neither parentToolCallId here nor owner facts
      // on the child Tool. Service history reconstruction must supply both.
      {
        type: 'subagent.started',
        subagent: { id: childInvocationId, role: 'explore', name: `Inspect area ${index}` },
      } as RuntimeEvent,
      {
        type: 'subagent.step',
        subagent: {
          id: childInvocationId,
          stepId: `step-${index}`,
          toolCallId: modelToolCallId,
          modelInvocationId,
          toolName: 'shell_execute',
          toolArgs: args,
        },
      } as RuntimeEvent,
      {
        type: 'tool.queued',
        toolCallId: childToolCallId,
        modelInvocationId,
        modelMessageId: modelInvocationId,
        name: 'shell_execute',
        args,
      } as RuntimeEvent,
      { type: 'tool.started', toolCallId: childToolCallId } as RuntimeEvent,
      {
        type: 'tool.failed',
        toolCallId: childToolCallId,
        failure: { kind: 'tool_runtime_error', message: 'Child tool failed.' },
      } as RuntimeEvent,
      {
        type: 'subagent.failed',
        subagent: {
          id: childInvocationId,
          error: 'Interrupted.',
          summary: 'Inspection interrupted.',
        },
      } as RuntimeEvent,
      {
        type: 'tool.failed',
        toolCallId: parentToolCallId,
        failure: { kind: 'unknown', message: 'Parent interrupted.' },
      } as RuntimeEvent,
    );
  }
  raw.push({
    type: 'turn.aborted',
    turnId: 'turn-1',
    reason: 'Interrupted.',
    cause: 'error',
  } as RuntimeEvent);
  const records = raw.map((event, index) => ({
    sessionId,
    sequence: index + 1,
    eventId: `event-${index + 1}`,
    createdAt: 1_000 + index,
    event,
  }));
  const logs: RuntimeLogQueryPort<RuntimeEvent> = {
    listSessions: () => ({
      entries: [
        { sessionId, name: 'Three agents', updatedAt: 1_000, lastSequence: records.length },
      ],
      hasMore: false,
    }),
    listEvents: (request) => {
      const matching = records.filter(
        (record) =>
          record.sequence > (request.afterSequence ?? 0) &&
          record.sequence < (request.beforeSequence ?? Number.POSITIVE_INFINITY),
      );
      const entries = matching.slice(0, request.limit);
      return {
        entries,
        hasMore: matching.length > entries.length,
        observedLastSequence: records.length,
        ...(matching.length > entries.length ? { nextCursor: entries.at(-1)!.sequence } : {}),
      };
    },
    close: () => undefined,
  };
  const history = createKiteRuntimeHistoryClient(logs);
  const transcript = await history.loadSession(sessionId);
  expect(transcript.events.filter((event) => event.type === 'subagent.started')).toHaveLength(3);
  for (let index = 0; index < 3; index++) {
    expect(transcript.events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.started',
        subagentId: children[index],
        parentToolCallId: parents[index],
      }),
    );
    expect(transcript.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.queued',
        toolId: childTools[index],
        presentation: 'hidden',
        presentationOwner: { subagentId: children[index], parentToolCallId: parents[index] },
      }),
    );
    expect(transcript.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolId: childTools[index],
        presentation: 'hidden',
        presentationOwner: { subagentId: children[index], parentToolCallId: parents[index] },
      }),
    );
  }
  const messages = transcript.events.reduce(projectEvent, [] as Parameters<typeof projectEvent>[0]);
  expect(messages.filter((message) => message.role === 'subagent')).toHaveLength(3);
  expect(messages.filter((message) => message.role === 'tool')).toHaveLength(6);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root!.render(
      <Conversation
        messages={messages}
        loading={false}
        selected
        connected
        saveReading={() => {}}
      />,
    ),
  );
  expect(document.querySelectorAll('.reading-column > .message.tool-activity')).toHaveLength(3);
  expect(document.querySelectorAll('.message-group > .message.tool-activity')).toHaveLength(0);
  const primaryCards = Array.from(
    document.querySelectorAll<HTMLElement>('.reading-column > .message.tool-activity'),
  );
  for (const card of primaryCards) {
    const expand = card.querySelector<HTMLButtonElement>('button.tool-activity-summary');
    if (!expand) throw new Error('Parent task card is not expandable.');
    await act(() => expand.click());
    const childFailure = card.querySelector<HTMLElement>(
      '.subagent-process .message.tool-activity',
    );
    expect(childFailure).not.toBeNull();
    expect(childFailure?.getAttribute('aria-label')).toContain('失败');
    expect(card.querySelectorAll('.subagent-process .tool-activity-step')).toHaveLength(0);
  }
  expect(document.querySelectorAll('.subagent-process .message.tool-activity')).toHaveLength(3);
  const again = await history.loadSession(sessionId);
  const restored = again.events.reduce(projectEvent, [] as Parameters<typeof projectEvent>[0]);
  expect(restored.map((message) => message.id)).toEqual(messages.map((message) => message.id));
  await act(() =>
    root!.render(
      <Conversation
        messages={restored}
        loading={false}
        selected
        connected
        saveReading={() => {}}
      />,
    ),
  );
  expect(document.querySelectorAll('.reading-column > .message.tool-activity')).toHaveLength(3);
});

test('subagent tool steps keep labels and targets separate from results', async () => {
  const events = [
    {
      type: 'tool.queued',
      toolId: 'parent',
      toolName: 'task',
      arguments: { name: 'Inspect source' },
      presentation: 'standalone',
      summary: 'Queued.',
    },
    {
      type: 'subagent.started',
      subagentId: 'child',
      parentToolCallId: 'parent',
      role: 'explore',
      name: 'Inspect source',
    },
    {
      type: 'subagent.step',
      subagentId: 'child',
      stepId: 'read-step',
      toolCallId: 'read-call',
      toolName: 'read_file',
      arguments: { path: 'src/example.ts' },
      status: 'started',
    },
    {
      type: 'subagent.step',
      subagentId: 'child',
      stepId: 'read-step',
      toolCallId: 'read-call',
      toolName: 'read_file',
      summary: 'const privateContents = 123;\n'.repeat(40),
      status: 'completed',
    },
    {
      type: 'subagent.step',
      subagentId: 'child',
      stepId: 'failed-step',
      toolCallId: 'failed-call',
      toolName: 'shell_execute',
      arguments: { command: 'rg missing src' },
      status: 'started',
    },
    {
      type: 'subagent.step',
      subagentId: 'child',
      stepId: 'failed-step',
      toolCallId: 'failed-call',
      toolName: 'shell_execute',
      summary: `No matching file.\n${'x'.repeat(500)}`,
      status: 'failed',
    },
    {
      type: 'subagent.failed',
      subagentId: 'child',
      summary: 'Source inspection stopped after the missing file.',
    },
    {
      type: 'tool.failed',
      toolId: 'parent',
      presentation: 'standalone',
      summary: 'Tool execution failed.',
    },
  ] as const;
  const messages = events.reduce(projectEvent, [] as Parameters<typeof projectEvent>[0]);
  expect(messages.find((message) => message.id === 'subagent:child')?.steps).toMatchObject([
    { text: 'read_file', arguments: { path: 'src/example.ts' }, status: 'completed' },
    { text: 'shell_execute', arguments: { command: 'rg missing src' }, status: 'failed' },
  ]);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root!.render(
      <Conversation
        messages={messages}
        loading={false}
        selected
        connected
        saveReading={() => {}}
      />,
    ),
  );
  const card = document.querySelector<HTMLElement>('.reading-column > .message.tool-activity');
  expect(card).not.toBeNull();
  expect(card?.textContent).not.toContain('Tool execution failed.');
  await act(() => card!.querySelector<HTMLButtonElement>('button.tool-activity-summary')!.click());
  const readStep = card!.querySelector<HTMLElement>(
    '.subagent-process > .tool-activity > .tool-activity-step',
  );
  expect(readStep?.querySelector('.tool-step-title')?.textContent).toBe('读取');
  expect(readStep?.querySelector('.tool-step-target')?.textContent).toBe('src/example.ts');
  expect(readStep?.textContent).not.toContain('privateContents');
  const failedStep = card!.querySelector<HTMLElement>('.subagent-process > .shell-activity');
  expect(failedStep?.querySelector('.tool-activity-title')?.textContent).toBe('运行');
  expect(failedStep?.querySelector('.tool-command')?.textContent).toBe('rg missing src');
  expect(failedStep?.querySelector('.tool-step-preview')).toBeNull();
  expect(failedStep?.textContent).not.toContain('No matching file.');
  await act(() =>
    failedStep!.querySelector<HTMLButtonElement>('button.tool-activity-summary')!.click(),
  );
  expect(failedStep?.querySelector('.shell-output')?.textContent).toContain(
    `No matching file.\n${'x'.repeat(500)}`,
  );
});

test('generic task failure remains visible without a concrete child terminal reason', async () => {
  const events = [
    {
      type: 'tool.queued',
      toolId: 'parent',
      toolName: 'task',
      arguments: { name: 'Inspect source' },
      presentation: 'standalone',
      summary: 'Queued.',
    },
    {
      type: 'subagent.started',
      subagentId: 'child',
      parentToolCallId: 'parent',
      role: 'explore',
      name: 'Inspect source',
    },
    {
      type: 'tool.failed',
      toolId: 'parent',
      presentation: 'standalone',
      summary: 'Tool execution failed.',
    },
  ] as const;
  const messages = events.reduce(projectEvent, [] as Parameters<typeof projectEvent>[0]);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root!.render(
      <Conversation
        messages={messages}
        loading={false}
        selected
        connected
        saveReading={() => {}}
      />,
    ),
  );
  expect(document.querySelector('.tool-step-preview')?.textContent).toBe('Tool execution failed.');
});
