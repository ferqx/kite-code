import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { type PermissionGrantFacts, PermissionGrantsPanel } from '../src/permissions';

const facts = (sessionId = 'child', observationId = 1): PermissionGrantFacts => ({
  observationId,
  page: {
    storeId: 'store',
    sessionId,
    revision: '4',
    items: [
      {
        seq: '1',
        grant: {
          id: 'approval',
          originStoreId: 'store',
          sessionId,
          workspaceId: 'w',
          kind: 'tool',
          definitionId: 'fixture.command',
          definitionVersion: '2',
          inputDigest: 'a'.repeat(64),
          commandDigest: 'b'.repeat(64),
          interactionId: 'approval',
          decisionRevision: '1',
          executionId: 'original',
        },
      },
    ],
    highWaterSeq: '1',
    upperSeq: '1',
    nextAfterSeq: null,
    snapshotCursor: '4',
  },
});
test('actual DOM keyboard clears only explicit observed grant epoch once; late response never changes replacement and absent handler is read-only', async () => {
  const dom = new JSDOM('<div id="root"></div>'),
    prior = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
    };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host),
    calls: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const render = async (value: PermissionGrantFacts, write = true) =>
    act(async () =>
      root.render(
        <PermissionGrantsPanel
          facts={value}
          onClear={
            write
              ? async (id) => {
                  calls.push(id);
                  await barrier;
                }
              : undefined
          }
        />,
      ),
    );
  try {
    await render(facts(), false);
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('实际会话：child');
    expect(host.textContent).toContain('fixture.command@2');
    expect(host.textContent).toContain('原执行 original');
    await render(facts('child', 2));
    const button = host.querySelector('button')!;
    expect(button.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
    await act(async () => {
      button.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      button.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }),
      );
      button.click();
    });
    expect(calls).toEqual([2]);
    await render(facts('other', 3));
    await act(async () => release());
    expect(host.textContent).toContain('实际会话：other');
    expect(host.textContent).not.toContain('回执已收到');
    await render(facts('other', 4), false);
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('授权目录只读');
  } finally {
    release();
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
