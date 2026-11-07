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

test('business wrappers retain the exact permission scope and never interpret business evidence as a ceiling', () => {
  const business = (current: Snapshot, gate: Snapshot | null = null): Snapshot => ({
    namespace: 'builtin.business.permissions',
    version: '1',
    data: { current: current as never, gate: gate as never },
  });
  expect(() => verifyShell(business(leaf('job')))).not.toThrow();
  expect(verifyShell(business(leaf('job', 'auto'), leaf('job', 'full')))).toEqual({
    filesystem: 'workspace_write',
    network: 'none',
  });
  const changed = leaf('job');
  (changed.data as { capability: { definitionId: string } }).capability.definitionId = 'foreign';
  expect(() => verifyShell(business(changed))).toThrow('shell_dispatch_scope_unavailable');
  expect(() => verifyShell(business(leaf('tool')))).toThrow('shell_dispatch_scope_unavailable');
  const malformed = business(leaf('job'));
  (malformed.data as Record<string, unknown>).current = null;
  expect(() => verifyShell(malformed)).toThrow('shell_dispatch_scope_unavailable');
  const malformedGate = business(leaf('job'));
  (malformedGate.data as Record<string, unknown>).gate = {};
  expect(() => verifyShell(malformedGate)).toThrow('shell_dispatch_scope_unavailable');
  expect(() =>
    verifyShell({
      namespace: 'builtin.planning.permissions',
      version: '1',
      data: {
        current: leaf('job') as never,
        ceiling: null,
        planning: { status: 'approved' },
        originalRun: { sessionId: 's', runId: 'r' },
      },
    }),
  ).toThrow('shell_dispatch_scope_unavailable');
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
