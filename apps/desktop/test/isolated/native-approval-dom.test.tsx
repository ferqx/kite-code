import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Execution, Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { prepareDesktopDom } from '../native-page-dom.fixture';

// The original Radix Portal selects its layout effect at import time, as in the model-picker fixture.
const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const priorBootstrap = {
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
const { desktopToolMessage, NativeToolMessage } = await import('../../src/native-tool-messages');
Object.assign(globalThis, priorBootstrap);
bootstrap.window.close();

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const layout = prepareDesktopDom(dom),
    previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  return {
    dom,
    host,
    root,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      layout();
      Object.assign(globalThis, previous);
    },
  };
}
const card: Interaction = {
  id: 'approval',
  originStoreId: 'store',
  sessionId: 's',
  runId: 'r',
  executionId: 'tool',
  presentationSessionId: 's',
  ancestry: ['s'],
  attempt: 1,
  kind: 'approval',
  definitionId: 'shell.launch',
  definitionVersion: '1',
  inputDigest: 'original-input',
  policyRevision: 'p1',
  requiredRefs: [],
  request: null,
  answer: null,
  revision: '1',
  acceptedDecisionRevision: null,
  state: 'pending',
};

test('the original Approval form consumes the verified complete request and submits only the original card and offered grant', async () => {
  const f = fixture(),
    answers: { id: string; answer: unknown }[] = [];
  const request = {
    definitionId: 'shell.launch',
    definitionVersion: '1',
    grants: ['approve_once', 'same_command'],
    policy: { reason: '原人工原因' },
    input: { command: 'printf "原命令 雪🙂"\r\n' },
  };
  const text = JSON.stringify(request),
    content = new TextEncoder().encode(text);
  const reference = {
    id: 'body',
    mediaType: 'application/json',
    size: String(content.length),
    scope: { kind: 'execution' as const, id: 'tool' },
  };
  const original = {
    ...card,
    request: {
      ...request,
      input: {},
      policy: { review: { kind: 'artifact', complete: true, reference } },
    },
  };
  const render = (interaction = original) =>
    f.root.render(
      <InteractionCard
        interaction={interaction}
        onReadAttachment={async () => ({
          reference: { ...reference, hash: createHash('sha256').update(content).digest('hex') },
          content,
        })}
        onAnswer={(current, answer) => {
          answers.push({ id: current.id, answer });
        }}
        renderApproval={(props) => <NativeApproval {...props} />}
      />,
    );
  try {
    await act(async () => render());
    const approve = () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '仅批准这一次',
      )!;
    expect(approve().disabled).toBe(true);
    expect(f.host.querySelector('[aria-label="更多批准方式"]')).toBeNull();
    await act(async () => approve().click());
    expect(answers).toEqual([]);
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Load complete attachment')!
        .click(),
    );
    expect(f.host.querySelector('.approval-command')!.textContent).toBe(request.input.command);
    expect(approve().disabled).toBe(false);
    const menu = f.host.querySelector<HTMLButtonElement>('[aria-label="更多批准方式"]')!;
    await act(async () =>
      menu.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
    const same = f.dom.window.document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(same.textContent).toBe('批准本次及本会话相同命令');
    await act(async () => same.click());
    expect(answers).toEqual([
      { id: 'approval', answer: { kind: 'approval', decision: 'approve', grant: 'same_command' } },
    ]);
    await act(async () => render({ ...original, id: 'other-card', revision: '2' }));
    expect(approve().disabled).toBe(true);
    await act(async () => approve().click());
    expect(answers).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('original tool labels distinguish saved, accepted and automatic decisions without converting approval into tool success', async () => {
  const f = fixture();
  const human: NonNullable<Execution['authorization']>['human'] = {
    interactionId: 'original',
    state: 'answered',
    revision: '2',
    acceptedDecisionRevision: null,
    accepted: false,
    decision: 'approve',
    grant: 'same_command',
  };
  const render = async (
    authorization: NonNullable<Execution['authorization']>,
    status: Execution['status'] = 'failed',
  ) => {
    const model = desktopToolMessage(
      { definitionId: 'files.write', definitionVersion: '2', status, authorization },
      'original-tool',
      '原结果正文',
    );
    await act(async () => f.root.render(<NativeToolMessage message={model} />));
    return model;
  };
  try {
    const saved = await render({ dispatched: false, human });
    expect(f.host.textContent).toContain('已提交批准，待核对');
    expect(saved.status).toBe('failed');
    await render({
      dispatched: false,
      human: { ...human, accepted: true, acceptedDecisionRevision: '2' },
    });
    expect(f.host.textContent).toContain('已人工批准 · 本会话相同命令');
    await render({ dispatched: false, human: { ...human, decision: 'deny' } });
    expect(f.host.textContent).toContain('人工审批已拒绝');
    expect(f.host.textContent).toContain('未执行');
    await render({ dispatched: false, human: { ...human, state: 'cancelled' } });
    expect(f.host.textContent).toContain('审批已取消');
    await render({
      dispatched: true,
      review: {
        executionId: 'review',
        status: 'succeeded',
        decision: 'approve_once',
        reason: '原自动批准原因',
        requireApproval: false,
      },
    });
    expect(f.host.textContent).toContain('已自动批准');
    await render({
      dispatched: false,
      review: {
        executionId: 'review',
        status: 'failed',
        decision: 'unavailable',
        reason: '原结果未知',
        requireApproval: false,
      },
    });
    expect(f.host.textContent).toContain('自动审批结果未知');
    for (const decision of ['ask_user', 'unavailable'] as const) {
      const reason = `原转人工原因 ${decision} 雪🙂`;
      await render(
        {
          dispatched: false,
          human: { ...human, state: 'pending', decision: null, grant: undefined },
          review: {
            executionId: 'review',
            status: decision === 'ask_user' ? 'succeeded' : 'failed',
            decision,
            reason,
            requireApproval: false,
          },
        },
        'planned',
      );
      expect(f.host.textContent).toContain('等待人工审批');
      expect(f.host.textContent).toContain(reason);
      expect(f.host.textContent).not.toContain('已人工批准');
    }
    await render(
      {
        dispatched: false,
        review: {
          executionId: 'review',
          status: 'running',
          decision: 'unavailable',
          reason: 'review_not_succeeded',
          requireApproval: false,
        },
      },
      'planned',
    );
    expect(f.host.textContent).toContain('正在自动审批');
    await render(
      {
        dispatched: false,
        review: {
          executionId: 'review',
          status: 'cancelled',
          decision: 'unavailable',
          reason: 'review_not_succeeded',
          requireApproval: false,
        },
      },
      'cancelled',
    );
    expect(f.host.textContent).toContain('自动审批已停止');
    expect(f.host.textContent).not.toContain('正在自动审批');
  } finally {
    await f.close();
  }
});
