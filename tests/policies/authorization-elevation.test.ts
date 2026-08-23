import { expect, test } from 'bun:test';
import { assertAuthorizationElevation } from '@kite/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host';
import { applyApprovalGrant } from '#app/bootstrap/runtime/tool-policy';

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
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      source: 'builtin' as const,
      id: 'call',
      name: 'shell_execute',
      args: { command: 'pwd' },
      reason: 'test authorization source',
      protectedCommand: 'pwd',
    },
  });
  expect(Object.values(grant.commandGrants)[0]).toMatchObject({ source: 'test' });
});
