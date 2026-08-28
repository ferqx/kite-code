// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '@/app/app';
import type { WebObserverTransport } from '@/transport/client';

describe('Web App lifecycle', () => {
  test('cancels the StrictMode probe cleanup and disconnects exactly once on real unmount', async () => {
    vi.useFakeTimers();
    try {
      let connected:
        | Promise<{
            generation: number;
            connectionGeneration: number;
            tabHandle: string;
            gatewayInstanceId: string;
          }>
        | undefined;
      const disconnect = vi.fn(async () => undefined);
      const transport: WebObserverTransport = {
        connect: () => {
          connected ??= Promise.resolve({
            generation: 1,
            connectionGeneration: 1,
            tabHandle: 'tab-1',
            gatewayInstanceId: 'gateway-1',
          });
          return connected;
        },
        listDirectory: async () => ({
          schema: 'kite.app.web.directory-response.v1',
          workspaces: [],
        }),
        loadHistory: async () => {
          throw new Error('no Session should be selected');
        },
        subscribe: async () => {
          throw new Error('no Session should be subscribed');
        },
        disconnect,
      };
      const view = render(
        <StrictMode>
          <App transport={transport} />
        </StrictMode>,
      );
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(disconnect).not.toHaveBeenCalled();

      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('contains a rejecting subscription cleanup on unmount', async () => {
    const unsubscribe = vi.fn(async () => {
      throw new Error('socket already closed');
    });
    const subscribe = vi.fn(async () => ({
      subscriptionId: 'subscription-1',
      generation: 1,
      unsubscribe,
    }));
    const transport: WebObserverTransport = {
      connect: async () => ({
        generation: 1,
        connectionGeneration: 1,
        tabHandle: 'tab-1',
        gatewayInstanceId: 'gateway-1',
      }),
      listDirectory: async () => ({
        schema: 'kite.app.web.directory-response.v1',
        workspaces: [
          {
            workspaceId: 'workspace-1',
            label: 'Workspace',
            sessions: [
              {
                sessionId: 'session-1',
                displayName: 'Session',
                updatedAt: 1,
                lastSequence: 0,
                status: 'running',
              },
            ],
          },
        ],
      }),
      loadHistory: async () => ({
        schema: 'kite.app.web.history-response.v1',
        sessionId: 'session-1',
        messages: [],
        hasMore: false,
        observedLastSequence: 0,
      }),
      subscribe,
      disconnect: async () => undefined,
    };
    const view = render(<App transport={transport} />);
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
