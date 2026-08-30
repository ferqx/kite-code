import { describe, expect, test } from 'bun:test';
import { createSingleStoreWebObserverDirectoryPort } from '../../src/web-observer';

describe('Single-Store Web Observer Directory', () => {
  test('projects one query authority and resolves status in process', async () => {
    const directory = createSingleStoreWebObserverDirectoryPort({
      query: {
        list: () => [
          {
            workspaceId: 'workspace-a',
            displayName: 'Kite Project',
            sessions: [
              {
                sessionId: 'session-a',
                name: 'Current\u0000 task',
                updatedAt: 20,
                lastSequence: 4,
              },
              {
                sessionId: 'session-b',
                name: 'Idle task',
                updatedAt: 10,
                lastSequence: 1,
              },
            ],
          },
        ],
      },
      status: (_workspaceId, sessionId) => (sessionId === 'session-a' ? 'running' : 'idle'),
    });

    await expect(directory.list()).resolves.toEqual([
      {
        workspaceId: 'workspace-a',
        label: 'Kite Project',
        sessions: [
          {
            sessionId: 'session-a',
            displayName: 'Current task',
            updatedAt: 20,
            lastSequence: 4,
            status: 'running',
          },
          {
            sessionId: 'session-b',
            displayName: 'Idle task',
            updatedAt: 10,
            lastSequence: 1,
            status: 'idle',
          },
        ],
      },
    ]);
  });

  test('does not project path-like labels and marks failed status lookup unavailable', async () => {
    const directory = createSingleStoreWebObserverDirectoryPort({
      query: {
        list: () => [
          {
            workspaceId: 'workspace-12345678',
            displayName: '/Users/example/private-project',
            sessions: [
              {
                sessionId: 'session-a',
                name: 'Task',
                updatedAt: 1,
                lastSequence: 0,
              },
            ],
          },
        ],
      },
      status: () => {
        throw new Error('runtime unavailable');
      },
    });

    const result = await directory.list();
    expect(result).toEqual([
      {
        workspaceId: 'workspace-12345678',
        label: 'Workspace 12345678',
        sessions: [
          {
            sessionId: 'session-a',
            displayName: 'Task',
            updatedAt: 1,
            lastSequence: 0,
            status: 'unavailable',
          },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('/Users/');
  });
});
