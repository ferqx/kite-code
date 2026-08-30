import { describe, expect, test } from 'bun:test';
import type { RuntimeLogQueryPort } from '@kite-ai/runtime-host/storage';
import { createWebObserverDirectoryPort } from '../../src/web-observer';

describe('Web Observer Workspace Directory owner', () => {
  test('projects current-format Session metadata into a path-free closed Workspace group', async () => {
    let closed = 0;
    const reader = {
      listSessions: ({ cursor }) =>
        cursor === undefined
          ? {
              entries: [
                {
                  sessionId: 'session-2',
                  name: 'Second\u0000 session',
                  updatedAt: 2,
                  lastSequence: 4,
                },
              ],
              nextCursor: { updatedAt: 2, sessionId: 'session-2' },
              hasMore: true,
            }
          : {
              entries: [
                {
                  sessionId: 'session-1',
                  name: 'First session',
                  updatedAt: 1,
                  lastSequence: 8,
                },
              ],
              hasMore: false,
            },
      listEvents: () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      close: () => {
        closed += 1;
      },
    } satisfies RuntimeLogQueryPort;
    const directory = createWebObserverDirectoryPort([
      {
        workspaceId: 'scope-1',
        label: 'Kite Project',
        logs: () => reader,
        status: (sessionId) => (sessionId === 'session-2' ? 'running' : 'idle'),
      },
    ]);
    expect(await directory.list()).toEqual([
      {
        workspaceId: 'scope-1',
        label: 'Kite Project',
        sessions: [
          {
            sessionId: 'session-2',
            displayName: 'Second session',
            updatedAt: 2,
            lastSequence: 4,
            status: 'running',
          },
          {
            sessionId: 'session-1',
            displayName: 'First session',
            updatedAt: 1,
            lastSequence: 8,
            status: 'idle',
          },
        ],
      },
    ]);
    expect(closed).toBe(1);
    expect(JSON.stringify(await directory.list())).not.toContain('/Users/');
  });

  test('rejects path-like Workspace labels and non-advancing query cursors', async () => {
    expect(() =>
      createWebObserverDirectoryPort([
        {
          workspaceId: 'scope-1',
          label: '/Users/example/project',
          logs: {} as RuntimeLogQueryPort,
          status: () => 'idle',
        },
      ]),
    ).toThrow('path-like');

    const reader = {
      listSessions: () => ({
        entries: [],
        nextCursor: { updatedAt: 2, sessionId: 'session-2' },
        hasMore: true,
      }),
      listEvents: () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
      close: () => undefined,
    } satisfies RuntimeLogQueryPort;
    const directory = createWebObserverDirectoryPort([
      {
        workspaceId: 'scope-1',
        label: 'Project',
        logs: reader,
        status: () => 'idle',
      },
    ]);
    expect(() => directory.list()).toThrow('did not advance');
  });
});
