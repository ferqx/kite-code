import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeState } from '../../src/native-bridge';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const globals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { InteractionCard } = await import('@kite-ai/ui');
const { NativeApproval } = await import('../../src/native-approval');
const { NativeApprovalGroup } = await import('../../src/native-approval-group');
const { useNativeApprovalPresentation, nativeApprovalSubmission } = await import(
  '../../src/native-approval-presentation'
);
Object.assign(globalThis, globals);
bootstrap.window.close();

const card = (id = 'original', sessionId = 'root'): Interaction => ({
  id,
  originStoreId: 'store',
  sessionId,
  runId: `${sessionId}-run`,
  executionId: `${id}-tool`,
  presentationSessionId: 'root',
  ancestry: ['root'],
  attempt: 1,
  kind: 'approval',
  definitionId: 'shell.execute',
  definitionVersion: '1',
  inputDigest: id,
  policyRevision: 'policy',
  requiredRefs: [],
  request: {
    definitionId: 'shell.execute',
    definitionVersion: '1',
    input: { command: `echo ${id}` },
    options: [
      { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
      {
        optionId: 'scope-original',
        kind: 'scope',
        presentation: { label: '本次会话批准', details: ['Only this exact command.'] },
      },
    ],
  },
  answer: null,
  revision: '1',
  acceptedDecisionRevision: null,
  state: 'pending',
});
const stateFor = (cards: Interaction[]): NativeState => ({
  generation: 1,
  creationSubmissions: [],
  inputSubmissions: [],
  permissionSubmissions: [],
  interactionSubmissions: [],
  answerSubmissions: [],
  selection: {
    storeId: 'store',
    viewGeneration: 1,
    session: backgroundItem(1, true).rootSession,
    runs: [],
    executions: [],
    interactions: cards,
    interactionsAfterId: null,
    canReadModelOutput: false,
  },
});
function deferred() {
  let resolve!: () => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function fixture(initial: NativeState) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restore = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  let state = initial,
    presentation!: ReturnType<typeof useNativeApprovalPresentation>;
  const requests: { card: Interaction; answer: unknown; flight: ReturnType<typeof deferred> }[] =
    [];
  function View() {
    presentation = useNativeApprovalPresentation(state);
    return (
      <>
        <textarea defaultValue="keep this draft" />
        <button type="button" onClick={() => {}}>
          停止任务
        </button>
        <NativeApprovalGroup
          storeId={state.selection!.storeId}
          rootSessionId={state.selection!.session.id}
          interactions={state.selection!.interactions.filter((item) => !presentation.hidden(item))}
          renderInteraction={(original, embedded) => (
            <InteractionCard
              interaction={original}
              submission={nativeApprovalSubmission(original, state)}
              onAnswer={(item, answer) => {
                const flight = deferred();
                requests.push({ card: item, answer, flight });
                return flight.promise;
              }}
              renderApproval={(props) => (
                <NativeApproval
                  {...props}
                  embedded={embedded}
                  onAnswer={(item, answer) =>
                    presentation.submit(item, () => props.onAnswer!(item, answer))
                  }
                />
              )}
            />
          )}
        />
        {presentation.notices.map((notice) => (
          <p key={notice.key} role="status">
            {notice.phase}:{notice.commandId ?? 'no-command'}:{String(notice.retryable)}
          </p>
        ))}
      </>
    );
  }
  const render = async (next = state) => {
    state = next;
    await act(async () => root.render(<View />));
  };
  await render();
  return {
    dom,
    host,
    requests,
    render,
    presentation: () => presentation,
    button: (text: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === text,
      )!,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      restore();
      Object.assign(globalThis, previous);
    },
  };
}

