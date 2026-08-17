import {
  type SandboxExecutionGrantVerifierV1,
  sandboxCleanupDigestV1,
  sandboxPreparedPlanDigestV1,
} from '@/core/execution/sandbox-execution';
import type {
  PreparedSandboxExecutionV1,
  SandboxCleanupGrantV1,
  SandboxExecutionProviderResultV1,
  SandboxExecutionProviderV1,
  SandboxPreparationGrantV1,
  SandboxPreparationResourceSemanticsV1,
} from '@/protocol/sandbox-execution-provider';

type FakeCleanupResult = SandboxExecutionProviderResultV1<{ readonly disposed: true }>;
type FakePreparedCleanup = (
  grant: Readonly<SandboxCleanupGrantV1>,
  prepared: Readonly<PreparedSandboxExecutionV1>,
) => FakeCleanupResult;
type FakeIntentCleanup = (grant: Readonly<SandboxCleanupGrantV1>) => FakeCleanupResult;

export class ScriptableFakeSandboxExecutionProviderV1 implements SandboxExecutionProviderV1 {
  readonly resourceSemantics: SandboxPreparationResourceSemanticsV1;
  readonly #verifier: SandboxExecutionGrantVerifierV1;
  readonly #prepare: (
    grant: Readonly<SandboxPreparationGrantV1>,
  ) => SandboxExecutionProviderResultV1<PreparedSandboxExecutionV1>;
  readonly #dispose?: FakePreparedCleanup;
  readonly #reconcile?: FakePreparedCleanup;
  readonly #reconcileIntent?: FakeIntentCleanup;
  readonly #counts = { prepare: 0, dispose: 0, reconcile: 0 };

  constructor(input: {
    verifier: SandboxExecutionGrantVerifierV1;
    resourceSemantics?: SandboxPreparationResourceSemanticsV1;
    prepare: (
      grant: Readonly<SandboxPreparationGrantV1>,
    ) => SandboxExecutionProviderResultV1<PreparedSandboxExecutionV1>;
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

  async prepare(input: { grant: SandboxPreparationGrantV1; signal?: AbortSignal }) {
    const grant = this.#verifier.verify(input.grant);
    this.#counts.prepare++;
    return this.#prepare(grant);
  }

  async dispose(input: {
    grant: SandboxCleanupGrantV1;
    prepared: PreparedSandboxExecutionV1;
    signal?: AbortSignal;
  }) {
    const grant = this.#verifyPreparedCleanup(input.grant, input.prepared, 'dispose');
    this.#counts.dispose++;
    return this.#dispose?.(grant, input.prepared) ?? success();
  }

  async reconcile(input: {
    grant: SandboxCleanupGrantV1;
    prepared: PreparedSandboxExecutionV1;
    signal?: AbortSignal;
  }) {
    const grant = this.#verifyPreparedCleanup(input.grant, input.prepared, 'reconcile');
    this.#counts.reconcile++;
    return this.#reconcile?.(grant, input.prepared) ?? success();
  }

  async reconcilePreparationIntent(input: { grant: SandboxCleanupGrantV1; signal?: AbortSignal }) {
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
    source: SandboxCleanupGrantV1,
    prepared: PreparedSandboxExecutionV1,
    purpose: 'dispose' | 'reconcile',
  ): Readonly<SandboxCleanupGrantV1> {
    const grant = this.#verifier.verifyCleanup(source);
    if (
      grant.purpose !== purpose ||
      grant.preparedPlanDigest !== sandboxPreparedPlanDigestV1(prepared) ||
      grant.cleanupDigest !== sandboxCleanupDigestV1(prepared.cleanup)
    ) {
      throw new Error('Fake sandbox prepared cleanup identity mismatch.');
    }
    return grant;
  }
}

function success() {
  return { ok: true as const, observation: { disposed: true as const } };
}
