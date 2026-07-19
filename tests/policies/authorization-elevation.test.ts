import { expect, test } from 'bun:test';
import { applyApprovalGrant } from '@/core/harness/tool-policy';
import { assertAuthorizationElevation } from '@/core/policies/mode-policy';
import { createInitialRuntimeState } from '@/core/runtime/state';

test('authorization elevation requires a sandbox', () => {
  expect(() =>
    assertAuthorizationElevation({ mode: 'full_access', sandboxAvailable: false }),
  ).toThrow('requires an available workspace sandbox');
});

test('automated paths cannot elevate to full access', () => {
  expect(() =>
    assertAuthorizationElevation({
      mode: 'full_access',
      source: 'system',
      sandboxAvailable: true,
      autoReview: true,
    }),
  ).toThrow('auto-review cannot grant');
  expect(() =>
    assertAuthorizationElevation({
      mode: 'full_access',
      source: 'system',
      sandboxAvailable: true,
      loopMode: true,
    }),
  ).toThrow('loop-mode cannot auto-elevate');
});

test('records explicit test provenance for injected authorization', () => {
  const state = createInitialRuntimeState({
    threadId: 'test-thread',
    userId: 'u',
    workspace: '/',
    authorizationMode: 'full_access',
    authorizationSource: 'test',
  });
  expect(state.authorization).toMatchObject({ modeSource: 'test' });

  const grant = applyApprovalGrant({
    authorization: state.authorization,
    grant: 'same_command',
    workspace: '/',
    threadId: 'test-thread',
    source: 'test',
    request: {
      id: 'call',
      name: 'shell_execute',
      args: { command: 'pwd' },
      reason: 'test authorization source',
      protectedCommand: 'pwd',
    },
  });
  expect(Object.values(grant.commandGrants)[0]).toMatchObject({ source: 'test' });
});
