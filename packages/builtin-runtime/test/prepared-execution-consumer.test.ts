import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PreparedSandboxExecution,
  SandboxExecutionProvider,
  SandboxPreparation,
  SandboxPreparationLifecycle,
  SandboxPreparedProcessExecutionPort,
  SandboxPreparedProcessExecutionResult,
} from '@kite/runtime-spi';
import {
  createBuiltinPreparedShellExecutionConsumer,
  createBuiltinSandboxPreparation,
  SandboxExecutionGrantAuthority,
  sandboxBackendCapabilities,
  sandboxPreparationDigest,
  sandboxPreparationIntentDigest,
} from '../src/sandbox';

const backend = 'bubblewrap' as const;

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    return Object.freeze(value);
  }
  return value;
}

function makeHarness(
  options: {
    readonly intentAcknowledged?: boolean;
    readonly readyAcknowledged?: boolean;
    readonly dispatchAcknowledged?: boolean;
    readonly processResult?: Readonly<SandboxPreparedProcessExecutionResult>;
    readonly processThrows?: boolean;
    readonly disposalReceiptAcknowledged?: boolean;
    readonly tamperPreparationDigest?: boolean;
    readonly tamperCommandDigest?: boolean;
    readonly tamperBackend?: boolean;
    readonly expired?: boolean;
    readonly mutablePrepared?: boolean;
  } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-builtin-prepared-shell-'));
  const events: string[] = [];
  let providerPrepareCalls = 0;
  let providerDisposeCalls = 0;
  let providerReconcileCalls = 0;
  let processCalls = 0;
  let preparation: Readonly<SandboxPreparation> | undefined;
  let prepared: Readonly<PreparedSandboxExecution> | undefined;
  let dispatch:
    | {
        readonly dispatchId: string;
        readonly supervisorNonce: string;
        readonly dispatchIntentDigest: string;
      }
    | undefined;
  let disposal:
    | {
        readonly purpose: 'dispose' | 'reconcile_preparation_intent';
        readonly lifecycleIntentDigest: string;
        readonly cleanupAttempt: number;
        readonly prepared: Readonly<PreparedSandboxExecution> | null;
      }
    | undefined;

  const identity = freeze({
    toolCallId: 'tool-1',
    capabilityId: 'builtin:shell_execute',
    capabilityRevision: 'capability-1',
    invocationId: 'invocation-1',
    attempt: 1,
    effectiveEffectsDigest: 'effects-1',
    admissionDigest: 'admission-1',
    cancellationCorrelation: 'cancel-1',
  });
  const preparationDraft = createBuiltinSandboxPreparation({
    identity,
    canonicalWorkspace: workspace,
    workspace,
    command: 'printf hello',
    executionBoundaryDigest: 'boundary-1',
    protectedPathRevision: 'protected-1',
    timeoutMs: 5_000,
  });
  preparation = preparationDraft.preparation;
  const intentDigest = sandboxPreparationIntentDigest({
    attempt: preparation.attempt,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest: sandboxPreparationDigest(preparation),
    commandDigest: options.tamperCommandDigest ? 'tampered-command' : preparation.commandDigest,
    executionBoundaryDigest: preparation.executionBoundaryDigest,
    resourceSemantics: 'allocating',
  });
  const plan: PreparedSandboxExecution = {
    schema: 'kite.sandbox-execution-provider.v1',
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
    preparationDigest: options.tamperPreparationDigest
      ? 'tampered-preparation'
      : sandboxPreparationDigest(preparation),
    commandDigest: preparation.commandDigest,
    approvedArgv: preparation.argv,
    argv: preparation.argv,
    cwd: preparation.canonicalWorkspace,
    env: null,
    stdin: null,
    transport: 'stdio',
    backend: options.tamperBackend ? 'seatbelt' : backend,
    backendCapabilities: sandboxBackendCapabilities(backend),
    enforcement: 'full',
    resourceSemantics: 'allocating',
    expiresAtMs: options.expired ? Date.now() - 1 : Date.now() + 60_000,
    cleanup: { kind: 'none', resourceId: 'none', recoveryPayload: {} },
  };
  prepared = options.mutablePrepared ? plan : freeze(plan);

  const lifecycle: SandboxPreparationLifecycle = {
    async recordPreparationIntent(candidate) {
      events.push('intent');
      if (!options.intentAcknowledged) throw new Error('intent denied');
      preparation = candidate;
      return freeze({ acknowledged: true, stage: 'preparation_intent', intentDigest });
    },
    async recordPreparationReady(candidate) {
      events.push('ready');
      if (!options.readyAcknowledged || candidate !== prepared) {
        throw new Error('ready denied');
      }
      return freeze({
        acknowledged: true,
        stage: 'preparation_ready',
        readyDigest: 'ready-1',
        preparationArtifact: freeze({
          artifactId: 'artifact-1',
          kind: 'sandbox_preparation',
          integrityIdentifier: 'integrity-1',
          byteLength: 1,
        }),
      });
    },
    async recordExecutionDispatchIntent(candidate, input) {
      events.push('dispatch');
      if (!options.dispatchAcknowledged || candidate !== prepared) {
        throw new Error('dispatch denied');
      }
      dispatch = { ...input, dispatchIntentDigest: 'dispatch-1' };
      return freeze({
        acknowledged: true,
        stage: 'execution_dispatch_intent',
        ...input,
        dispatchIntentDigest: 'dispatch-1',
      });
    },
    async recordExecutionSupervisorStarted(candidate, input) {
      events.push('supervisor');
      if (candidate !== prepared || input.dispatchIntentDigest !== dispatch?.dispatchIntentDigest) {
        throw new Error('supervisor denied');
      }
      return freeze({
        acknowledged: true,
        stage: 'execution_supervisor_started',
        ...input,
      });
    },
    async recordDisposalIntent(candidate) {
      events.push('disposal-intent');
      disposal = {
        purpose: candidate ? 'dispose' : 'reconcile_preparation_intent',
        lifecycleIntentDigest: 'cleanup-1',
        cleanupAttempt: 1,
        prepared: candidate,
      };
      return freeze({
        acknowledged: true,
        stage: 'disposal_intent',
        purpose: disposal.purpose,
        lifecycleIntentDigest: disposal.lifecycleIntentDigest,
        cleanupAttempt: disposal.cleanupAttempt,
      });
    },
    async recordDisposalReceipt(input) {
      events.push('disposal-receipt');
      if (options.disposalReceiptAcknowledged === false) {
        throw new Error('disposal receipt unavailable');
      }
      return freeze({
        acknowledged: true,
        stage: 'disposal_receipt',
        purpose: input.purpose,
        lifecycleIntentDigest: input.lifecycleIntentDigest,
        cleanupAttempt: input.cleanupAttempt,
        disposed: input.disposed,
      });
    },
  };

  const grants = new SandboxExecutionGrantAuthority();
  const processResult =
    options.processResult ??
    freeze({
      kind: 'completed',
      executionPhase: 'go_started',
      exitCode: 0,
      stdout: 'hello',
      stderr: '',
      processCleanup: {
        confirmedExited: true,
        gracefulRequested: true,
        forced: false,
        unconfirmedDescendantCount: 0,
      },
    } satisfies SandboxPreparedProcessExecutionResult);
  const preparedProcess: SandboxPreparedProcessExecutionPort = {
    async execute(input) {
      events.push('process');
      processCalls += 1;
      if (options.processThrows) throw new Error('transport lost after dispatch');
      if (processResult.kind === 'completed') {
        await input.lifecycle.recordExecutionSupervisorStarted(input.prepared, {
          dispatchId: input.dispatchIntent.dispatchId,
          dispatchIntentDigest: input.dispatchIntent.dispatchIntentDigest,
          supervisorPid: 1,
          processGroupId: 1,
          processStartIdentity: 'start-1',
        });
      }
      return processResult;
    },
  };
  const provider: SandboxExecutionProvider = {
    resourceSemantics: 'allocating',
    async prepare() {
      providerPrepareCalls += 1;
      events.push('prepare');
      return { ok: true, observation: prepared! };
    },
    async dispose() {
      providerDisposeCalls += 1;
      events.push('dispose');
      return { ok: true, observation: { disposed: true } };
    },
    async reconcilePreparationIntent() {
      providerReconcileCalls += 1;
      events.push('reconcile');
      return { ok: true, observation: { disposed: true } };
    },
    async reconcile() {
      return { ok: true, observation: { disposed: true } };
    },
  };
  const consumer = createBuiltinPreparedShellExecutionConsumer({
    provider,
    backend,
    grants,
    preparedProcess,
    canonicalWorkspace: workspace,
    executionBoundaryDigest: 'boundary-1',
    protectedPathRevision: 'protected-1',
    createDispatchIdentity: () => ({ dispatchId: 'dispatch-1', supervisorNonce: 'nonce-1' }),
  });

  return {
    workspace,
    identity,
    lifecycle,
    consumer,
    events,
    counts: () => ({
      providerPrepareCalls,
      providerDisposeCalls,
      providerReconcileCalls,
      processCalls,
    }),
    close: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

describe('Builtin prepared shell execution consumer candidate', () => {
  test('consumes one exact prepared attempt and disposes after the process port', async () => {
    const harness = makeHarness({
      intentAcknowledged: true,
      readyAcknowledged: true,
      dispatchAcknowledged: true,
    });
    try {
      const result = await harness.consumer({
        identity: harness.identity,
        workspace: harness.workspace,
        command: 'printf hello',
        timeoutMs: 5_000,
        lifecycle: harness.lifecycle,
      });
      expect(result.kind).toBe('completed');
      expect(result.ok).toBe(true);
      expect(result.processResult?.kind).toBe('completed');
      expect(harness.counts()).toEqual({
        providerPrepareCalls: 1,
        providerDisposeCalls: 1,
        providerReconcileCalls: 0,
        processCalls: 1,
      });
      expect(harness.events).toEqual([
        'intent',
        'prepare',
        'ready',
        'dispatch',
        'process',
        'supervisor',
        'disposal-intent',
        'dispose',
        'disposal-receipt',
      ]);
    } finally {
      harness.close();
    }
  });

  test('fails closed on missing intent acknowledgement without provider or process calls', async () => {
    const harness = makeHarness({
      intentAcknowledged: false,
      readyAcknowledged: true,
      dispatchAcknowledged: true,
    });
    try {
      const result = await harness.consumer({
        identity: harness.identity,
        workspace: harness.workspace,
        command: 'printf hello',
        timeoutMs: 5_000,
        lifecycle: harness.lifecycle,
      });
      expect(result.ok).toBe(false);
      expect(result.sandboxFailure?.stage).toBe('pre_dispatch');
      expect(harness.counts()).toEqual({
        providerPrepareCalls: 0,
        providerDisposeCalls: 0,
        providerReconcileCalls: 0,
        processCalls: 0,
      });
    } finally {
      harness.close();
    }
  });

  test('fails closed on missing ready acknowledgement without process dispatch', async () => {
    const harness = makeHarness({
      intentAcknowledged: true,
      readyAcknowledged: false,
      dispatchAcknowledged: true,
    });
    try {
      const result = await harness.consumer({
        identity: harness.identity,
        workspace: harness.workspace,
        command: 'printf hello',
        timeoutMs: 5_000,
        lifecycle: harness.lifecycle,
      });
      expect(result.ok).toBe(false);
      expect(harness.counts()).toEqual({
        providerPrepareCalls: 1,
        providerDisposeCalls: 0,
        providerReconcileCalls: 1,
        processCalls: 0,
      });
      expect(harness.events).not.toContain('process');
    } finally {
      harness.close();
    }
  });

  test('rejects every prepared identity, freeze, backend, command, and expiry drift before dispatch', async () => {
    for (const drift of [
      { tamperPreparationDigest: true },
      { tamperCommandDigest: true },
      { tamperBackend: true },
      { expired: true },
      { mutablePrepared: true },
    ]) {
      const harness = makeHarness({
        intentAcknowledged: true,
        readyAcknowledged: true,
        dispatchAcknowledged: true,
        ...drift,
      });
      try {
        const result = await harness.consumer({
          identity: harness.identity,
          workspace: harness.workspace,
          command: 'printf hello',
          timeoutMs: 5_000,
          lifecycle: harness.lifecycle,
        });
        expect(result.ok).toBe(false);
        expect(result.sandboxFailure?.stage).toBe('pre_dispatch');
        expect(harness.counts().processCalls).toBe(0);
        expect(harness.events).not.toContain('ready');
        expect(harness.events).not.toContain('dispatch');
      } finally {
        harness.close();
      }
    }
  });

  test('rejects missing dispatch acknowledgement before process', async () => {
    const harness = makeHarness({
      intentAcknowledged: true,
      readyAcknowledged: true,
      dispatchAcknowledged: false,
    });
    try {
      const result = await harness.consumer({
        identity: harness.identity,
        workspace: harness.workspace,
        command: 'printf hello',
        timeoutMs: 5_000,
        lifecycle: harness.lifecycle,
      });
      expect(result.ok).toBe(false);
      expect(harness.counts()).toEqual({
        providerPrepareCalls: 1,
        providerDisposeCalls: 1,
        providerReconcileCalls: 0,
        processCalls: 0,
      });
    } finally {
      harness.close();
    }
  });

  test('preserves post-GO unknown as typed non-retryable evidence', async () => {
    const unknown = freeze({
      kind: 'unknown',
      executionPhase: 'unknown_after_go',
      exitCode: null,
      stdout: '',
      stderr: 'terminal unavailable',
      unknown: { code: 'post_go_terminal_unknown', message: 'terminal unavailable' },
      retryable: false,
      processCleanup: {
        confirmedExited: false,
        gracefulRequested: false,
        forced: false,
        unconfirmedDescendantCount: 1,
      },
    } satisfies SandboxPreparedProcessExecutionResult);
    const harness = makeHarness({
      intentAcknowledged: true,
      readyAcknowledged: true,
      dispatchAcknowledged: true,
      processResult: unknown,
    });
    try {
      const result = await harness.consumer({
        identity: harness.identity,
        workspace: harness.workspace,
        command: 'printf hello',
        timeoutMs: 5_000,
        lifecycle: harness.lifecycle,
      });
      expect(result.kind).toBe('unknown');
      expect(result.processResult).toMatchObject({ kind: 'unknown', retryable: false });
      expect(result.processResult?.processCleanup.confirmedExited).toBe(false);
      expect(harness.counts().processCalls).toBe(1);
    } finally {
      harness.close();
    }
  });

  test('conservatively treats a supplied process-port throw as non-retryable post-GO unknown', async () => {
    const harness = makeHarness({
      intentAcknowledged: true,
      readyAcknowledged: true,
      dispatchAcknowledged: true,
      processThrows: true,
    });
    try {
      const result = await harness.consumer({
        identity: harness.identity,
        workspace: harness.workspace,
        command: 'printf hello',
        timeoutMs: 5_000,
        lifecycle: harness.lifecycle,
      });
      expect(result).toMatchObject({
        kind: 'unknown',
        ok: false,
        processResult: {
          kind: 'unknown',
          executionPhase: 'unknown_after_go',
          retryable: false,
        },
        disposal: { acknowledged: true, disposed: true },
      });
      expect(harness.counts()).toEqual({
        providerPrepareCalls: 1,
        providerDisposeCalls: 1,
        providerReconcileCalls: 0,
        processCalls: 1,
      });
    } finally {
      harness.close();
    }
  });

  test('keeps a post-GO disposal receipt failure unknown and non-retryable', async () => {
    const harness = makeHarness({
      intentAcknowledged: true,
      readyAcknowledged: true,
      dispatchAcknowledged: true,
      disposalReceiptAcknowledged: false,
    });
    try {
      const result = await harness.consumer({
        identity: harness.identity,
        workspace: harness.workspace,
        command: 'printf hello',
        timeoutMs: 5_000,
        lifecycle: harness.lifecycle,
      });
      expect(result).toMatchObject({
        kind: 'unknown',
        ok: false,
        processResult: {
          kind: 'unknown',
          executionPhase: 'unknown_after_go',
          retryable: false,
          unknown: { code: 'post_go_cleanup_unknown' },
        },
        sandboxFailure: {
          code: 'dispose_failed',
          stage: 'post_dispatch',
          cleanupConfirmed: true,
        },
      });
      expect(harness.counts()).toEqual({
        providerPrepareCalls: 1,
        providerDisposeCalls: 1,
        providerReconcileCalls: 0,
        processCalls: 1,
      });
    } finally {
      harness.close();
    }
  });
});
