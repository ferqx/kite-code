import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExecutionBackendCapabilities,
  PreparedSandboxExecution,
  SandboxExecutionDispatchIntentAcknowledgement,
  SandboxExecutionProvider,
  SandboxPreparation,
  SandboxPreparationArtifactPort,
  SandboxPreparationArtifactRef,
  SandboxPreparationLifecycle,
  SandboxPreparedProcessExecutionPort,
  SandboxPreparedProcessExecutionResult,
  SandboxPreparedProcessUnknownResult,
} from '../src/sandbox-execution-provider';
import { SANDBOX_EXECUTION_PROVIDER_SCHEMA_ } from '../src/sandbox-execution-provider';

const backendCapabilities: ExecutionBackendCapabilities = {
  backend: 'seatbelt',
  filesystem: {
    read_only: 'enforced',
    workspace_write: 'enforced',
    full_access: 'unsupported',
  },
  network: { off: 'enforced', allowlist: 'unsupported' },
  syscallFilter: 'enforced',
  processTreeLimit: 'enforced',
  childProcessInheritance: 'enforced',
  verifiedInProcessReadOnly: 'enforced',
};

const preparation: SandboxPreparation = {
  schema: SANDBOX_EXECUTION_PROVIDER_SCHEMA_,
  toolCallId: 'tool-call-1',
  capabilityId: 'builtin:shell_execute',
  capabilityRevision: 'shell-v1',
  invocationId: 'invocation-1',
  attempt: 1,
  effectiveEffectsDigest: 'effects-1',
  admissionDigest: 'admission-1',
  canonicalWorkspace: '/workspace',
  argv: ['printf', 'hello'],
  commandDigest: 'command-1',
  executionBoundaryDigest: 'boundary-1',
  protectedPathRevision: 'paths-1',
  filesystemMode: 'workspace_only',
  networkMode: 'disabled',
  executionTrust: 'policy_proven_read_only',
  resourceLimits: {
    cpuTime: 10,
    virtualMemory: 1_024,
    fileSize: 1_024,
    fileDescriptors: 32,
    processes: 4,
    maxProcessTreeTasks: 4,
  },
  timeoutMs: 1_000,
  cancellationCorrelation: 'cancel-1',
};

const prepared: PreparedSandboxExecution = {
  schema: SANDBOX_EXECUTION_PROVIDER_SCHEMA_,
  kind: 'prepared_sandbox_execution',
  planId: 'plan-1',
  toolCallId: preparation.toolCallId,
  capabilityId: preparation.capabilityId,
  capabilityRevision: preparation.capabilityRevision,
  invocationId: preparation.invocationId,
  attempt: preparation.attempt,
  canonicalWorkspace: preparation.canonicalWorkspace,
  effectiveEffectsDigest: preparation.effectiveEffectsDigest,
  admissionDigest: preparation.admissionDigest,
  preparationDigest: 'preparation-1',
  commandDigest: preparation.commandDigest,
  approvedArgv: preparation.argv,
  argv: preparation.argv,
  cwd: preparation.canonicalWorkspace,
  env: null,
  stdin: null,
  transport: 'stdio',
  backend: 'seatbelt',
  backendCapabilities,
  enforcement: 'full',
  resourceSemantics: 'allocating',
  expiresAtMs: 5_000,
  cleanup: { kind: 'none', resourceId: 'none', recoveryPayload: {} },
};

const artifactRef: SandboxPreparationArtifactRef = {
  artifactId: 'artifact-1',
  kind: 'sandbox_preparation',
  integrityIdentifier: 'integrity-1',
  byteLength: 256,
};

function cleanup() {
  return {
    confirmedExited: true,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 0,
  } as const;
}

