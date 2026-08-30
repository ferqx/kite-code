// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '@/app/app';
import { type WebObserverTransport, WebObserverTransportError } from '@/transport/client';

describe('Web App lifecycle', () => {
  test('loads the clicked Session History through the server transport', async () => {
    const firstMessage = {
      messageId: 'message-1',
      sequence: 1,
      role: 'assistant' as const,
      blocks: [{ kind: 'text' as const, text: 'First session content' }],
    };
    const secondMessage = {
      messageId: 'message-2',
      sequence: 1,
      role: 'user' as const,
      blocks: [{ kind: 'text' as const, text: 'Second session content' }],
    };
    const loadHistory = vi.fn(async (sessionId: string) => ({
      schema: 'kite.app.web.history-response.v1' as const,
      sessionId,
      messages: [sessionId === 'session-1' ? firstMessage : secondMessage],
      hasMore: false,
      observedLastSequence: 1,
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
                displayName: 'First session',
                updatedAt: 1,
                lastSequence: 1,
                status: 'completed',
              },
              {
                sessionId: 'session-2',
                displayName: 'Second session',
                updatedAt: 2,
                lastSequence: 1,
                status: 'completed',
              },
            ],
          },
        ],
      }),
      loadHistory,
      subscribe: async () => {
        throw new Error('completed sessions do not subscribe');
      },
      disconnect: async () => undefined,
    };

    const view = render(<App transport={transport} />);
    await waitFor(() => expect(view.getByText('First session content')).toBeTruthy());

    fireEvent.click(view.getByRole('button', { name: 'View Second session' }));
    await waitFor(() => expect(view.getByText('Second session content')).toBeTruthy());

    expect(loadHistory).toHaveBeenCalledWith('session-1', undefined, 200);
    expect(loadHistory).toHaveBeenCalledWith('session-2', undefined, 200);
    expect(view.queryByText('First session content')).toBeNull();
    view.unmount();
  });

  test('ignores a previous Session History response that arrives after a new selection', async () => {
    const pending = new Map<
      string,
      (value: Awaited<ReturnType<WebObserverTransport['loadHistory']>>) => void
    >();
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
                sessionId: 'session-a',
                displayName: 'Session A',
                updatedAt: 2,
                lastSequence: 1,
                status: 'completed',
              },
              {
                sessionId: 'session-b',
                displayName: 'Session B',
                updatedAt: 1,
                lastSequence: 1,
                status: 'completed',
              },
            ],
          },
        ],
      }),
      loadHistory: (sessionId) =>
        new Promise((resolve) => {
          pending.set(sessionId, resolve);
        }),
      subscribe: async () => {
        throw new Error('completed sessions do not subscribe');
      },
      disconnect: async () => undefined,
    };
    const response = (sessionId: string, text: string) => ({
      schema: 'kite.app.web.history-response.v1' as const,
      sessionId,
      messages: [
        {
          messageId: `message-${sessionId}`,
          sequence: 1,
          role: 'assistant' as const,
          blocks: [{ kind: 'text' as const, text }],
        },
      ],
      hasMore: false,
      observedLastSequence: 1,
    });

    const view = render(<App transport={transport} />);
    await waitFor(() => expect(pending.has('session-a')).toBe(true));
    fireEvent.click(view.getByRole('button', { name: 'View Session B' }));
    await waitFor(() => expect(pending.has('session-b')).toBe(true));
    pending.get('session-b')?.(response('session-b', 'Current Session B'));
    expect(await view.findByText('Current Session B')).toBeTruthy();

    pending.get('session-a')?.(response('session-a', 'Stale Session A'));
    await act(async () => Promise.resolve());
    expect(view.queryByText('Stale Session A')).toBeNull();
    expect(view.getByText('Current Session B')).toBeTruthy();
    view.unmount();
  });

  test('renders explicit loading and empty History states after selecting a Session', async () => {
    let resolveHistory:
      | ((value: Awaited<ReturnType<WebObserverTransport['loadHistory']>>) => void)
      | undefined;
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
                displayName: 'Empty session',
                updatedAt: 1,
                lastSequence: 0,
                status: 'completed',
              },
            ],
          },
        ],
      }),
      loadHistory: () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
      subscribe: async () => {
        throw new Error('completed sessions do not subscribe');
      },
      disconnect: async () => undefined,
    };

    const view = render(<App transport={transport} />);
    expect(await view.findByText('Loading Empty session')).toBeTruthy();
    resolveHistory?.({
      schema: 'kite.app.web.history-response.v1',
      sessionId: 'session-1',
      messages: [],
      hasMore: false,
      observedLastSequence: 0,
    });
    expect(await view.findByText('No messages yet')).toBeTruthy();
    view.unmount();
  });

  test('renders unavailable History and retries the selected Session read', async () => {
    let attempts = 0;
    const loadHistory = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new WebObserverTransportError('session_unavailable');
      return {
        schema: 'kite.app.web.history-response.v1' as const,
        sessionId: 'session-1',
        messages: [
          {
            messageId: 'message-1',
            sequence: 1,
            role: 'assistant' as const,
            blocks: [{ kind: 'text' as const, text: 'Recovered History' }],
          },
        ],
        hasMore: false,
        observedLastSequence: 1,
      };
    });
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
                displayName: 'Unavailable session',
                updatedAt: 1,
                lastSequence: 0,
                status: 'unavailable',
              },
            ],
          },
        ],
      }),
      loadHistory,
      subscribe: async () => {
        throw new Error('unavailable sessions do not subscribe');
      },
      disconnect: async () => undefined,
    };

    const view = render(<App transport={transport} />);
    expect(await view.findByText('History unavailable')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    expect(await view.findByText('Recovered History')).toBeTruthy();
    expect(loadHistory).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test('renders a distinct error state for an invalid History response', async () => {
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
                displayName: 'Broken session',
                updatedAt: 1,
                lastSequence: 0,
                status: 'completed',
              },
            ],
          },
        ],
      }),
      loadHistory: async () => {
        throw new WebObserverTransportError('protocol_error');
      },
      subscribe: async () => {
        throw new Error('invalid History does not subscribe');
      },
      disconnect: async () => undefined,
    };

    const view = render(<App transport={transport} />);
    expect(await view.findByText('Could not load History')).toBeTruthy();
    expect(
      view.getByText('The local server returned an invalid or incomplete History response.'),
    ).toBeTruthy();
    view.unmount();
  });

  test('keeps History visible when the optional live stream fails', async () => {
    const subscribe = vi.fn(async () => {
      throw new Error('live WebSocket unavailable');
    });
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
            label: 'Workspace from server',
            sessions: [
              {
                sessionId: 'session-1',
                displayName: 'Server session',
                updatedAt: 1,
                lastSequence: 1,
                status: 'running',
              },
            ],
          },
        ],
      }),
      loadHistory: async () => ({
        schema: 'kite.app.web.history-response.v1',
        sessionId: 'session-1',
        messages: [
          {
            messageId: 'message-1',
            sequence: 1,
            role: 'assistant' as const,
            blocks: [{ kind: 'text' as const, text: 'Persisted server History' }],
          },
        ],
        hasMore: false,
        observedLastSequence: 1,
      }),
      subscribe,
      disconnect: async () => undefined,
    };

    const view = render(<App transport={transport} />);
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    expect(view.getByText('Persisted server History')).toBeTruthy();
    expect(
      view.getByText('Live updates are unavailable. Showing the latest History snapshot.'),
    ).toBeTruthy();
    expect(view.getByText('Workspace from server')).toBeTruthy();
    view.unmount();
  });

  test('bounds automatic reconnect attempts after a terminal live resync', async () => {
    let connectCalls = 0;
    let subscriptionInput: Parameters<WebObserverTransport['subscribe']>[0] | undefined;
    const transport: WebObserverTransport = {
      connect: async () => {
        connectCalls += 1;
        if (connectCalls > 1) throw new Error('gateway remains unavailable');
        return {
          generation: 1,
          connectionGeneration: 1,
          tabHandle: 'tab-1',
          gatewayInstanceId: 'gateway-1',
        };
      },
      listDirectory: async () => ({
        schema: 'kite.app.web.directory-response.v1',
        workspaces: [
          {
            workspaceId: 'workspace-1',
            label: 'Workspace',
            sessions: [
              {
                sessionId: 'session-1',
                displayName: 'Running session',
                updatedAt: 1,
                lastSequence: 1,
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
        observedLastSequence: 1,
      }),
      subscribe: async (input) => {
        subscriptionInput = input;
        return {
          subscriptionId: 'subscription-1',
          generation: 1,
          unsubscribe: async () => undefined,
        };
      },
      disconnect: async () => undefined,
    };

    const view = render(<App transport={transport} />);
    await waitFor(() => expect(subscriptionInput).toBeDefined());
    act(() => {
      subscriptionInput?.onEvent(
        {
          schema: 'kite.app.web.live-event.v1',
          type: 'resync_required',
          sessionId: 'session-1',
          reason: 'sequence_gap',
          afterSequence: 1,
        },
        1,
      );
    });
    await waitFor(() => expect(connectCalls).toBe(4));
    await act(async () => Promise.resolve());
    expect(connectCalls).toBe(4);
    expect(view.getByText('unavailable')).toBeTruthy();
    view.unmount();
  });

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
