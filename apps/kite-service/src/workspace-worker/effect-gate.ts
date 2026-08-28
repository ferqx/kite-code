export type WorkspaceMutationKind =
  | 'filesystem'
  | 'shell'
  | 'git'
  | 'workspace_config'
  | 'mcp_project'
  | 'sandbox_external';

export interface WorkspaceEffectAttempt {
  /** Store-owned Session identity for the effect evidence row. */
  readonly sessionId: string;
  /** The command receipt identity when the caller has one; invocationId is always present. */
  readonly commandId: string | null;
  /** Exact prepared invocation identity. */
  readonly invocationId: string;
  /** Native caller identity carried through WorkerCommandContext. */
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
  /** Durable Store owner identity; normally the Worker instance identity. */
  readonly ownerId: string;
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  readonly attemptId: string;
  /** Digest of the exact prepared request, never recomputed from arguments here. */
  readonly requestDigest: string;
  /** Bounded expiry shared by Store effect and external resource evidence. */
  readonly expiresAtMs: number;
  /** Optional hash-only capability evidence. Raw capability material is forbidden. */
  readonly capabilityDigest?: string;
  readonly resourceId: string;
  readonly kind: WorkspaceMutationKind;
}

export interface WorkspaceEffectEvidencePort {
  inspect(
    attempt: WorkspaceEffectAttempt,
  ): Promise<'absent' | 'prepared' | 'dispatch_acknowledged' | 'terminal' | 'outcome_unknown'>;
  prepare(attempt: WorkspaceEffectAttempt): Promise<void>;
  acknowledgeDispatch(attempt: WorkspaceEffectAttempt): Promise<void>;
  commitTerminal(attempt: WorkspaceEffectAttempt): Promise<void>;
  commitUnknown(attempt: WorkspaceEffectAttempt): Promise<void>;
}

export interface WorkspaceResourceLease extends AsyncDisposable {
  readonly resourceId: string;
}

export interface WorkspaceResourceLeasePort {
  acquire(attempt: WorkspaceEffectAttempt): Promise<WorkspaceResourceLease>;
}

export interface WorkspaceEffectGate {
  run<Result>(
    attempt: WorkspaceEffectAttempt,
    dispatch: () => Promise<Result>,
  ): Promise<
    | { readonly status: 'applied'; readonly result: Result }
    | { readonly status: 'already_applied' }
    | { readonly status: 'unknown' }
  >;
}

/**
 * Worker-local mutation serialization with injected durable evidence and an
 * OS-user shared-resource lease. The first implementation deliberately
 * serializes every mutation in one Workspace instead of guessing read-only
 * shell semantics.
 */
export function createWorkspaceEffectGate(input: {
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  readonly evidence: WorkspaceEffectEvidencePort;
  readonly resources: WorkspaceResourceLeasePort;
}): WorkspaceEffectGate {
  let tail = Promise.resolve();

  return Object.freeze({
    run<Result>(attempt: WorkspaceEffectAttempt, dispatch: () => Promise<Result>) {
      assertAttempt(attempt, input.workerScopeId, input.workspaceDigest);
      const execute = async () => {
        let lease: WorkspaceResourceLease | undefined;
        let acknowledged = false;
        try {
          const durable = await input.evidence.inspect(attempt);
          if (durable === 'terminal') return { status: 'already_applied' as const };
          if (durable === 'dispatch_acknowledged' || durable === 'outcome_unknown') {
            return { status: 'unknown' as const };
          }
          if (durable === 'absent') await input.evidence.prepare(attempt);
          lease = await input.resources.acquire(attempt);
          await input.evidence.acknowledgeDispatch(attempt);
          acknowledged = true;
          const result = await dispatch();
          await input.evidence.commitTerminal(attempt);
          return { status: 'applied' as const, result };
        } catch (error) {
          if (!acknowledged) throw error;
          await input.evidence.commitUnknown(attempt);
          return { status: 'unknown' as const };
        } finally {
          await lease?.[Symbol.asyncDispose]();
        }
      };
      const result = tail.then(execute, execute);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
}

function assertAttempt(
  attempt: WorkspaceEffectAttempt,
  workerScopeId: string,
  workspaceDigest: string,
): void {
  if (
    !safeId(attempt.sessionId) ||
    (attempt.commandId !== null && !safeId(attempt.commandId)) ||
    !safeId(attempt.invocationId) ||
    !safeId(attempt.clientId) ||
    !Number.isSafeInteger(attempt.connectionGeneration) ||
    attempt.connectionGeneration < 1 ||
    !Number.isSafeInteger(attempt.controllerGeneration) ||
    attempt.controllerGeneration < 1 ||
    !safeId(attempt.workerInstanceId) ||
    !safeId(attempt.ownerId) ||
    attempt.workerScopeId !== workerScopeId ||
    attempt.workspaceDigest !== workspaceDigest ||
    !safeId(attempt.attemptId) ||
    !/^[a-f0-9]{64}$/u.test(attempt.requestDigest) ||
    !Number.isSafeInteger(attempt.expiresAtMs) ||
    attempt.expiresAtMs <= 0 ||
    (attempt.capabilityDigest !== undefined && !/^[a-f0-9]{64}$/u.test(attempt.capabilityDigest)) ||
    !safeId(attempt.resourceId)
  ) {
    throw new TypeError('Workspace effect attempt identity is invalid.');
  }
}

function safeId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value);
}
