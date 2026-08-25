import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';

const recoveryIdentityKey = '0000000000000000000000000000000000000000000000000000000000000000';

test('Full is represented by interactionMode alone', () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey,
    threadId: 'test-thread',
    userId: 'u',
    workspace: '/',
    interactionMode: 'full',
  });

  expect(state.mode).toBe('full');
  expect('authorization' in state).toBe(false);
});

test('changing interaction mode does not create an authorization grant', () => {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey,
    threadId: 'test-thread',
    userId: 'u',
    workspace: '/',
    interactionMode: 'accept_edits',
  });

  expect(state.mode).toBe('accept_edits');
  expect(state.sessionCommandGrants).toEqual(new Map());
  expect(state.pendingApprovals).toEqual(new Map());
});
