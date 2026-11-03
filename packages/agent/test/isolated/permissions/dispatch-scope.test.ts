import { expect, test } from 'bun:test';
import type { JobContext, ToolContext } from '../../../src/extensions';
import { hostExecutionScope } from '../../../src/permissions/shell';

type Snapshot = NonNullable<NonNullable<JobContext['dispatchAuthorization']>['snapshot']>;
function leaf(kind: 'tool' | 'job', mode = 'full'): Snapshot {
  return {
    namespace: 'builtin.permissions',
    version: '1',
    data: {
      mode,
      workspaceTrust: true,
      capability: {
        kind,
        definitionId: kind === 'job' ? 'shell.command' : 'foreign.tool',
        definitionVersion: '1',
        hardAllowed: true,
        revision: 'target',
      },
    },
  };
}
function intersection(parent: Snapshot, child?: Snapshot): Snapshot {
  return {
    namespace: 'agent.permission-intersection',
    version: '1',
    data: {
      policies: [parent, ...(child ? [child] : [])].map((snapshot, index) => ({
        scope: index === 0 ? 'parent' : 'child',
        revision: 'accepted-challenge',
        allowed: false,
        snapshot,
      })),
    },
  };
}
function context(snapshot: Snapshot): JobContext & ToolContext {
  return { dispatchAuthorization: { revision: 'accepted', snapshot } } as JobContext & ToolContext;
}
const verifyShell = (snapshot: Snapshot) => hostExecutionScope(context(snapshot));

test('Planning wrappers preserve the current target and every nonempty approval ceiling', () => {
  const planning = (current: Snapshot, ceiling: Snapshot | null): Snapshot => ({
    namespace: 'builtin.planning.permissions',
    version: '1',
    data: {
      planning: { status: ceiling ? 'approved' : 'pending' },
      originalRun: { sessionId: 's', runId: 'r' },
      current: current as never,
      ceiling: ceiling as never,
    },
  });
  expect(() => verifyShell(planning(leaf('job'), null))).not.toThrow();
  expect(() => verifyShell(planning(leaf('job'), leaf('job')))).not.toThrow();
  const changed = leaf('job');
  (changed.data as { capability: { definitionId: string } }).capability.definitionId = 'foreign';
  expect(() => verifyShell(planning(changed, leaf('job')))).toThrow(
    'shell_dispatch_scope_unavailable',
  );
  expect(() => verifyShell(planning(leaf('job'), changed))).toThrow(
    'shell_dispatch_scope_unavailable',
  );
  const malformed = planning(leaf('job'), null);
  (malformed.data as Record<string, unknown>).current = null;
  expect(() => verifyShell(malformed)).toThrow('shell_dispatch_scope_unavailable');
  expect(() => verifyShell(planning(leaf('tool'), null))).toThrow(
    'shell_dispatch_scope_unavailable',
  );
});

test('accepted parent and child challenges retain the restrictive Shell ceiling', () => {
  expect(verifyShell(intersection(leaf('job'), leaf('job', 'auto')))).toEqual({
    filesystem: 'workspace_write',
    network: 'none',
  });
  expect(() => verifyShell(leaf('tool'))).toThrow('shell_dispatch_scope_unavailable');
});

test('adapter proof trees keep the original 8192-node bound without recursive traversal', () => {
  for (const kind of ['job'] as const) {
    let snapshot = leaf(kind);
    for (let count = 1; count < 8192; count++) snapshot = intersection(snapshot);
    const verify = (value: Snapshot) => hostExecutionScope(context(value));
    expect(() => verify(snapshot)).not.toThrow();
    expect(() => verify(intersection(snapshot))).toThrow('shell_dispatch_scope_unavailable');
  }
});

test('malformed policy order and parent subtrees reject the Shell dispatch', () => {
  const reversed = intersection(leaf('job'), leaf('job'));
  const policies = (reversed.data as { policies: { scope: string }[] }).policies;
  policies[0]!.scope = 'child';
  policies[1]!.scope = 'parent';
  expect(() => verifyShell(reversed)).toThrow('shell_dispatch_scope_unavailable');
  const malformedParent: Snapshot = {
    namespace: 'agent.permission-intersection',
    version: '1',
    data: null,
  };
  expect(() => verifyShell(intersection(malformedParent, leaf('job')))).toThrow(
    'shell_dispatch_scope_unavailable',
  );
});