for (const decision of ['仅此次', '拒绝'])
  test(`${decision} closes the original layer before its promise resolves, without claiming execution or replaying`, async () => {
    const original = card(),
      state = stateFor([original]),
      f = await fixture(state);
    try {
      const button = f.button(decision);
      await act(async () => {
        button.click();
        button.click();
      });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.card).toBe(original);
      expect(f.requests[0]!.answer).toEqual(
        decision === '拒绝'
          ? { kind: 'approval', decision: 'deny' }
          : { kind: 'approval', decision: 'approve', optionId: 'once' },
      );
      expect(f.host.querySelector('.native-approval-group')).toBeNull();
      expect(f.host.textContent).not.toMatch(/正在提交|等待执行|已批准|已保存|unknown/);
      expect(f.host.querySelector('textarea')!.value).toBe('keep this draft');
      expect(f.button('停止任务').disabled).toBe(false);
      await f.render(state); // A stale pending observation does not reopen a decided card.
      expect(f.host.querySelector('.native-approval-group')).toBeNull();
      await act(async () => f.requests[0]!.flight.resolve());
      await f.render(state);
      expect(f.host.querySelector('.native-approval-group')).toBeNull();
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('an unconfirmed answer stays hidden, survives session changes, and only the original journal reconciles it', async () => {
  const original = card(),
    state = stateFor([original]),
    f = await fixture(state);
  try {
    await act(async () => f.button('仅此次').click());
    const other = stateFor([{ ...card('other'), presentationSessionId: 'other' }]);
    await f.render({
      ...other,
      selection: {
        ...other.selection!,
        session: { ...other.selection!.session, id: 'other' },
      },
    });
    await act(async () => f.requests[0]!.flight.reject(Error('lost IPC response')));
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    expect(f.host.querySelector('article')!.getAttribute('aria-label')).toBe('approval other');
    await f.render(state);
    expect(f.host.querySelector('.native-approval-group')).toBeNull();
    expect(f.host.textContent).toContain('unknown:no-command:false');
    const entry = {
      interaction: original,
      intent: {
        expectedStoreId: 'store',
        commandId: 'original-answer',
        expectedRevision: '1',
        answer: { kind: 'approval' as const, decision: 'approve' as const, optionId: 'once' },
      },
      phase: 'unknown' as const,
    };
    await f.render({ ...state, interactionSubmissions: [entry] });
    expect(f.host.textContent).toContain('unknown:original-answer:false');
    await f.render({ ...state, interactionSubmissions: [{ ...entry, phase: 'accepted' }] });
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    expect(f.host.querySelector('.native-approval-group')).toBeNull();
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('only a verified Main pre-dispatch rejection reopens the original card; a registered failure never replays', async () => {
  const original = card(),
    state = stateFor([original]),
    f = await fixture(state);
  try {
    await act(async () => f.button('仅此次').click());
    await act(async () =>
      f.requests[0]!.flight.reject(
        Object.assign(Error('attachment_not_loaded'), { code: 'attachment_not_loaded' }),
      ),
    );
    expect(f.host.querySelector('.native-approval-group')).not.toBeNull();
    expect(f.host.textContent).toContain('failed:no-command:true');
    await act(async () => f.button('拒绝').click());
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.answer).toEqual({ kind: 'approval', decision: 'deny' });
    const entry = {
      interaction: original,
      intent: {
        expectedStoreId: 'store',
        commandId: 'answer',
        expectedRevision: '1',
        answer: { kind: 'approval' as const, decision: 'deny' as const },
      },
      phase: 'failed' as const,
    };
    await f.render({ ...state, interactionSubmissions: [entry] });
    await act(async () =>
      f.requests[1]!.flight.reject(
        Object.assign(Error('attachment_not_loaded'), { code: 'attachment_not_loaded' }),
      ),
    );
    expect(f.host.querySelector('.native-approval-group')).toBeNull();
    expect(f.host.textContent).toContain('failed:answer:false');
  } finally {
    await f.close();
  }
});

test('multi-card decisions remain independent, reject a double-click on the replacement and bind changed revisions exactly', async () => {
  const first = card(),
    child = card('child-approval', 'child'),
    state = stateFor([first, child]),
    f = await fixture(state);
  try {
    await act(async () =>
      f
        .button('仅此次')
        .dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, detail: 1 })),
    );
    expect(f.host.querySelector('article')!.getAttribute('aria-label')).toBe(
      'approval child-approval',
    );
    await act(async () =>
      f
        .button('仅此次')
        .dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, detail: 2 })),
    );
    expect(f.requests).toHaveLength(1);
    await act(async () => f.button('仅此次').click());
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.card).toBe(child);
    const revised = { ...first, revision: '2' };
    await f.render(stateFor([revised]));
    await act(async () => f.requests[0]!.flight.reject(Error('late lost response')));
    expect(f.button('仅此次').disabled).toBe(false);
    await act(async () => f.button('拒绝').click());
    expect(f.requests).toHaveLength(3);
    expect(f.requests[2]!.card.revision).toBe('2');
    expect(first.answer).toBeNull();
    expect(child.answer).toBeNull();
  } finally {
    await f.close();
  }
});

