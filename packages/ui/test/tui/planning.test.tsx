import { expect, test } from 'bun:test';
import type {
  Command,
  FollowUpCommandRequest,
  SessionView,
  StartCommandRequest,
  SteerCommandRequest,
} from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../src/tui';
import { isFixedTuiCommandName, parseTuiCommand } from '../../src/tui/commands';

function fixture(active = false) {
  let next = 0,
    foreign = false;
  const posts: {
      session: string;
      request: StartCommandRequest | FollowUpCommandRequest | SteerCommandRequest;
    }[] = [],
    gets: { id: string; session: string }[] = [];
  const snapshot = (id: string): TuiSnapshot => ({
    storeId: 'store',
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id,
        workspaceId: 'w',
        rootSessionId: id,
        parentSessionId: null,
        title: id,
        contextSelectionId: 'selection',
        controlRevision: '0',
        nextSeq: '0',
        deletedAt: null,
      },
      runs: active
        ? [
            {
              id: 'original-run',
              sessionId: id,
              originCommandId: 'original-work',
              originStoreId: 'store',
              status: 'waiting_execution',
              isActive: true,
              createdAt: 1,
              finishedAt: null,
              reason: null,
            },
          ]
        : [],
      executions: [],
      messages: [],
    } as SessionView,
    messages: [],
    interactions: [],
  });
  const receipt = (
    request: StartCommandRequest | FollowUpCommandRequest | SteerCommandRequest,
    session: string,
  ): Command => ({
    id: request.commandId,
    sessionId: session,
    originStoreId: 'store',
    kind: request.kind,
    status: 'accepted',
    receipt: {},
    cancelRequestedAt: null,
  });
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `plan-${++next}`,
    listSessions: async () => [],
    readSession: async (id) => snapshot(id),
    submit: async (session, request) => {
      posts.push({ session, request });
      return receipt(request, session);
    },
    answer: async () => {
      throw Error('unused answer');
    },
    cancel: async () => {
      throw Error('planning must not cancel');
    },
    getCommand: async (id, session) => {
      gets.push({ id, session });
      const original = posts.find((p) => p.request.commandId === id)!;
      return {
        ...receipt(original.request, original.session),
        ...(foreign ? { kind: 'input.steer' } : {}),
      };
    },
  };
  return {
    controller: new TuiController(port),
    port,
    posts,
    gets,
    foreign: (value: boolean) => {
      foreign = value;
    },
  };
}
function inputs(request: StartCommandRequest | FollowUpCommandRequest | SteerCommandRequest) {
  if (request.kind === 'input.steer') throw Error('Planning cannot steer');
  return request.extensionInputs;
}
const extensionInputs = [
  { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
];
test('fixed plan grammar preserves explicit task and cannot become a Skill', () => {
  expect(parseTuiCommand('/plan')).toEqual({ kind: 'plan' });
  expect(parseTuiCommand('/plan 中文\n🙂任务')).toEqual({ kind: 'plan', task: '中文\n🙂任务' });
  expect(isFixedTuiCommandName('plan')).toBe(true);
});
test('empty slash and ShiftTab toggle only original scope draft with zero command or permission mutation', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.controller.setDraft('/plan');
  await f.controller.send();
  expect(f.controller.state.planning).toBe(true);
  expect(f.controller.state.draft).toBe('');
  await f.controller.select('b');
  expect(f.controller.state.planning).toBe(false);
  await f.controller.select('a');
  expect(f.controller.state.planning).toBe(true);
  const ui = render(<TuiSession controller={f.controller} />);
  ui.stdin.write('\u001b[Z');
  await Bun.sleep(10);
  expect(f.controller.state.planning).toBe(false);
  expect(f.posts).toHaveLength(0);
  ui.unmount();
});
test('active Run planning is one frozen follow-up and never steer or permanent mode control', async () => {
  const f = fixture(true);
  await f.controller.select('a');
  f.controller.setDraft('/plan 原后继任务🙂');
  await f.controller.send();
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]!.request).toEqual({
    kind: 'input.follow_up',
    expectedStoreId: 'store',
    commandId: 'plan-1',
    afterRunId: 'original-run',
    contextSelectionId: 'selection',
    content: '原后继任务🙂',
    extensionInputs,
  });
  expect(Object.isFrozen(f.posts[0]!.request)).toBe(true);
  expect(Object.isFrozen(inputs(f.posts[0]!.request)![0]!.input)).toBe(true);
  expect(f.controller.state.planning).toBe(false);
  f.controller.setDraft('普通新引导');
  await f.controller.send();
  expect(f.posts[1]!.request.kind).toBe('input.steer');
  expect('extensionInputs' in f.posts[1]!.request).toBe(false);
});
test('unknown plan preserves original envelope and draft; lookup after Session switch only reads original Command', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.controller.togglePlanning();
  f.port.submit = async (session, request) => {
    f.posts.push({ session, request });
    throw Error('physical response lost');
  };
  f.controller.setDraft('原计划任务');
  await f.controller.send();
  expect(f.controller.state.intent?.phase).toBe('unknown');
  expect(f.controller.state.planning).toBe(true);
  await f.controller.select('b');
  f.controller.togglePlanning();
  f.controller.setDraft('另一个原草稿');
  await f.controller.send();
  expect(f.posts).toHaveLength(1);
  f.foreign(true);
  await f.controller.lookup();
  expect(f.controller.state.intent?.phase).toBe('unknown');
  f.foreign(false);
  await f.controller.lookup();
  expect(f.gets).toEqual([
    { id: 'plan-1', session: 'a' },
    { id: 'plan-1', session: 'a' },
  ]);
  expect(inputs(f.posts[0]!.request)).toEqual(extensionInputs);
  expect(f.controller.state.planning).toBe(true);
  expect(f.controller.state.draft).toBe('另一个原草稿');
  await f.controller.select('a');
  expect(f.controller.state.planning).toBe(false);
  expect(f.controller.state.draft).toBe('');
});
test('a later explicit toggle survives original accepted lookup and stale drafting cannot POST', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.controller.togglePlanning();
  f.port.submit = async (session, request) => {
    f.posts.push({ session, request });
    throw Error('lost');
  };
  f.controller.setDraft('original');
  await f.controller.send();
  f.controller.togglePlanning();
  f.controller.togglePlanning();
  f.controller.setDraft('new local planning');
  await f.controller.lookup();
  expect(f.controller.state.planning).toBe(true);
  expect(f.controller.state.draft).toBe('new local planning');
  f.controller.observationUnavailable('actual_sse_closed');
  await f.controller.send();
  expect(f.posts).toHaveLength(1);
});
