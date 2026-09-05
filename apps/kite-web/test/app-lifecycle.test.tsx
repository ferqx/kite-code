// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app/app';
import type { WebRestTransport } from '@/transport/client';

const LONG_SESSION_NAME = 'session-with-a-name-that-must-not-expand-the-sidebar-width';

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

describe('Web REST App lifecycle', () => {
  it('renders Workspace and Session data from the REST transport', async () => {
    let deferSessionOneLogs = false;
    let resolveDeferredLogs!: (value: Awaited<ReturnType<WebRestTransport['loadLogs']>>) => void;
    const deferredLogs = new Promise<Awaited<ReturnType<WebRestTransport['loadLogs']>>>(
      (resolve) => {
        resolveDeferredLogs = resolve;
      },
    );
    const transport: WebRestTransport = {
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
                updatedAt: Date.now(),
                lastSequence: 1,
                status: 'idle' as const,
              },
              {
                sessionId: 'session-long',
                displayName: LONG_SESSION_NAME,
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
      loadLogs: vi.fn(async (sessionId) => {
        if (sessionId === 'session-long') {
          return { sessionId, entries: [], observedLastSequence: 1 };
        }
        if (deferSessionOneLogs) return deferredLogs;
        return {
          sessionId,
          entries: [
            {
              sequence: 1,
              occurredAt: Date.parse('2026-08-31T00:00:00.000Z'),
              eventType: 'user.message_appended',
              category: 'turn' as const,
              status: 'unknown' as const,
              summary: 'User sent a message',
              detail: {
                kind: 'message',
                fields: [
                  { name: 'content', value: 'hello log detail' },
                  { name: 'message_id', value: 'message-one' },
                ],
              },
            },
            {
              sequence: 2,
              occurredAt: Date.parse('2026-08-31T00:00:01.000Z'),
              eventType: 'model.invocation_prepared',
              category: 'model' as const,
              status: 'unknown' as const,
              summary: 'Model invocation prepared',
              detail: {
                kind: 'model',
                fields: [
                  { name: 'invocation_id', value: 'invocation-one' },
                  { name: 'purpose', value: 'primary_agent' },
                ],
              },
            },
          ],
          observedLastSequence: 2,
        };
      }),
      loadModelContext: vi.fn(async () => ({
        sessionId: 'session-one',
        invocationId: 'invocation-one',
        sequence: 2,
        purpose: 'primary_agent' as const,
        model: { provider: 'openai-compatible', name: 'model-one' },
        systemPrompt: { text: 'You are Kite. Use tools carefully.', truncated: false },
        messages: [
          {
            index: 0,
            role: 'user' as const,
            parts: [{ type: 'text' as const, text: 'hello', truncated: false }],
          },
        ],
        messagesTruncated: false,
        tools: [],
        toolsTruncated: false,
        requestSettings: {
          transport: 'stream' as const,
          temperature: 0,
          maxOutputTokens: 4096,
          messageCount: 1,
          toolCount: 0,
        },
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
    render(
      <MemoryRouter initialEntries={['/sessions/session-one']}>
        <App transport={transport} />
        <CurrentPath />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Workspace one')).toBeTruthy());
    expect((await screen.findAllByText('Session one')).length).toBeGreaterThan(0);
    expect(await screen.findByText('hello REST')).toBeTruthy();
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByTestId('current-path').textContent).toBe('/sessions/session-one');
    expect(
      screen.getByRole('button', { name: `View ${LONG_SESSION_NAME}` }).getAttribute('title'),
    ).toBe(LONG_SESSION_NAME);
    expect(screen.getByRole('link', { name: 'Open API documentation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull();
    expect(
      screen.getByRole('tab', { name: 'Conversation history' }).getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime logs' }));
    expect(await screen.findByText('user.message_appended')).toBeTruthy();
    fireEvent.click(screen.getByText('user.message_appended'));
    expect(await screen.findByText('Category')).toBeTruthy();
    expect(await screen.findByText('Not reported')).toBeTruthy();
    expect(await screen.findByText('Detail type')).toBeTruthy();
    expect(await screen.findByText('Message content')).toBeTruthy();
    expect(await screen.findByText('hello log detail')).toBeTruthy();
    fireEvent.click(screen.getByText('model.invocation_prepared'));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'View model context for invocation invocation-one',
      }),
    );
    expect(await screen.findByRole('dialog', { name: 'Model context' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'System prompt' }));
    expect(await screen.findByText('You are Kite. Use tools carefully.')).toBeTruthy();

    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close model context inspector' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Conversation history' }));
    deferSessionOneLogs = true;
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime logs' }));
    fireEvent.click(screen.getByRole('button', { name: `View ${LONG_SESSION_NAME}` }));
    expect(screen.getByTestId('current-path').textContent).toBe('/sessions/session-long');
    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: 'Conversation history' }).getAttribute('aria-selected'),
      ).toBe('true'),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime logs' }));
    expect(await screen.findByText('No runtime events yet')).toBeTruthy();
    resolveDeferredLogs({
      sessionId: 'session-one',
      entries: [
        {
          sequence: 9,
          occurredAt: Date.now(),
          eventType: 'stale.session.log',
          category: 'other',
          status: 'unknown',
          summary: 'Must not enter the newly selected Session.',
          detail: { kind: 'unavailable', fields: [] },
        },
      ],
      observedLastSequence: 9,
    });
    await waitFor(() => expect(screen.queryByText('stale.session.log')).toBeNull());
  });
});
