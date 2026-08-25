import type {
  PreparedSandboxExecution,
  SandboxCleanupGrant,
  SandboxExecutionProvider,
  SandboxExecutionProviderResult,
  SandboxPreparationGrant,
  SandboxPreparationResourceSemantics,
} from '@kite/runtime-spi';
import {
  type SandboxExecutionGrantVerifier,
  sandboxCleanupDigest,
  sandboxPreparedPlanDigest,
} from '#app/sandbox/runtime-execution';

type FakeCleanupResult = SandboxExecutionProviderResult<{ readonly disposed: true }>;
type FakePreparedCleanup = (
  grant: Readonly<SandboxCleanupGrant>,
  prepared: Readonly<PreparedSandboxExecution>,
) => FakeCleanupResult;
type FakeIntentCleanup = (grant: Readonly<SandboxCleanupGrant>) => FakeCleanupResult;

export class ScriptableFakeSandboxExecutionProvider implements SandboxExecutionProvider {
  readonly resourceSemantics: SandboxPreparationResourceSemantics;
  readonly #verifier: SandboxExecutionGrantVerifier;
  readonly #prepare: (
    grant: Readonly<SandboxPreparationGrant>,
  ) => SandboxExecutionProviderResult<PreparedSandboxExecution>;
  readonly #dispose?: FakePreparedCleanup;
  readonly #reconcile?: FakePreparedCleanup;
  readonly #reconcileIntent?: FakeIntentCleanup;
  readonly #counts = { prepare: 0, dispose: 0, reconcile: 0 };

  constructor(input: {
    verifier: SandboxExecutionGrantVerifier;
    resourceSemantics?: SandboxPreparationResourceSemantics;
    prepare: (
      grant: Readonly<SandboxPreparationGrant>,
    ) => SandboxExecutionProviderResult<PreparedSandboxExecution>;
    dispose?: FakePreparedCleanup;
    reconcile?: FakePreparedCleanup;
    reconcilePreparationIntent?: FakeIntentCleanup;
  }) {
    this.#verifier = input.verifier;
    this.resourceSemantics = input.resourceSemantics ?? 'pure';
    this.#prepare = input.prepare;
    this.#dispose = input.dispose;
    this.#reconcile = input.reconcile;
    this.#reconcileIntent = input.reconcilePreparationIntent;
  }

  calls() {
    return { ...this.#counts };
  }

  async prepare(input: { grant: SandboxPreparationGrant; signal?: AbortSignal }) {
    const grant = this.#verifier.verify(input.grant);
    this.#counts.prepare++;
    return this.#prepare(grant);
  }

  async dispose(input: {
    grant: SandboxCleanupGrant;
    prepared: PreparedSandboxExecution;
    signal?: AbortSignal;
  }) {
    const grant = this.#verifyPreparedCleanup(input.grant, input.prepared, 'dispose');
    this.#counts.dispose++;
    return this.#dispose?.(grant, input.prepared) ?? success();
  }

  async reconcile(input: {
    grant: SandboxCleanupGrant;
    prepared: PreparedSandboxExecution;
    signal?: AbortSignal;
  }) {
    const grant = this.#verifyPreparedCleanup(input.grant, input.prepared, 'reconcile');
    this.#counts.reconcile++;
    return this.#reconcile?.(grant, input.prepared) ?? success();
  }

  async reconcilePreparationIntent(input: { grant: SandboxCleanupGrant; signal?: AbortSignal }) {
    const grant = this.#verifier.verifyCleanup(input.grant);
    if (
      grant.purpose !== 'reconcile_preparation_intent' ||
      grant.preparedPlanDigest !== null ||
      grant.cleanupDigest !== null
    ) {
      throw new Error('Fake sandbox preparation-intent cleanup identity mismatch.');
    }
    return this.#reconcileIntent?.(grant) ?? success();
  }

  #verifyPreparedCleanup(
    source: SandboxCleanupGrant,
    prepared: PreparedSandboxExecution,
    purpose: 'dispose' | 'reconcile',
  ): Readonly<SandboxCleanupGrant> {
    const grant = this.#verifier.verifyCleanup(source);
    if (
      grant.purpose !== purpose ||
      grant.preparedPlanDigest !== sandboxPreparedPlanDigest(prepared) ||
      grant.cleanupDigest !== sandboxCleanupDigest(prepared.cleanup)
    ) {
      throw new Error('Fake sandbox prepared cleanup identity mismatch.');
    }
    return grant;
  }
}

function success() {
  return { ok: true as const, observation: { disposed: true as const } };
}
