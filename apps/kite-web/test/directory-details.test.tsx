// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sidebar } from '../../../packages/kite-client-ui/src/Sidebar';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no layout observer; this test checks timing and content, not placement.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
test('directory details wait initially, switch immediately while warm, and hide on Escape', async () => {
  render(
    <Sidebar
      workspaces={[
        {
          id: 'details',
          label: '详情空间',
          state: 'loaded',
          sessionCount: 2,
          sessions: [
            {
              sessionId: 'done',
              displayName: '完成的任务',
              status: 'completed',
              updatedAt: '2026-09-11T06:00:00Z',
            },
            {
              sessionId: 'waiting',
              displayName: '待处理任务',
              status: 'waiting',
            },
          ],
        },
      ]}
      actions={{}}
      connectionLabel=""
      onOpen={() => {}}
    />,
  );
  const space = document.querySelector<HTMLElement>('.space-heading')!;
  const rows = document.querySelectorAll<HTMLElement>('.session-row');
  const pointer = (target: HTMLElement, type: string, relatedTarget: EventTarget | null = null) => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerType: 'mouse',
        relatedTarget,
      }),
    );
  };
  const wait = async (ms: number) => {
    await act(() => vi.advanceTimersByTimeAsync(ms));
  };
  expect(space.textContent).not.toContain('个会话');
  expect(rows[0]!.textContent).toBe('完成的任务');
  expect(rows[1]!.textContent).toBe('待处理任务待用户输入');
  expect(rows[1]!.querySelector('[role="status"]')).toBeNull();
  await act(() => pointer(space, 'pointermove'));
  await wait(250);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(() => pointer(space, 'pointerout'));
  await wait(300);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(() => pointer(space, 'pointermove'));
  await wait(499);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await wait(1);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('2 个会话');
  await act(() => {
    pointer(space, 'pointerout', rows[0]!);
    pointer(rows[0]!, 'pointermove');
  });
  expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain('已完成');
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('9/11');
  await act(() => {
    pointer(rows[0]!, 'pointerout', rows[1]!);
    pointer(rows[1]!, 'pointermove');
  });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('等待交互');
  await act(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await wait(350);
  await act(() => pointer(space, 'pointermove'));
  await wait(100);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await wait(400);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('2 个会话');
});
