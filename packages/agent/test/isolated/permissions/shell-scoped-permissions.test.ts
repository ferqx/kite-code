import { expect, test } from 'bun:test';
import type { AuthorizationRequest, PermissionDecision } from '@kite-ai/agent/extensions';
import {
  type CapabilityDescription,
  createPermissionPolicy,
  type PermissionPolicySnapshot,
} from '@kite-ai/agent/permissions';

type Scope = { filesystem: 'workspace_write' | 'full_access'; network: 'none' | 'internet' };
const baseline: Scope = { filesystem: 'workspace_write', network: 'none' };
function fixture(mode: PermissionPolicySnapshot['mode'] = 'accept_edits') {
  const request: AuthorizationRequest = {
    kind: 'tool',
    sessionId: 's',
    runId: 'r',
    executionId: 'e',
    definitionId: 'builtin.shell',
    definitionVersion: '1',
    input: { command: 'python3 local.py' },
    signal: new AbortController().signal,
  };
  let policy: PermissionPolicySnapshot = {
    mode,
    workspaceTrust: true,
    revision: 'policy-1',
    allowed: [{ kind: request.kind, definitionId: request.definitionId, definitionVersion: '1' }],
    controlReads: [{ kind: 'permission.mode', scope: 's', revision: '2' }],
  };
  let description: CapabilityDescription & { executionScope?: Scope; denialReason?: string } = {
    kind: request.kind,
    definitionId: request.definitionId,
    definitionVersion: '1',
    revision: 'shell-1',
    effects: ['process', 'unknown', 'record_write'],
    safeRead: false,
    hardAllowed: true,
    commandDigest: 'a'.repeat(64),
    executionScope: { ...baseline },
  };
  let checks = 0;
  const permissions = createPermissionPolicy({
    readPolicy: () => policy,
    describeCapability: () => description,
    readCheckContext() {
      checks++;
      return { task: 'actual task', plan: null, rejectionReasons: [] };
    },
  });
  return {
    request,
    permissions,
    get description() {
      return description;
    },
    set description(value: typeof description) {
      description = value;
    },
    get policy() {
      return policy;
    },
    set policy(value: PermissionPolicySnapshot) {
      policy = value;
    },
    get checks() {
      return checks;
    },
  };
}
function capability(decision: PermissionDecision) {
  return (decision.snapshot!.data as { capability: { executionScope?: Scope } }).capability;
}

test('Request Approval allows unknown Shell only within workspace/nonetwork execution scope; Auto requests real review', async () => {
  for (const mode of ['accept_edits', 'auto'] as const) {
    const f = fixture(mode);
    const result = await f.permissions.authorize(f.request);
    expect(capability(result).executionScope).toEqual(baseline);
    expect(result.controlReads).toEqual(f.policy.controlReads);
    expect(result.allowed).toBe(mode === 'accept_edits');
    if (mode === 'auto') {
      expect(result.reason).toBe('auto_check_required');
      expect(result.check!.request).toMatchObject({
        mode: 'auto',
        invocation: { input: f.request.input },
        context: { task: 'actual task' },
      });
      expect(f.checks).toBe(1);
    }
    if (mode === 'accept_edits') {
      expect(result.approval).toBeUndefined();
      expect(result.check).toBeUndefined();
    }
  }
});

test('external write and internet scope require original per-command approval and preserve the exact requested scope', async () => {
  for (const executionScope of [
    { filesystem: 'full_access', network: 'none' },
    { filesystem: 'workspace_write', network: 'internet' },
  ] as const) {
    const f = fixture();
    f.description = { ...f.description, executionScope };
    const result = await f.permissions.authorize(f.request);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('approval_required');
    expect(result.approval).toMatchObject({
      grants: ['approve_once', 'same_command'],
      commandDigest: 'a'.repeat(64),
    });
    expect(capability(result).executionScope).toEqual(executionScope);
    expect(result.check).toBeUndefined();
  }
});