test('cold saved answers suppress stale cards but not another Store or revision; questions and plans keep their lifecycle', async () => {
  const original = card();
  const state: NativeState = {
    ...stateFor([original]),
    answerSubmissions: [
      {
        scope: { storeId: 'store', sessionId: 'root', workspaceId: 'w', contextSelectionId: 'ctx' },
        subjectId: 'user',
        interaction: { id: original.id, revision: '1', kind: 'approval' },
        request: { expectedStoreId: 'store', commandId: 'cold-answer', expectedRevision: '1' },
        bodyDigest: 'body',
        requestDigest: 'request',
        phase: 'unknown',
        association: 'current',
      },
    ],
  };
  const f = await fixture(state);
  try {
    expect(f.host.querySelector('.native-approval-group')).toBeNull();
    expect(f.host.textContent).toContain('unknown:cold-answer:false');
    expect(f.requests).toHaveLength(0);
    expect(f.presentation().hidden({ ...original, revision: '2' })).toBe(false);
    expect(f.presentation().hidden({ ...original, originStoreId: 'other' })).toBe(false);
    expect(f.presentation().hidden({ ...original, kind: 'question' })).toBe(false);
    expect(f.presentation().hidden({ ...original, kind: 'plan_review' })).toBe(false);
    await f.render({ ...state, selection: { ...state.selection!, interactions: [] } });
    expect(f.host.textContent).toContain('unknown:cold-answer:false');
  } finally {
    await f.close();
  }
});

test('saved, submitting and accepted receipts stay off the foreground; cancellation and late completion do not recreate a card', async () => {
  const original = card(),
    state = stateFor([original]),
    f = await fixture(state);
  try {
    await act(async () => f.button('仅此次').click());
    const intent = {
      expectedStoreId: 'store',
      commandId: 'answer',
      expectedRevision: '1',
      answer: { kind: 'approval' as const, decision: 'approve' as const, optionId: 'once' },
    };
    for (const phase of ['saved', 'submitting', 'accepted'] as const) {
      await f.render({
        ...state,
        interactionSubmissions: [{ interaction: original, intent, phase }],
      });
      expect(f.host.querySelector('.native-approval-group')).toBeNull();
      expect(f.host.querySelector('[role="status"]')).toBeNull();
      expect(f.host.textContent).not.toMatch(/正在提交|等待执行|已批准|已保存/);
    }
    await f.render({
      ...state,
      selection: { ...state.selection!, interactions: [{ ...original, state: 'cancelled' }] },
    });
    await act(async () => f.requests[0]!.flight.resolve());
    expect(f.host.querySelector('.native-approval-group')).toBeNull();
    expect(f.requests).toHaveLength(1);
    expect(original.state).toBe('pending');
  } finally {
    await f.close();
  }
});

test('a live original POST suppresses the journal recovery projection, but never hides another command or terminal proof', async () => {
  const original = card();
  const intent = {
    expectedStoreId: 'store',
    commandId: 'original-answer',
    expectedRevision: '1',
    answer: { kind: 'approval' as const, decision: 'approve' as const, optionId: 'once' },
  };
  const journal: NonNullable<NativeState['answerSubmissions']>[number] = {
    scope: { storeId: 'store', sessionId: 'root', workspaceId: 'w', contextSelectionId: 'ctx' },
    subjectId: 'user',
    interaction: { id: original.id, revision: '1', kind: 'approval' },
    request: intent,
    bodyDigest: 'body',
    requestDigest: 'request',
    phase: 'unknown',
    association: 'current',
  };
  const state = { ...stateFor([original]), answerSubmissions: [journal] },
    f = await fixture(state);
  try {
    for (const phase of ['saved', 'submitting'] as const) {
      const live = { interaction: original, intent, phase };
      await f.render({ ...state, interactionSubmissions: [live] });
      expect(f.host.querySelector('.native-approval-group')).toBeNull();
      expect(f.host.querySelector('[role="status"]')).toBeNull();
      expect(
        nativeApprovalSubmission(original, { ...state, interactionSubmissions: [live] })?.phase,
      ).toBe(phase);
      await f.render({
        ...state,
        selection: { ...state.selection!, interactions: [] },
        interactionSubmissions: [live],
      });
      expect(f.host.querySelector('[role="status"]')).toBeNull();
    }
    await f.render({
      ...state,
      interactionSubmissions: [
        {
          interaction: original,
          intent: { ...intent, commandId: 'different-command' },
          phase: 'submitting',
        },
      ],
    });
    expect(f.host.textContent).toContain('unknown:original-answer:false');
    await f.render({
      ...state,
      interactionSubmissions: [{ interaction: original, intent, phase: 'unknown' }],
    });
    expect(f.host.textContent).toContain('unknown:original-answer:false');
    await f.render({
      ...state,
      answerSubmissions: [{ ...journal, phase: 'accepted' }],
      interactionSubmissions: [{ interaction: original, intent, phase: 'unknown' }],
    });
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    await f.render({
      ...state,
      answerSubmissions: [{ ...journal, phase: 'failed' }],
      interactionSubmissions: [{ interaction: original, intent, phase: 'submitting' }],
    });
    expect(f.host.textContent).toContain('failed:original-answer:false');
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});
