import { expect, test } from 'bun:test';
import type { JobContext, ToolContext } from '../../../src/extensions';
import { verifyPathFileDispatch } from '../../../src/permissions/files-request';
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
        definitionId: kind === 'job' ? 'shell.command' : 'files.write_path',
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
const verifyFile = (snapshot: Snapshot) =>
  verifyPathFileDispatch(context(snapshot), 'files.write_path', 'target');

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
  expect(() => verifyFile(planning(leaf('tool'), null))).not.toThrow();
  expect(() => verifyFile(planning(leaf('tool'), leaf('tool')))).not.toThrow();
  const changed = leaf('tool');
  (changed.data as { capability: { revision: string } }).capability.revision = 'other';
  expect(() => verifyFile(planning(changed, leaf('tool')))).toThrow('file_dispatch_scope_changed');
  expect(() => verifyFile(planning(leaf('tool'), changed))).toThrow('file_dispatch_scope_changed');
  const malformed = planning(leaf('tool'), null);
  (malformed.data as Record<string, unknown>).current = null;
  expect(() => verifyFile(malformed)).toThrow('file_dispatch_scope_unavailable');
  expect(() => verifyFile(planning(leaf('job'), null))).toThrow('file_dispatch_scope_changed');
});

test('accepted parent and child challenges retain every adapter ceiling and leaf identity', () => {
  expect(hostExecutionScope(context(intersection(leaf('job'), leaf('job', 'auto'))))).toEqual({
    filesystem: 'workspace_write',
    network: 'none',
  });
  expect(() => verifyFile(intersection(leaf('tool'), leaf('tool', 'auto')))).not.toThrow();
  expect(() => verifyFile(leaf('job'))).toThrow('file_dispatch_scope_changed');
  expect(() => hostExecutionScope(context(leaf('tool')))).toThrow(
    'shell_dispatch_scope_unavailable',
  );
  const wrongTarget = leaf('tool');
  (wrongTarget.data as { capability: { revision: string } }).capability.revision = 'other';
  expect(() => verifyFile(intersection(wrongTarget, leaf('tool')))).toThrow(
    'file_dispatch_scope_changed',
  );
});

test('adapter proof trees keep the original 8192-node bound without recursive traversal', () => {
  for (const kind of ['tool', 'job'] as const) {
    let snapshot = leaf(kind);
    for (let count = 1; count < 8192; count++) snapshot = intersection(snapshot);
    const verify = (value: Snapshot) =>
      kind === 'tool' ? verifyFile(value) : hostExecutionScope(context(value));
    expect(() => verify(snapshot)).not.toThrow();
    expect(() => verify(intersection(snapshot))).toThrow(
      `${kind === 'tool' ? 'file' : 'shell'}_dispatch_scope_unavailable`,
    );
  }
});

test('malformed policy order rejects, and a child leaf error precedes a later parent subtree error', () => {
  const reversed = intersection(leaf('tool'), leaf('tool'));
  const policies = (reversed.data as { policies: { scope: string }[] }).policies;
  policies[0]!.scope = 'child';
  policies[1]!.scope = 'parent';
  expect(() => verifyFile(reversed)).toThrow('file_dispatch_scope_unavailable');
  expect(() => hostExecutionScope(context(reversed))).toThrow('shell_dispatch_scope_unavailable');
  const malformedParent: Snapshot = {
    namespace: 'agent.permission-intersection',
    version: '1',
    data: null,
  };
  expect(() => verifyFile(intersection(malformedParent, leaf('job')))).toThrow(
    'file_dispatch_scope_changed',
  );
  expect(() => verifyFile(intersection(malformedParent, leaf('tool')))).toThrow(
    'file_dispatch_scope_unavailable',
  );
});
