import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PreparedSandboxExecution,
  SandboxExecutionBackend,
  SandboxExecutionProvider,
  SandboxPreparationLifecycle,
  SandboxPreparedProcessExecutionResult,
} from '@kite-ai/runtime-spi';
import {
  createBuiltinPreparedShellExecutionConsumer,
  createBuiltinSandboxPreparation,
  LocalSandboxExecutionProvider,
  SandboxExecutionGrantAuthority,
  type SandboxInvocationIdentity,
  sandboxBackendCapabilities,
  sandboxPreparationDigest,
  sandboxPreparationIntentDigest,
} from '../src/sandbox';

const WORKSPACE = realpathSync.native(process.cwd());
const IDENTITY: SandboxInvocationIdentity = Object.freeze({
  toolCallId: 'tool-saq-scope',
  capabilityId: 'builtin:shell_execute',
  capabilityRevision: 'shell-revision-v1',
  invocationId: 'invocation-saq-scope',
  attempt: 1,
  effectiveEffectsDigest: 'effects-saq-scope',
  admissionDigest: 'admission-saq-scope',
  cancellationCorrelation: 'cancel-saq-scope',
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function preparation(
  filesystemMode: 'workspace_only' | 'allow_all',
  networkMode: 'disabled' | 'allow_all' = 'disabled',
  command = 'printf saq-scope',
  executionTrust?: 'policy_proven_read_only',
) {
  return createBuiltinSandboxPreparation({
    identity: IDENTITY,
    canonicalWorkspace: WORKSPACE,
    workspace: WORKSPACE,
    command,
    executionBoundaryDigest: 'boundary-saq-scope',
    protectedPathRevision: 'protected-saq-scope',
    filesystemMode,
    networkMode,
    ...(executionTrust ? { executionTrust } : {}),
  }).preparation;
}

function preparedPlan(
  input: ReturnType<typeof preparation>,
  backend: Exclude<SandboxExecutionBackend, 'none'>,
): Readonly<PreparedSandboxExecution> {
  return deepFreeze({
    schema: 'kite.sandbox-execution-provider.v1' as const,
    kind: 'prepared_sandbox_execution' as const,
    planId: `plan-${backend}`,
    toolCallId: input.toolCallId,
    capabilityId: input.capabilityId,
    capabilityRevision: input.capabilityRevision,
    invocationId: input.invocationId,
    attempt: input.attempt,
    canonicalWorkspace: input.canonicalWorkspace,
    effectiveEffectsDigest: input.effectiveEffectsDigest,
    admissionDigest: input.admissionDigest,
    preparationDigest: sandboxPreparationDigest(input),
    commandDigest: input.commandDigest,
    approvedArgv: input.argv,
    argv: input.argv,
    cwd: input.canonicalWorkspace,
    env: null,
    stdin: null,
    transport: backend === 'windows_restricted_token' ? 'windows_restricted_token_v1' : 'stdio',
    backend,
    backendCapabilities: sandboxBackendCapabilities(backend),
    enforcement: 'full' as const,
    resourceSemantics: 'pure' as const,
    expiresAtMs: Date.now() + 60_000,
    cleanup: { kind: 'none' as const, resourceId: 'none', recoveryPayload: {} },
  });
}

function lifecycle(): SandboxPreparationLifecycle {
  return {
    async recordPreparationIntent() {
      return { acknowledged: true, stage: 'preparation_intent', intentDigest: 'intent' } as const;
    },
    async recordPreparationReady() {
      return {
        acknowledged: true,
        stage: 'preparation_ready',
        readyDigest: 'ready',
        preparationArtifact: {
          artifactId: 'artifact',
          kind: 'sandbox_preparation',
          integrityIdentifier: 'integrity',
          byteLength: 1,
        },
      } as const;
    },
    async recordExecutionDispatchIntent(_prepared, input) {
      return {
        acknowledged: true,
        stage: 'execution_dispatch_intent',
        dispatchId: input.dispatchId,
        supervisorNonce: input.supervisorNonce,
        dispatchIntentDigest: 'dispatch',
      } as const;
    },
    async recordExecutionSupervisorStarted(_prepared, input) {
      return {
        acknowledged: true,
        stage: 'execution_supervisor_started',
        dispatchId: input.dispatchId,
        dispatchIntentDigest: input.dispatchIntentDigest,
        supervisorPid: 1,
        processGroupId: 1,
        processStartIdentity: 'process',
      } as const;
    },
    async recordDisposalIntent(prepared) {
      return {
        acknowledged: true,
        stage: 'disposal_intent',
        purpose: prepared ? 'dispose' : 'reconcile_preparation_intent',
        lifecycleIntentDigest: 'cleanup',
        cleanupAttempt: 1,
      } as const;
    },
    async recordDisposalReceipt(input) {
      return {
        acknowledged: true,
        stage: 'disposal_receipt',
        purpose: input.purpose,
        lifecycleIntentDigest: input.lifecycleIntentDigest,
        cleanupAttempt: input.cleanupAttempt,
        disposed: input.disposed,
      } as const;
    },
  };
}

function providerFor(
  plan: Readonly<PreparedSandboxExecution>,
  counters: { prepare: number },
): SandboxExecutionProvider {
  return {
    resourceSemantics: 'pure',
    async prepare() {
      counters.prepare += 1;
      return { ok: true, observation: plan } as const;
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

function deniedProvider(counters: { prepare: number }): SandboxExecutionProvider {
  return {
    resourceSemantics: 'pure',
    async prepare() {
      counters.prepare += 1;
      return { ok: false, failure: { code: 'fake_denied', message: 'contract denial' } } as const;
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

function completedResult(): Readonly<SandboxPreparedProcessExecutionResult> {
  return {
    kind: 'completed',
    executionPhase: 'go_started',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    processCleanup: {
      confirmedExited: true,
      gracefulRequested: false,
      forced: false,
      unconfirmedDescendantCount: 0,
    },
  };
}

function consumerFor(input: {
  readonly backend: Exclude<SandboxExecutionBackend, 'none'>;
  readonly provider: SandboxExecutionProvider;
  readonly processExecute: () => Promise<Readonly<SandboxPreparedProcessExecutionResult>>;
}) {
  return createBuiltinPreparedShellExecutionConsumer({
    provider: input.provider,
    resourceSemantics: 'pure',
    backend: input.backend,
    grants: new SandboxExecutionGrantAuthority(),
    canonicalWorkspace: WORKSPACE,
    executionBoundaryDigest: 'boundary-saq-scope',
    protectedPathRevision: 'protected-saq-scope',
    preparedProcess: { execute: input.processExecute },
  });
}

describe('SAQ sandbox scope/backend contract', () => {
  test.skipIf(process.platform === 'win32')(
    'Full Git reads retain full scope while Builtin derives a hardened environment',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kite-full-git-env-'));
      const grants = new SandboxExecutionGrantAuthority();
      const provider = new LocalSandboxExecutionProvider(grants.verifier(), {
        backend: 'seatbelt',
        canonicalWorkspace: workspace,
      });
      try {
        for (const [command, hardened] of [
          ['git status --short', true],
          ['git log --oneline -10', true],
          ['git config --list', false],
        ] as const) {
          const candidate = createBuiltinSandboxPreparation({
            identity: IDENTITY,
            canonicalWorkspace: workspace,
            workspace,
            command,
            executionBoundaryDigest: 'boundary-full-git',
            protectedPathRevision: 'protected-full-git',
            filesystemMode: 'allow_all',
            networkMode: 'allow_all',
          }).preparation;
          expect(candidate.filesystemMode).toBe('allow_all');
          expect(candidate.executionTrust).toBeNull();
          if (hardened) expect(candidate.argv[0]).toBe('/bin/sh');
          const result = await provider.prepare({
            grant: grants.issue({
              preparation: candidate,
              resourceSemantics: 'allocating',
              preparationIntentDigest: sandboxPreparationIntentDigest({
                attempt: candidate.attempt,
                toolCallId: candidate.toolCallId,
                capabilityId: candidate.capabilityId,
                capabilityRevision: candidate.capabilityRevision,
                canonicalWorkspace: candidate.canonicalWorkspace,
                effectiveEffectsDigest: candidate.effectiveEffectsDigest,
                admissionDigest: candidate.admissionDigest,
                preparationDigest: sandboxPreparationDigest(candidate),
                commandDigest: candidate.commandDigest,
                executionBoundaryDigest: candidate.executionBoundaryDigest,
                resourceSemantics: 'allocating',
              }),
            }),
          });
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error(result.failure.message);
          const profile = result.observation.argv[2] ?? '';
          const script = result.observation.argv.at(-1) ?? '';
          expect(profile).toContain(
            '(allow file-write* file-write-create file-write-unlink file-ioctl)',
          );
          expect(script.includes("export HOME='/nonexistent'")).toBe(hardened);
          expect(script.includes("export GIT_CONFIG_NOSYSTEM='1'")).toBe(hardened);
          expect(script.includes("export GIT_CONFIG_KEY_0='core.fsmonitor'")).toBe(hardened);
          expect(
            (
              await provider.dispose({
                grant: grants.issueCleanup({
                  purpose: 'dispose',
                  prepared: result.observation,
                  lifecycleIntentDigest: `full-git-${command}`,
                  cleanupAttempt: 1,
                  cleanupConfirmed: true,
                }),
                prepared: result.observation,
              })
            ).ok,
          ).toBe(true);
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  test('caller read-only trust cannot harden a command outside the Builtin grammar', () => {
    expect(() =>
      createBuiltinSandboxPreparation({
        identity: IDENTITY,
        canonicalWorkspace: WORKSPACE,
        workspace: WORKSPACE,
        command: 'git config --list',
        executionBoundaryDigest: 'boundary-unproven-git',
        protectedPathRevision: 'protected-unproven-git',
        executionTrust: 'policy_proven_read_only',
      }),
    ).toThrow('Read-only execution trust requires a command proven by the Builtin classifier.');
  });
  test('published backend evidence is the UI scope contract', () => {
    expect(sandboxBackendCapabilities('bubblewrap')).toMatchObject({
      filesystem: {
        read_only: 'enforced',
        workspace_write: 'enforced',
        full_access: 'unsupported',
      },
      network: { off: 'enforced', allowlist: 'unsupported' },
    });
  });

  test.each([
    'seatbelt',
    'bubblewrap',
    'windows_restricted_token',
  ] as const)('sealed approved network and filesystem scope dispatches exactly once without production qualification: %s', async (backend) => {
    const candidate = preparation('allow_all', 'allow_all');
    const plan = preparedPlan(candidate, backend);
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend,
      provider: providerFor(plan, counters),
      processExecute: async () => {
        counters.process += 1;
        return completedResult();
      },
    });
    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'printf saq-scope',
      filesystemMode: 'allow_all',
      networkMode: 'allow_all',
      lifecycle: lifecycle(),
    });

    expect(plan.backendCapabilities.filesystem.full_access).toBe('unsupported');
    expect(plan.backendCapabilities.network.allowlist).toBe('unsupported');
    expect(result).toMatchObject({ ok: true, stdout: 'ok' });
    expect(counters.process).toBe(1);
  });

  test.each([
    'seatbelt',
    'bubblewrap',
  ] as const)('sealed approved network with a workspace filesystem scope dispatches without allowlist evidence: %s', async (backend) => {
    const candidate = preparation('workspace_only', 'allow_all');
    const plan = preparedPlan(candidate, backend);
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend,
      provider: providerFor(plan, counters),
      processExecute: async () => {
        counters.process += 1;
        return completedResult();
      },
    });

    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'printf saq-scope',
      filesystemMode: 'workspace_only',
      networkMode: 'allow_all',
      lifecycle: lifecycle(),
    });

    expect(plan.backendCapabilities.network.allowlist).toBe('unsupported');
    expect(result).toMatchObject({ ok: true, stdout: 'ok' });
    expect(counters.process).toBe(1);
  });

  test.each([
    'seatbelt',
    'bubblewrap',
  ] as const)('sealed approved filesystem scope retains enforced network-off evidence: %s', async (backend) => {
    const candidate = preparation('allow_all', 'disabled');
    const plan = preparedPlan(candidate, backend);
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend,
      provider: providerFor(plan, counters),
      processExecute: async () => {
        counters.process += 1;
        return completedResult();
      },
    });

    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'printf saq-scope',
      filesystemMode: 'allow_all',
      networkMode: 'disabled',
      lifecycle: lifecycle(),
    });

    expect(plan.backendCapabilities.network.off).toBe('enforced');
    expect(result).toMatchObject({ ok: true, stdout: 'ok' });
    expect(counters.process).toBe(1);
  });

  test('Windows lower-assurance workspace/off development scope dispatches without restrictive evidence', async () => {
    const candidate = preparation('workspace_only', 'disabled');
    const plan = preparedPlan(candidate, 'windows_restricted_token');
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend: 'windows_restricted_token',
      provider: providerFor(plan, counters),
      processExecute: async () => {
        counters.process += 1;
        return completedResult();
      },
    });

    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'printf saq-scope',
      filesystemMode: 'workspace_only',
      networkMode: 'disabled',
      lifecycle: lifecycle(),
    });

    expect(plan.backendCapabilities.filesystem.workspace_write).toBe('unsupported');
    expect(plan.backendCapabilities.network.off).toBe('unsupported');
    expect(result).toMatchObject({ ok: true, stdout: 'ok' });
    expect(counters.process).toBe(1);
  });

  test('Windows approved network rejects a narrower filesystem scope before host dispatch', async () => {
    const candidate = preparation('workspace_only', 'allow_all');
    const plan = preparedPlan(candidate, 'windows_restricted_token');
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend: 'windows_restricted_token',
      provider: providerFor(plan, counters),
      processExecute: async () => {
        counters.process += 1;
        return completedResult();
      },
    });

    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'printf saq-scope',
      filesystemMode: 'workspace_only',
      networkMode: 'allow_all',
      lifecycle: lifecycle(),
    });

    expect(result.terminationReason).toBe('sandbox_denied');
    expect(result.stderr).toContain(
      'Windows approved network requires an explicit full filesystem scope',
    );
    expect(counters.process).toBe(0);
  });

  test.each([
    'seatbelt',
    'bubblewrap',
    'windows_restricted_token',
  ] as const)('read-only trust cannot claim an approved full filesystem scope: %s', async (backend) => {
    const candidate = preparation(
      'allow_all',
      'allow_all',
      'git status --short',
      'policy_proven_read_only',
    );
    const plan = preparedPlan(candidate, backend);
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend,
      provider: providerFor(plan, counters),
      processExecute: async () => {
        counters.process += 1;
        return completedResult();
      },
    });

    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'git status --short',
      filesystemMode: 'allow_all',
      networkMode: 'allow_all',
      executionTrust: 'policy_proven_read_only',
      lifecycle: lifecycle(),
    });

    expect(result.terminationReason).toBe('sandbox_denied');
    expect(result.stderr).toContain('cannot combine full filesystem access with read-only trust');
    expect(counters.process).toBe(0);
  });

  test('pre-GO sandbox denial is terminal and never calls the host process port', async () => {
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend: 'bubblewrap',
      provider: deniedProvider(counters),
      processExecute: async () => {
        counters.process += 1;
        return completedResult();
      },
    });
    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'printf saq-scope',
      filesystemMode: 'workspace_only',
      networkMode: 'disabled',
    });

    expect(result.terminationReason).toBe('sandbox_denied');
    expect(result.sandboxFailure?.stage).toBe('pre_dispatch');
    expect(counters.prepare).toBe(1);
    expect(counters.process).toBe(0);
  });

  test('post-GO transport loss is unknown and is not replayed', async () => {
    const candidate = preparation('workspace_only');
    const plan = preparedPlan(candidate, 'bubblewrap');
    const counters = { prepare: 0, process: 0 };
    const consumer = consumerFor({
      backend: 'bubblewrap',
      provider: providerFor(plan, counters),
      processExecute: async () => {
        counters.process += 1;
        throw new Error('post-GO transport lost');
      },
    });
    const result = await consumer({
      identity: IDENTITY,
      workspace: WORKSPACE,
      command: 'printf saq-scope',
      filesystemMode: 'workspace_only',
      networkMode: 'disabled',
      lifecycle: lifecycle(),
    });

    expect(result.kind).toBe('unknown');
    expect(result.processResult).toMatchObject({
      kind: 'unknown',
      executionPhase: 'unknown_after_go',
      retryable: false,
    });
    expect(counters.prepare).toBe(1);
    expect(counters.process).toBe(1);
  });

  test('workspace baseline accepts protected-looking names without name-based denials', () => {
    for (const command of ['ls .git', 'cat .ssh/config', 'printf x > .env']) {
      const prepared = preparation('workspace_only', 'disabled', command);
      expect(prepared.filesystemMode).toBe('workspace_only');
      expect(prepared.canonicalWorkspace).toBe(WORKSPACE);
    }
  });
});