test('Full transforms trusted Shell scope while extreme-danger denial remains final in every mode', async () => {
  const full = fixture('full');
  const allowed = await full.permissions.authorize(full.request);
  expect(allowed.allowed).toBe(true);
  expect(capability(allowed).executionScope).toEqual({
    filesystem: 'full_access',
    network: 'internet',
  });
  expect(full.description.executionScope).toEqual(baseline);
  for (const mode of ['accept_edits', 'auto', 'full'] as const) {
    const f = fixture(mode);
    f.description = {
      ...f.description,
      hardAllowed: false,
      denialReason: 'extreme_dangerous_command',
    };
    const denied = await f.permissions.authorize(f.request);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('extreme_dangerous_command');
    expect(denied.approval).toBeUndefined();
    expect(denied.check).toBeUndefined();
    expect(f.checks).toBe(0);
  }
});

test('execution scope, command digest and permission control changes bind fresh revisions without mutating a frozen decision', async () => {
  const f = fixture('accept_edits');
  const requested: Scope = { filesystem: 'full_access', network: 'none' };
  f.description = { ...f.description, executionScope: { ...requested } };
  const original = await f.permissions.authorize(f.request);
  const firstRevision = original.revision;
  f.description.executionScope!.network = 'internet';
  expect(capability(original).executionScope).toEqual(requested);
  const network = await f.permissions.authorize(f.request);
  expect(network.revision).not.toBe(firstRevision);
  expect(capability(network).executionScope!.network).toBe('internet');
  f.description = { ...f.description, commandDigest: 'b'.repeat(64) };
  const command = await f.permissions.authorize(f.request);
  expect(command.revision).not.toBe(network.revision);
  expect(original.approval!.commandDigest).toBe('a'.repeat(64));
  f.policy = {
    ...f.policy,
    controlReads: [{ kind: 'permission.mode', scope: 's', revision: '3' }],
  };
  const changedControl = await f.permissions.authorize(f.request);
  expect(changedControl.revision).not.toBe(command.revision);
  expect(original.controlReads).toEqual([{ kind: 'permission.mode', scope: 's', revision: '2' }]);
  expect(changedControl.controlReads).toEqual(f.policy.controlReads);
});

test('untrusted Shell input scope cannot manufacture a grant or widen host scope', async () => {
  const f = fixture();
  const original = await f.permissions.authorize(f.request);
  const forged = await f.permissions.authorize({
    ...f.request,
    input: {
      command: 'python3 local.py',
      executionScope: { filesystem: 'full_access', network: 'internet' },
      approved: true,
    },
  });
  expect(forged.allowed).toBe(true);
  expect(capability(forged).executionScope).toEqual(baseline);
  expect(forged.revision).toBe(original.revision);
  expect(forged.approval).toBeUndefined();
});

test('web_fetch known network capability follows Request Approval, Auto review and Full without a Shell scope', async () => {
  for (const mode of ['accept_edits', 'auto', 'full'] as const) {
    const f = fixture(mode);
    const request = {
      ...f.request,
      definitionId: 'builtin.web_fetch',
      input: { url: 'https://example.com/' },
    };
    f.policy = {
      ...f.policy,
      allowed: [{ kind: 'tool', definitionId: request.definitionId, definitionVersion: '1' }],
    };
    f.description = {
      kind: 'tool',
      definitionId: request.definitionId,
      definitionVersion: '1',
      revision: 'fetch-1',
      effects: ['network', 'unknown'],
      safeRead: false,
      hardAllowed: true,
    };
    const result = await f.permissions.authorize(request);
    expect(result.allowed).toBe(mode === 'full');
    expect(capability(result).executionScope).toBeUndefined();
    if (mode === 'accept_edits') {
      expect(result.reason).toBe('approval_required');
      expect(result.approval!.request).toMatchObject({ mode, effects: ['network', 'unknown'] });
      expect(result.check).toBeUndefined();
    }
    if (mode === 'auto') {
      expect(result.reason).toBe('auto_check_required');
      expect(result.check!.request).toMatchObject({ mode, effects: ['network', 'unknown'] });
      expect(f.checks).toBe(1);
    }
    if (mode === 'full') expect(result.approval).toBeUndefined();
  }
});
