import {
  WorkspaceFilesystemGrantError,
  type WorkspaceFilesystemGrantVerifier,
} from '@kite-ai/builtin-runtime/filesystem';
import type {
  FilesystemCommitGrant,
  FilesystemObserveGrant,
  FilesystemPrepareGrant,
  WorkspaceFilesystemCommittedMutation,
  WorkspaceFilesystemObserveObservation,
  WorkspaceFilesystemPreparedMutation,
  WorkspaceFilesystemProvider,
  WorkspaceFilesystemProviderResult,
} from '@kite-ai/runtime-spi';

type MaybePromise<Value> = Value | Promise<Value>;

export interface ScriptableFakeWorkspaceFilesystemProviderScripts {
  readonly observe?: (input: {
    readonly grant: Readonly<FilesystemObserveGrant>;
    readonly signal?: AbortSignal;
  }) => MaybePromise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemObserveObservation>>;
  readonly prepareMutation?: (input: {
    readonly grant: Readonly<FilesystemPrepareGrant>;
    readonly signal?: AbortSignal;
  }) => MaybePromise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemPreparedMutation>>;
  readonly commitMutation?: (input: {
    readonly grant: Readonly<FilesystemCommitGrant>;
    readonly signal?: AbortSignal;
  }) => MaybePromise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemCommittedMutation>>;
}

export interface ScriptableFakeWorkspaceFilesystemProviderCalls {
  readonly observe: number;
  readonly prepareMutation: number;
  readonly commitMutation: number;
}

/** Test-only Provider with explicit scripts and no Local or filesystem fallback. */
export class ScriptableFakeWorkspaceFilesystemProvider implements WorkspaceFilesystemProvider {
  readonly #verifier: WorkspaceFilesystemGrantVerifier;
  readonly #scripts: ScriptableFakeWorkspaceFilesystemProviderScripts;
  readonly #calls = { observe: 0, prepareMutation: 0, commitMutation: 0 };

  constructor(
    verifier: WorkspaceFilesystemGrantVerifier,
    scripts: ScriptableFakeWorkspaceFilesystemProviderScripts = {},
  ) {
    this.#verifier = verifier;
    this.#scripts = scripts;
  }

  calls(): ScriptableFakeWorkspaceFilesystemProviderCalls {
    return Object.freeze({ ...this.#calls });
  }

  async observe(input: {
    readonly grant: FilesystemObserveGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemObserveObservation>> {
    try {
      assertNotAborted(input.signal);
      const grant = this.#verifier.verifyObserve(input.grant);
      assertNotAborted(input.signal);
      this.#calls.observe++;
      const script = this.#scripts.observe;
      if (!script) return fakeDenied('observe');
      return deepFreeze(await script({ grant, signal: input.signal }));
    } catch (error) {
      return fakeFailure(error);
    }
  }

  async prepareMutation(input: {
    readonly grant: FilesystemPrepareGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemPreparedMutation>> {
    try {
      assertNotAborted(input.signal);
      const grant = this.#verifier.verifyPrepare(input.grant);
      assertNotAborted(input.signal);
      this.#calls.prepareMutation++;
      const script = this.#scripts.prepareMutation;
      if (!script) return fakeDenied('prepare_mutation');
      return deepFreeze(await script({ grant, signal: input.signal }));
    } catch (error) {
      return fakeFailure(error);
    }
  }

  async commitMutation(input: {
    readonly grant: FilesystemCommitGrant;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResult<WorkspaceFilesystemCommittedMutation>> {
    try {
      assertNotAborted(input.signal);
      const grant = this.#verifier.verifyAndConsumeCommit(input.grant);
      assertNotAborted(input.signal);
      this.#calls.commitMutation++;
      const script = this.#scripts.commitMutation;
      if (!script) return fakeDenied('commit_mutation');
      return deepFreeze(await script({ grant, signal: input.signal }));
    } catch (error) {
      return fakeFailure(error);
    }
  }
}

function fakeDenied<Observation>(purpose: string): WorkspaceFilesystemProviderResult<Observation> {
  return deepFreeze({
    ok: false,
    failure: { code: 'fake_denied', message: `Scriptable Fake denied ${purpose}.` },
  });
}

function fakeFailure<Observation>(error: unknown): WorkspaceFilesystemProviderResult<Observation> {
  if (error instanceof WorkspaceFilesystemGrantError) {
    return deepFreeze({ ok: false, failure: { code: error.code, message: error.message } });
  }
  if (error instanceof FakeCancellationError) {
    return deepFreeze({
      ok: false,
      failure: { code: 'cancelled', message: 'Scriptable Fake operation was cancelled.' },
    });
  }
  return deepFreeze({
    ok: false,
    failure: { code: 'fake_crashed', message: 'Scriptable Fake operation crashed.' },
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FakeCancellationError();
}

class FakeCancellationError extends Error {}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
