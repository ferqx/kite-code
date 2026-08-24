import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import {
  createBuiltinSandboxPreparation,
  SandboxExecutionGrantAuthority,
  type SandboxInvocationIdentity,
} from '@kite/builtin-runtime/sandbox';
import type { SandboxExecutionProvider } from '@kite/runtime-spi';
import { createBuiltinSandboxExecutionConsumerForTest } from '../helpers/sandbox-executor';

const workspace = realpathSync.native(process.cwd());
const identity: SandboxInvocationIdentity = {
  toolCallId: 'tool-preparation-authority',
  capabilityId: 'builtin:shell_execute',
  capabilityRevision: 'shell-revision-v1',
  invocationId: 'invocation-preparation-authority',
  attempt: 1,
  effectiveEffectsDigest: 'sha256:effects',
  admissionDigest: 'sha256:admission',
  cancellationCorrelation: 'cancel-preparation-authority',
};

function preparationInput(command: string, inputWorkspace = workspace) {
  return {
    identity,
    canonicalWorkspace: workspace,
    workspace: inputWorkspace,
    command,
    executionBoundaryDigest: 'sha256:boundary',
    protectedPathRevision: 'protected-v1',
    filesystemMode: 'workspace_only' as const,
    networkMode: 'disabled' as const,
    executionTrust: undefined,
    maxProcessTreeTasks: 32,
    resourceLimits: { cpuTime: 7, processes: 3 },
    timeoutMs: 250,
  };
}

function pureProvider(capture: (preparation: unknown) => void): SandboxExecutionProvider {
  return {
    resourceSemantics: 'pure',
    async prepare({ grant }) {
      capture(grant.preparation);
      return {
        ok: false,
        failure: { code: 'fake_denied', message: 'differential probe' },
      } as const;
    },
    async dispose() {
      return { ok: true, observation: { disposed: true } } as const;
    },
    async reconcile() {
      return { ok: true, observation: { disposed: true } } as const;
    },
    async reconcilePreparationIntent() {
      return { ok: true, observation: { disposed: true } } as const;
    },
  };
}

describe('Builtin sandbox preparation authority', () => {
  test('matches the Core consumer grant preparation corpus', async () => {
    const input = preparationInput('printf preparation-authority');
    const direct = createBuiltinSandboxPreparation(input);
    let observed: unknown;
    const consumer = createBuiltinSandboxExecutionConsumerForTest({
      provider: pureProvider((preparation) => {
        observed = preparation;
      }),
      resourceSemantics: 'pure',
      backend: 'bubblewrap',
      grants: new SandboxExecutionGrantAuthority(),
      canonicalWorkspace: workspace,
      executionBoundaryDigest: input.executionBoundaryDigest,
      protectedPathRevision: input.protectedPathRevision,
      maxProcessTreeTasks: input.maxProcessTreeTasks,
      resourceLimits: input.resourceLimits,
    });

    await consumer({
      workspace,
      command: input.command,
      filesystemMode: input.filesystemMode,
      networkMode: input.networkMode,
      timeoutMs: input.timeoutMs,
      sandboxInvocationIdentity: identity,
    });
    expect(observed).toEqual(direct.preparation);
    expect(Object.isFrozen(direct)).toBe(true);
    expect(Object.isFrozen(direct.preparation)).toBe(true);
    expect(Object.isFrozen(direct.preparation.argv)).toBe(true);
    expect(Object.isFrozen(direct.preparation.resourceLimits)).toBe(true);
  });

  test('does not re-deny a sensitive external path after Policy approval', () => {
    expect(() =>
      createBuiltinSandboxPreparation(preparationInput('printf x > ~/.ssh/authorized_keys')),
    ).not.toThrow();
    expect(() =>
      createBuiltinSandboxPreparation(preparationInput('cat ~/.ssh/authorized_keys')),
    ).not.toThrow();
  });

  test('does not reject protected-looking paths inside the canonical Workspace', () => {
    expect(() =>
      createBuiltinSandboxPreparation(preparationInput('printf x > .env')),
    ).not.toThrow();
    expect(() => createBuiltinSandboxPreparation(preparationInput('ls .agents'))).not.toThrow();
  });

  test('rejects a Workspace identity mismatch before producing preparation facts', () => {
    expect(() =>
      createBuiltinSandboxPreparation(preparationInput('printf x', `${workspace}/..`)),
    ).toThrow('Sandbox invocation Workspace mismatch.');
  });

  test('projects policy-proven read-only and fail-closed defaults as frozen facts', () => {
    const prepared = createBuiltinSandboxPreparation({
      ...preparationInput('ls'),
      executionTrust: 'policy_proven_read_only',
      filesystemMode: undefined,
      networkMode: undefined,
      timeoutMs: undefined,
    }).preparation;
    expect(prepared.executionTrust).toBe('policy_proven_read_only');
    expect(prepared.filesystemMode).toBe('workspace_only');
    expect(prepared.networkMode).toBe('disabled');
    expect(prepared.timeoutMs).toBe(600_000);
    expect(prepared.resourceLimits.maxProcessTreeTasks).toBe(32);
    expect(Object.isFrozen(prepared)).toBe(true);
  });
});
