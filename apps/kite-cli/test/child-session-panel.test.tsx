import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { TuiRuntimeClientFacade } from '../src/adapters/tui/session-adapter';
import App from '../src/tui/App';
import { createInitialState } from '../src/tui/initialState';
import { TuiUserInputProvider } from '../src/tui/provider';
import type { Action } from '../src/tui/reducers';
import { acceptedEnvelope } from './helpers/accepted-envelope';

type Reader = NonNullable<TuiRuntimeClientFacade['childSessionReader']>;

async function shown(frame: () => string | undefined, text: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(frame() ?? '').includes(text)) {
    if (Date.now() > deadline) throw new Error(`Expected ${JSON.stringify(text)} in ${frame()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const entry = {
  sessionId: 'child-a',
  parentSessionId: 'parent-a',
  agentId: 'agent-a',
  taskId: 'task-a',
  revision: 3,
  updatedAtMs: 1,
  displayName: 'Inspect files',
} as const;

function childHistory() {
  return {
    threadId: entry.sessionId,
    messages: [],
    runtimeEvents: [
      acceptedEnvelope(
        {
          type: 'user.message',
          messageId: 'message-a',
          kind: 'task',
          text: 'Inspect child context',
        },
        { sessionId: entry.sessionId },
      ),
    ],
    interrupt: null,
    modelProvider: 'test',
    modelName: 'test-model',
    thinkingLevel: null,
    plan: null,
    interactionMode: 'auto' as const,
    recovery: 'normal' as const,
  };
}

test('reads a child transcript without mutating or switching the parent', async () => {
  const calls: string[] = [];
  const actions: Action[] = [];
  let aborts = 0;
  const reader: Reader = {
    list: async (parent, limit) => {
      calls.push(`list:${parent}:${limit}`);
      return { entries: [entry] };
    },
    load: async (parent, child) => {
      calls.push(`load:${parent}:${child}`);
      return {
        projection: {
          schema: 'kite.runtime-projection.v2',
          sessionId: child,
          revision: 3,
          lifecycle: 'open',
          interactionQueue: { revision: 3, interactions: [] },
        },
        history: childHistory(),
      };
    },
  };
  const view = render(
    <App
      state={{ ...createInitialState(), activeSessionId: 'parent-a' }}
      dispatch={(action) => actions.push(action)}
      onToggleReason={() => undefined}
      provider={new TuiUserInputProvider()}
      childSessionReader={reader}
      onAbort={() => {
        aborts++;
      }}
    />,
  );

  view.stdin.write('\u0007');
  await shown(view.lastFrame, 'Inspect files');
  expect(calls).toEqual(['list:parent-a:100']);
  view.stdin.write('\u0003');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(aborts).toBe(0);
  expect(actions.some((action) => action.type === 'CTRL_C')).toBe(false);

  view.stdin.write('\r');
  await shown(view.lastFrame, 'Inspect child context');
  expect(calls).toContain('load:parent-a:child-a');
  expect(actions.some((action) => action.type === 'SWITCH_SESSION')).toBe(false);
  expect(actions.some((action) => action.type === 'LOAD_SESSION_PENDING')).toBe(false);

  view.stdin.write('\u001b');
  await shown(view.lastFrame, 'Inspect files');
  view.stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(view.lastFrame()).not.toContain('子 Agent 线程');
});

test('discards a late child page when the active parent changes', async () => {
  let resolveOld!: (value: Awaited<ReturnType<Reader['list']>>) => void;
  const reader: Reader = {
    list: (parent) =>
      parent === 'parent-a'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ entries: [] }),
    load: async () => {
      throw new Error('unexpected child read');
    },
  };
  const makeApp = (parent: string) => (
    <App
      state={{ ...createInitialState(), activeSessionId: parent }}
      dispatch={() => undefined}
      onToggleReason={() => undefined}
      provider={new TuiUserInputProvider()}
      childSessionReader={reader}
    />
  );
  const view = render(makeApp('parent-a'));
  view.stdin.write('\u0007');
  await shown(view.lastFrame, '正在读取子线程');
  view.rerender(makeApp('parent-b'));
  resolveOld({ entries: [entry] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.lastFrame()).not.toContain('Inspect files');
  view.stdin.write('\u0007');
  await shown(view.lastFrame, '当前父会话没有独立子线程');
});

test('paginates child rows and lets a failed page retry without changing the parent', async () => {
  const second = { ...entry, sessionId: 'child-b', taskId: 'task-b', displayName: 'Check tests' };
  const cursor = { updatedAtMs: 1, sessionId: entry.sessionId };
  let secondPageAttempts = 0;
  const reader: Reader = {
    list: async (_parent, _limit, next) => {
      if (!next) return { entries: [entry], nextCursor: cursor };
      secondPageAttempts++;
      if (secondPageAttempts === 1) throw new Error('temporary read failure');
      return { entries: [second] };
    },
    load: async () => {
      throw new Error('unexpected child read');
    },
  };
  const actions: Action[] = [];
  const view = render(
    <App
      state={{ ...createInitialState(), activeSessionId: 'parent-a' }}
      dispatch={(action) => actions.push(action)}
      onToggleReason={() => undefined}
      provider={new TuiUserInputProvider()}
      childSessionReader={reader}
    />,
  );
  view.stdin.write('\u0007');
  await shown(view.lastFrame, 'Inspect files');
  view.stdin.write('n');
  await shown(view.lastFrame, 'temporary read failure');
  view.stdin.write('r');
  await shown(view.lastFrame, 'Check tests');
  expect(secondPageAttempts).toBe(2);
  expect(actions.some((action) => action.type === 'SWITCH_SESSION')).toBe(false);
});