describe('runtime SPI sandbox execution provider contract', () => {
  test('carries exact preparation objects through a closed typed lifecycle', async () => {
    const seen: unknown[] = [];
    const lifecycle: SandboxPreparationLifecycle = {
      recordPreparationIntent: async (candidate) => {
        seen.push(candidate);
        return { acknowledged: true, stage: 'preparation_intent', intentDigest: 'intent-1' };
      },
      recordPreparationReady: async (candidate) => {
        seen.push(candidate);
        return {
          acknowledged: true,
          stage: 'preparation_ready',
          readyDigest: 'ready-1',
          preparationArtifact: artifactRef,
        };
      },
      recordExecutionDispatchIntent: async (candidate, dispatch) => {
        seen.push(candidate);
        return {
          acknowledged: true,
          stage: 'execution_dispatch_intent',
          dispatchId: dispatch.dispatchId,
          supervisorNonce: dispatch.supervisorNonce,
          dispatchIntentDigest: 'dispatch-intent-1',
        };
      },
      recordExecutionSupervisorStarted: async (candidate, supervisor) => {
        seen.push(candidate);
        return {
          acknowledged: true,
          stage: 'execution_supervisor_started',
          ...supervisor,
        };
      },
      recordDisposalIntent: async (candidate) => {
        seen.push(candidate);
        return {
          acknowledged: true,
          stage: 'disposal_intent',
          purpose: 'dispose',
          lifecycleIntentDigest: 'dispose-1',
          cleanupAttempt: 1,
        };
      },
      recordDisposalReceipt: async (input) => {
        seen.push(input.prepared);
        return {
          acknowledged: true,
          stage: 'disposal_receipt',
          purpose: input.purpose,
          lifecycleIntentDigest: input.lifecycleIntentDigest,
          cleanupAttempt: input.cleanupAttempt,
          disposed: input.disposed,
        };
      },
    };

    const intent = await lifecycle.recordPreparationIntent(preparation);
    const ready = await lifecycle.recordPreparationReady(prepared);
    const dispatch = await lifecycle.recordExecutionDispatchIntent(prepared, {
      dispatchId: 'dispatch-1',
      supervisorNonce: 'nonce-1',
    });
    const started = await lifecycle.recordExecutionSupervisorStarted(prepared, {
      dispatchId: dispatch.dispatchId,
      dispatchIntentDigest: dispatch.dispatchIntentDigest,
      supervisorPid: 42,
      processGroupId: 42,
      processStartIdentity: 'process-start-1',
    });
    const disposal = await lifecycle.recordDisposalIntent(prepared);
    const receipt = await lifecycle.recordDisposalReceipt({
      prepared,
      purpose: disposal.purpose,
      lifecycleIntentDigest: disposal.lifecycleIntentDigest,
      cleanupAttempt: disposal.cleanupAttempt,
      disposed: true,
    });

    expect(intent.stage).toBe('preparation_intent');
    expect(ready.preparationArtifact).toBe(artifactRef);
    expect(started.stage).toBe('execution_supervisor_started');
    expect(receipt.stage).toBe('disposal_receipt');
    expect(seen).toEqual([preparation, prepared, prepared, prepared, prepared, prepared]);
    expect(seen.slice(1).every((candidate) => candidate === prepared)).toBe(true);
  });

  test('keeps artifact transport neutral and exact', () => {
    const port: SandboxPreparationArtifactPort = {
      write: (candidate) => {
        expect(candidate).toBe(prepared);
        return artifactRef;
      },
      read: (reference) => {
        expect(reference).toBe(artifactRef);
        return prepared;
      },
    };

    const reference = port.write(prepared);
    expect(reference).toBe(artifactRef);
    expect(port.read(reference)).toBe(prepared);
  });

  test('requires a dispatch acknowledgement before neutral process execution', async () => {
    const lifecycle = {} as SandboxPreparationLifecycle;
    const dispatchIntent: SandboxExecutionDispatchIntentAcknowledgement = {
      acknowledged: true,
      stage: 'execution_dispatch_intent',
      dispatchId: 'dispatch-1',
      supervisorNonce: 'nonce-1',
      dispatchIntentDigest: 'dispatch-intent-1',
    };
    const port: SandboxPreparedProcessExecutionPort = {
      execute: async (input) => {
        expect(input.prepared).toBe(prepared);
        expect(input.dispatchIntent).toBe(dispatchIntent);
        return {
          kind: 'completed',
          executionPhase: 'go_started',
          exitCode: 0,
          stdout: 'hello',
          stderr: '',
          processCleanup: cleanup(),
        };
      },
    };

    const result = await port.execute({
      prepared,
      dispatchIntent,
      lifecycle,
      timeoutMs: 1_000,
    });
    expect(result.kind).toBe('completed');
  });

  test('keeps post-GO unknown terminally distinct and JSON-safe', () => {
    const unknown: SandboxPreparedProcessUnknownResult = {
      kind: 'unknown',
      executionPhase: 'unknown_after_go',
      exitCode: null,
      stdout: 'partial',
      stderr: '',
      unknown: { code: 'post_go_terminal_unknown', message: 'terminal frame unavailable' },
      retryable: false,
      processCleanup: {
        confirmedExited: false,
        gracefulRequested: true,
        forced: true,
        unconfirmedDescendantCount: 1,
      },
    };
    const decoded = JSON.parse(JSON.stringify(unknown));
    expect(decoded).toEqual(unknown);
    expect(unknown.kind).toBe('unknown');
    expect(unknown.retryable).toBe(false);
    expect(unknown.processCleanup.unconfirmedDescendantCount).toBe(1);

    // @ts-expect-error a post-GO unknown cannot be represented as a failure result
    const downgraded: Extract<SandboxPreparedProcessExecutionResult, { kind: 'failed' }> = unknown;
    expect((downgraded as unknown as { readonly kind: string }).kind).toBe('unknown');

    const postGoFailure: Extract<
      SandboxPreparedProcessExecutionResult,
      { readonly kind: 'failed' }
    > = {
      kind: 'failed',
      // @ts-expect-error a post-GO phase cannot be represented as a known failure
      executionPhase: 'go_started',
      exitCode: null,
      stdout: '',
      stderr: '',
      failure: { code: 'transport_failed', message: 'terminal frame unavailable' },
      processCleanup: cleanup(),
    };
    expect((postGoFailure as unknown as { readonly executionPhase: string }).executionPhase).toBe(
      'go_started',
    );

    // @ts-expect-error cleanup evidence is mandatory on every terminal result
    const missingCleanup: SandboxPreparedProcessExecutionResult = {
      kind: 'completed',
      executionPhase: 'go_started',
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
    expect(missingCleanup.kind).toBe('completed');
  });

  test('does not admit bare booleans as lifecycle acknowledgements', () => {
    const invalidLifecycle: SandboxPreparationLifecycle = {
      // @ts-expect-error a durable lifecycle acknowledgement is never a bare boolean
      recordPreparationIntent: async () => true,
      // @ts-expect-error a durable lifecycle acknowledgement is never a bare boolean
      recordPreparationReady: async () => true,
      // @ts-expect-error a durable lifecycle acknowledgement is never a bare boolean
      recordExecutionDispatchIntent: async () => true,
      // @ts-expect-error a durable lifecycle acknowledgement is never a bare boolean
      recordExecutionSupervisorStarted: async () => true,
      // @ts-expect-error a durable lifecycle acknowledgement is never a bare boolean
      recordDisposalIntent: async () => true,
      // @ts-expect-error a durable lifecycle acknowledgement is never a bare boolean
      recordDisposalReceipt: async () => true,
    };
    expect(typeof invalidLifecycle.recordPreparationReady).toBe('function');
  });

  test('preserves the existing provider API', async () => {
    const provider: SandboxExecutionProvider = {
      resourceSemantics: 'pure',
      prepare: async () => ({ ok: true, observation: prepared }),
      dispose: async () => ({ ok: true, observation: { disposed: true } }),
      reconcile: async () => ({ ok: true, observation: { disposed: true } }),
      reconcilePreparationIntent: async () => ({
        ok: true,
        observation: { disposed: true },
      }),
    };
    expect((await provider.prepare({ grant: {} as never })).ok).toBe(true);
    expect((await provider.dispose({ grant: {} as never, prepared })).ok).toBe(true);
  });

  test('has no package-direction or authority implementation imports', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'sandbox-execution-provider.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /(?:from\s+|import\s*\()\s*['"](?:@kite\/(?:builtin-runtime|runtime-host|agent-kernel)|#app|@\/core)/,
    );
    expect(source).not.toMatch(
      /\b(?:State|Store4|RuntimeEvent|WeakMap|WeakSet|createHash|createHmac)\b/,
    );
  });
});
