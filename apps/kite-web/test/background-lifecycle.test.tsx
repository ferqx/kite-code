// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app/app';
import type { WebRestTransport } from '@/transport/client';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

function transportWithBackgroundRefreshFailure(): WebRestTransport {
  let historyReads = 0;
  let backgroundReads = 0;
  return {
    connect: vi.fn(async () => ({ generation: 1 })),
    listDirectory: vi.fn(async () => ({
      workspaces: [
        {
          workspaceId: 'workspace-one',
          label: 'Workspace one',
          sessionCount: 2,
          sessionState: 'loaded' as const,
          sessions: [
            {
              sessionId: 'session-one',
              displayName: 'Session one',
              updatedAt: 1,
              lastSequence: 0,
              status: 'idle' as const,
            },
            {
              sessionId: 'session-two',
              displayName: 'Session two',
              updatedAt: 2,
              lastSequence: 0,
              status: 'idle' as const,
            },
          ],
        },
      ],
    })),
    listWorkspaceSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => ({
      sessionId: 'session-one',
      displayName: 'Session one',
      updatedAt: 1,
      lastSequence: 0,
      status: 'idle' as const,
    })),
    loadHistory: vi.fn(async (sessionId: string) => {
      historyReads += 1;
      if (historyReads === 1) throw new Error('history temporarily unavailable');
      return { sessionId, messages: [], observedLastSequence: 0 };
    }),
    loadLogs: vi.fn(async (sessionId: string) => ({
      sessionId,
      entries: [],
      observedLastSequence: 0,
    })),
    loadModelContext: vi.fn(async () => {
      throw new Error('not used');
    }),
    loadCheckpoints: vi.fn(async (sessionId: string) => ({ sessionId, checkpoints: [] })),
    loadBackgroundExecutions: vi.fn(async (sessionId: string) => {
      backgroundReads += 1;
      if (backgroundReads > 1 || sessionId === 'session-two') {
        throw new Error('background temporarily unavailable');
      }
      return {
        sessionId,
        stale: false,
        executions: [
          {
            executionId: 'last-known-subagent',
            kind: 'subagent' as const,
            status: 'running' as const,
            cleanupConfirmed: false,
          },
        ],
      };
    }),
    disconnect: vi.fn(async () => undefined),
  };
}

describe('Web background execution lifecycle', () => {
  it('keeps same-Session last-known executions when a refresh fails', async () => {
    const transport = transportWithBackgroundRefreshFailure();
    render(
      <MemoryRouter initialEntries={['/sessions/session-one']}>
        <App transport={transport} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('last-known-subagent')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));

    await waitFor(() => expect(transport.loadBackgroundExecutions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('last-known-subagent')).toBeTruthy();
    expect(await screen.findByText('上次已知状态 · 等待重连刷新')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Session two' }));
    await waitFor(() => expect(screen.queryByText('last-known-subagent')).toBeNull());
    expect(await screen.findByText('后台状态当前不可用；没有可验证的实时执行数据。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Session one' }));
    await waitFor(() => expect(transport.loadBackgroundExecutions).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('last-known-subagent')).toBeTruthy();
    expect(await screen.findByText('上次已知状态 · 等待重连刷新')).toBeTruthy();
  });
});
