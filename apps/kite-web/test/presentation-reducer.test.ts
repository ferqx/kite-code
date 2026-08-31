import { describe, expect, it } from 'vitest';
import { initialWebPresentationState, webPresentationReducer } from '@/presentation/reducer';

describe('Web REST presentation reducer', () => {
  it('preserves empty Workspaces and rejects stale generation History', () => {
    const connected = webPresentationReducer(initialWebPresentationState, {
      type: 'transport_connected',
      generation: 2,
    });
    const directory = webPresentationReducer(connected, {
      type: 'directory_loaded',
      generation: 2,
      directory: {
        workspaces: [
          {
            workspaceId: 'empty',
            label: 'Empty',
            sessionCount: 0,
            sessionState: 'loaded',
            sessions: [],
          },
          {
            workspaceId: 'active',
            label: 'Active',
            sessionCount: 1,
            sessionState: 'loaded',
            sessions: [
              {
                sessionId: 'session-one',
                displayName: 'Session one',
                updatedAt: 1,
                lastSequence: 1,
                status: 'idle',
              },
            ],
          },
        ],
      },
    });
    expect(directory.workspaces[0]?.workspaceId).toBe('empty');
    expect(directory.selectedSessionId).toBe('session-one');

    const stale = webPresentationReducer(directory, {
      type: 'history_loaded',
      generation: 1,
      history: { sessionId: 'session-one', messages: [], observedLastSequence: 0 },
    });
    expect(stale).toBe(directory);
  });
});
