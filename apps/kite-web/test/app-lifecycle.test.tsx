// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app/app';
import type { WebRestTransport } from '@/transport/client';

describe('Web REST App lifecycle', () => {
  it('renders Workspace and Session data from the REST transport', async () => {
    const transport: WebRestTransport = {
      connect: vi.fn(async () => ({ generation: 1 })),
      listDirectory: vi.fn(async () => ({
        workspaces: [
          {
            workspaceId: 'workspace-one',
            label: 'Workspace one',
            sessionCount: 1,
            sessionState: 'loaded' as const,
            sessions: [
              {
                sessionId: 'session-one',
                displayName: 'Session one',
                updatedAt: Date.now(),
                lastSequence: 1,
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
        updatedAt: Date.now(),
        lastSequence: 1,
        status: 'idle' as const,
      })),
      loadHistory: vi.fn(async () => ({
        sessionId: 'session-one',
        messages: [
          {
            messageId: 'message-one',
            sequence: 1,
            role: 'user' as const,
            blocks: [{ kind: 'text' as const, text: 'hello REST' }],
          },
        ],
        observedLastSequence: 1,
      })),
      loadCheckpoints: vi.fn(async () => ({
        sessionId: 'session-one',
        checkpoints: [
          {
            checkpointId: 'checkpoint-one',
            revision: 1,
            scope: 'conversation_only' as const,
            label: 'Saved',
          },
        ],
      })),
      disconnect: vi.fn(async () => undefined),
    };
    render(<App transport={transport} />);
    await waitFor(() => expect(screen.getByText('Workspace one')).toBeTruthy());
    expect((await screen.findAllByText('Session one')).length).toBeGreaterThan(0);
    expect(await screen.findByText('hello REST')).toBeTruthy();
    expect(await screen.findByText('Saved')).toBeTruthy();
  });
});
