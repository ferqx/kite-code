import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { SessionPage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { nativeRootInteractionBlocksComposer } from '../../src/native';
import { NativeApproval } from '../../src/native-approval';
import type { NativeSelection } from '../../src/native-bridge';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('accurate root interaction retains its exclusive prompt while a child approval remains actionable beside parent input', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const layout = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const item = backgroundItem(1, true);
  const card: Interaction = {
    id: 'approval',
    originStoreId: 'store',
    sessionId: 'root',
    runId: 'parent-run',
    executionId: 'write',
    presentationSessionId: 'root',
    ancestry: ['root'],
    attempt: 1,
    kind: 'approval',
    definitionId: 'files.write',
    definitionVersion: '2',
    inputDigest: 'digest',
    policyRevision: 'policy',
    requiredRefs: [],
    request: {
      definitionId: 'files.write',
      definitionVersion: '2',
      input: { path: 'file.txt' },
      grants: ['approve_once'],
    },
    answer: null,
    revision: '1',
    acceptedDecisionRevision: null,
    state: 'pending',
  };
  const selection: NativeSelection = {
    storeId: 'store',
    viewGeneration: 1,
    viewSelection: 1,
    session: item.rootSession,
    runs: [item.run!],
    executions: [
      {
        id: 'write',
        originStoreId: 'store',
        sessionId: 'root',
        runId: 'parent-run',
        kind: 'tool',
        definitionId: 'files.write',
        definitionVersion: '2',
        status: 'planned',
        result: null,
        resultRevision: '0',
        cancelRequestedAt: null,
      },
    ],
    interactions: [card],
    interactionsAfterId: null,
    canReadModelOutput: false,
  };
  const answers: string[] = [];
  const render = async (current: NativeSelection, interaction: Interaction) =>
    act(async () =>
      root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="root"
          readingKey="store/root"
          loading={false}
          connected
          connectionLabel="local"
          actions={{}}
          messages={[]}
          interaction={
            <NativeApproval
              interaction={interaction}
              disabled={false}
              onAnswer={(original) => {
                answers.push(original.id);
              }}
            />
          }
          interactionHidesPrompt={nativeRootInteractionBlocksComposer(current)}
          composer={{
            draft: 'next parent work',
            onChange: () => {},
            onSend: () => {},
            active: false,
            stopping: false,
            disabled: false,
            inputLabel: 'parent input',
          }}
        />,
      ),
    );
  try {
    expect(nativeRootInteractionBlocksComposer(selection)).toBe(true);
    await render(selection, card);
    expect(host.querySelector('[aria-label="parent input"]')).toBeNull();
    const childCard = {
      ...card,
      id: 'child-approval',
      sessionId: 'child',
      runId: 'child-run',
      executionId: 'child-write',
      ancestry: ['child', 'root'],
    };
    const childSelection = { ...selection, interactions: [childCard] };
    expect(nativeRootInteractionBlocksComposer(childSelection)).toBe(false);
    await render(childSelection, childCard);
    expect(host.querySelector('[aria-label="parent input"]')).not.toBeNull();
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '仅批准这一次')!
        .click(),
    );
    expect(answers).toEqual(['child-approval']);
    expect(
      nativeRootInteractionBlocksComposer({
        ...selection,
        interactions: [{ ...card, runId: 'old-run' }],
      }),
    ).toBe(false);
    expect(
      nativeRootInteractionBlocksComposer({
        ...selection,
        interactions: [{ ...card, originStoreId: 'old-store' }],
      }),
    ).toBe(false);
    expect(
      nativeRootInteractionBlocksComposer({
        ...selection,
        runs: [{ ...item.run!, isActive: false, status: 'completed' }],
      }),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    layout();
    Object.assign(globalThis, previous);
  }
});
