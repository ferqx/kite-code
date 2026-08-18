import {
  WorkspaceFilesystemGrantErrorV1,
  type WorkspaceFilesystemGrantVerifierV1,
} from '@/core/execution/workspace-filesystem/grant-authority';
import type {
  FilesystemCommitGrantV1,
  FilesystemObserveGrantV1,
  FilesystemPrepareGrantV1,
  WorkspaceFilesystemCommittedMutationV1,
  WorkspaceFilesystemObserveObservationV1,
  WorkspaceFilesystemPreparedMutationV1,
  WorkspaceFilesystemProviderResultV1,
  WorkspaceFilesystemProviderV1,
} from '@/protocol/workspace-filesystem-provider';

type MaybePromise<Value> = Value | Promise<Value>;

export interface ScriptableFakeWorkspaceFilesystemProviderScriptsV1 {
  readonly observe?: (input: {
    readonly grant: Readonly<FilesystemObserveGrantV1>;
    readonly signal?: AbortSignal;
  }) => MaybePromise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemObserveObservationV1>>;
  readonly prepareMutation?: (input: {
    readonly grant: Readonly<FilesystemPrepareGrantV1>;
    readonly signal?: AbortSignal;
  }) => MaybePromise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemPreparedMutationV1>>;
  readonly commitMutation?: (input: {
    readonly grant: Readonly<FilesystemCommitGrantV1>;
    readonly signal?: AbortSignal;
  }) => MaybePromise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemCommittedMutationV1>>;
}

export interface ScriptableFakeWorkspaceFilesystemProviderCallsV1 {
  readonly observe: number;
  readonly prepareMutation: number;
  readonly commitMutation: number;
}

/** Test-only Provider with explicit scripts and no Local or filesystem fallback. */
export class ScriptableFakeWorkspaceFilesystemProviderV1 implements WorkspaceFilesystemProviderV1 {
  readonly #verifier: WorkspaceFilesystemGrantVerifierV1;
  readonly #scripts: ScriptableFakeWorkspaceFilesystemProviderScriptsV1;
  readonly #calls = { observe: 0, prepareMutation: 0, commitMutation: 0 };

  constructor(
    verifier: WorkspaceFilesystemGrantVerifierV1,
    scripts: ScriptableFakeWorkspaceFilesystemProviderScriptsV1 = {},
  ) {
    this.#verifier = verifier;
    this.#scripts = scripts;
  }

  calls(): ScriptableFakeWorkspaceFilesystemProviderCallsV1 {
    return Object.freeze({ ...this.#calls });
  }

  async observe(input: {
    readonly grant: FilesystemObserveGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemObserveObservationV1>> {
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
    readonly grant: FilesystemPrepareGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemPreparedMutationV1>> {
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
    readonly grant: FilesystemCommitGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceFilesystemProviderResultV1<WorkspaceFilesystemCommittedMutationV1>> {
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

function fakeDenied<Observation>(
  purpose: string,
): WorkspaceFilesystemProviderResultV1<Observation> {
  return deepFreeze({
    ok: false,
    failure: { code: 'fake_denied', message: `Scriptable Fake denied ${purpose}.` },
  });
}

function fakeFailure<Observation>(
  error: unknown,
): WorkspaceFilesystemProviderResultV1<Observation> {
  if (error instanceof WorkspaceFilesystemGrantErrorV1) {
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
