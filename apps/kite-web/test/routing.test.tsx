// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { KiteRoutes } from '@/routing';
import type { WebRestTransport } from '@/transport/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function HistoryBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Test history back
    </button>
  );
}

test('navigates between API docs and Observer without a document reload', async () => {
  const transport: WebRestTransport = {
    connect: vi.fn(async () => ({ generation: 1 })),
    listDirectory: vi.fn(async () => ({
      workspaces: [
        {
          workspaceId: 'workspace-first',
          label: 'First Workspace',
          sessionCount: 0,
          sessionState: 'loaded' as const,
          sessions: [],
        },
        {
          workspaceId: 'workspace-one',
          label: 'Workspace one',
          sessionCount: 1,
          sessionState: 'idle' as const,
          sessions: [],
        },
      ],
    })),
    listWorkspaceSessions: vi.fn(async () => [
      {
        sessionId: 'session-one',
        displayName: 'Session one',
        updatedAt: 1,
        lastSequence: 1,
        status: 'idle' as const,
      },
    ]),
    getSession: vi.fn(async () => ({
      sessionId: 'session-one',
      displayName: 'Session one',
      updatedAt: 1,
      lastSequence: 1,
      status: 'idle' as const,
    })),
    loadHistory: vi.fn(async () => ({
      sessionId: 'session-one',
      messages: [
        {
          messageId: 'message-one',
          sequence: 1,
          role: 'assistant' as const,
          blocks: [{ kind: 'text' as const, text: 'Restored session content' }],
        },
      ],
      observedLastSequence: 1,
    })),
    loadLogs: vi.fn(async () => Promise.reject(new Error('unused'))),
    loadModelContext: vi.fn(async () => Promise.reject(new Error('unused'))),
    loadCheckpoints: vi.fn(async () => ({ sessionId: 'session-one', checkpoints: [] })),
    disconnect: vi.fn(async () => undefined),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api-docs/openapi.json') {
        return new Response(
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'Kite Agent Server API', version: '1.0.0' },
            paths: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
        );
      }
      return new Response(undefined, { status: 503 });
    }),
  );

  render(
    <MemoryRouter initialEntries={['/sessions/session-one', '/api-docs']} initialIndex={1}>
      <KiteRoutes transport={transport} />
      <HistoryBack />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Kite Agent Server API')).toBeTruthy());

  fireEvent.click(screen.getByRole('button', { name: 'Test history back' }));
  expect(await screen.findByText('Restored session content')).toBeTruthy();
  expect(transport.getSession).toHaveBeenCalledWith('session-one');
  expect(transport.listWorkspaceSessions).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: 'Open API documentation' }));
  expect(await screen.findByRole('heading', { name: 'Kite Agent API reference' })).toBeTruthy();
  expect(transport.disconnect).not.toHaveBeenCalled();
});
