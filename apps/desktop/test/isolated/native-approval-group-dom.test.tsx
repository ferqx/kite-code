import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const originalGlobals = {
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
const { NativeApprovalGroup, nativeApprovalOwnerLabel } = await import(
  '../../src/native-approval-group'
);
Object.assign(globalThis, originalGlobals);
bootstrap.window.close();

const approval = (id: string, sessionId: string): Interaction => ({
  id,
  originStoreId: 'store',
  sessionId,
  runId: `${sessionId}-run`,
  executionId: `${id}-tool`,
  presentationSessionId: 'root',
  ancestry: sessionId === 'root' ? ['root'] : ['root', sessionId],
  attempt: 1,
  kind: 'approval',
  definitionId: 'files.write',
  definitionVersion: '2',
  inputDigest: id,
  policyRevision: 'policy',
  requiredRefs: [],
  request: {
    definitionId: 'files.write',
    definitionVersion: '2',
    grants: ['approve_once'],
    input: { path: `${id}.txt` },
  },
  answer: null,
  revision: '1',
  acceptedDecisionRevision: null,
  state: 'pending',
});

test('one paged card preserves exact decisions, attachment proof, stable child appearance and unknown status', async () => {
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
  const parent = approval('parent-approval', 'root'),
    child = approval('child-approval', 'child');
  const fullRequest = {
    ...(child.request as object),
    grants: ['approve_once', 'same_command'],
    input: { path: 'child-full.txt', content: '准确完整内容 雪🙂' },
  };
  const content = new TextEncoder().encode(JSON.stringify(fullRequest));
  const reference = {
    id: 'body',
    mediaType: 'application/json',
    size: String(content.length),
    scope: { kind: 'execution' as const, id: child.executionId },
  };
  child.request = {
    ...(child.request as object),
    input: {},
    policy: { check: { kind: 'artifact', complete: true, reference } },
  };
  const question = { ...approval('question', 'root'), kind: 'question' as const };
  const mcp = { ...approval('mcp', 'root'), request: { kind: 'mcp_source_approval' } };
  const plan = { ...approval('plan', 'root'), kind: 'plan_review' as const };
  const answers: { id: string; runId: string | null; answer: unknown }[] = [];
  let unknown = false;
  const render = (interactions = [parent, child, question, mcp, plan]) =>
    root.render(
      <NativeApprovalGroup
        interactions={interactions}
        storeId="store"
        rootSessionId="root"
        owners={[{ storeId: 'store', sessionId: 'child', runId: 'child-run', title: '文件协作者' }]}
        renderInteraction={(interaction, embedded) =>
          interaction.kind !== 'approval' || interaction.id === 'mcp' ? (
            <aside data-original-kind={interaction.id}>{interaction.kind}</aside>
          ) : (
            <InteractionCard
              compactApproval
              interaction={interaction}
              submission={
                unknown && interaction.id === parent.id
                  ? { phase: 'unknown', commandId: 'original-answer' }
                  : undefined
              }
              onReadAttachment={async () => ({
                reference: {
                  ...reference,
                  hash: createHash('sha256').update(content).digest('hex'),
                },
                content,
              })}
              onAnswer={(original, answer) => {
                answers.push({ id: original.id, runId: original.runId, answer });
              }}
              renderApproval={(props) => <NativeApproval {...props} embedded={embedded} />}
            />
          )
        }
      />,
    );
  const article = (id: string) =>
    host.querySelector<HTMLElement>(`article[aria-label="approval ${id}"]`)!;
  const button = (id: string, text: string) =>
    [...article(id).querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent === text,
    )!;
  try {
    await act(async () => render());
    const group = host.querySelector('section[aria-label="需要人工审批"]')!;
    expect(host.querySelectorAll('section[aria-label="需要人工审批"]')).toHaveLength(1);
    expect(
      [...host.querySelectorAll('strong')].filter((entry) => entry.textContent === '需要批准'),
    ).toHaveLength(1);
    expect(group.textContent).toContain('1/2');
    expect(group.textContent).not.toContain('主 Agent');
    expect(group.textContent).not.toContain('文件协作者');
    expect(group.querySelectorAll('article')).toHaveLength(1);
    expect(group.querySelector('[data-original-kind]')).toBeNull();
    expect(host.querySelectorAll('[data-original-kind]')).toHaveLength(3);
    await act(async () => button(parent.id, '拒绝').click());
    expect(answers).toEqual([
      { id: parent.id, runId: parent.runId, answer: { kind: 'approval', decision: 'deny' } },
    ]);
    unknown = true;
    await act(async () => render());
    expect(article(parent.id).textContent).toContain('审批提交结果未知');
    expect(button(parent.id, '批准一次').disabled).toBe(true);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="下一项审批"]')!.click(),
    );
    expect(group.textContent).toContain('2/2');
    expect(group.textContent).toContain('文件协作者');
    expect(group.querySelectorAll('article')).toHaveLength(1);
    expect(host.querySelector('details')).toBeNull();
    const deadline = Date.now() + 5000;
    while (!host.querySelector('[data-complete-attachment="verified"]')) {
      if (Date.now() >= deadline) throw Error('group_attachment_not_verified');
      await act(async () => await Bun.sleep(5));
    }
    expect(button(child.id, '批准一次').disabled).toBe(false);
    expect(article(child.id).textContent).toContain('child-full.txt');
    expect(host.querySelector('pre')).toBeNull();
    expect(article(child.id).querySelector('[aria-label="更多批准方式"]')).not.toBeNull();
    const icon = group.querySelector('.approval-child-icon')!.outerHTML;
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="上一项审批"]')!.click(),
    );
    expect(article(parent.id).textContent).toContain('审批提交结果未知');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="下一项审批"]')!.click(),
    );
    expect(group.querySelector('.approval-child-icon')!.outerHTML).toBe(icon);
    while (!host.querySelector('[data-complete-attachment="verified"]')) {
      if (Date.now() >= deadline) throw Error('group_attachment_not_verified_again');
      await act(async () => await Bun.sleep(5));
    }
    await act(async () => button(child.id, '批准一次').click());
    expect(answers[1]).toEqual({
      id: child.id,
      runId: child.runId,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    await act(async () => render([parent]));
    expect(host.querySelector('[aria-label="切换审批"]')).toBeNull();
    expect(host.querySelector(`article[aria-label="approval ${child.id}"]`)).toBeNull();
    expect(button(parent.id, '批准一次').disabled).toBe(true);
    // A new earlier approval must not replace the currently visible child.
    await act(async () => render([child]));
    await act(async () => render([parent, child]));
    expect(group.textContent).toContain('文件协作者');
    expect(group.textContent).toContain('2/2');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    restore();
    Object.assign(globalThis, previous);
  }
});

test('child labels require the original Store, Session and Run and never display an identity as a name', () => {
  const child = approval('child', 'child');
  const owner = { storeId: 'store', sessionId: 'child', runId: 'child-run', title: '准确名称' };
  expect(nativeApprovalOwnerLabel(child, 'store', 'root', [owner])).toBe('准确名称');
  for (const changed of [
    { storeId: 'other' },
    { sessionId: 'other' },
    { runId: 'old-run' },
    { title: 'child' },
    { title: 'e8be3f1b-0000-4000-8000-000000000001' },
  ])
    expect(nativeApprovalOwnerLabel(child, 'store', 'root', [{ ...owner, ...changed }])).toBe(
      '子 Agent',
    );
  expect(nativeApprovalOwnerLabel(child, 'other', 'root', [owner])).toBe('子 Agent');
  expect(nativeApprovalOwnerLabel(child, 'store', 'root', [owner, owner])).toBe('子 Agent');
});
