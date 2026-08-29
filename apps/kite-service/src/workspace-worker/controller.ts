export type ControllerClientKind = 'tui' | 'desktop' | 'web_observer';

export interface SessionControllerLease {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
  readonly state: 'active' | 'detached';
}

export interface ControllerOperationRequest {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly sessionId: string;
  readonly clientId: string;
  readonly clientKind: ControllerClientKind;
  readonly connectionGeneration: number;
}

export type ControllerOperationResult =
  | { readonly status: 'applied'; readonly lease: SessionControllerLease }
  | {
      readonly status: 'observer';
      readonly lease: SessionControllerLease | null;
      readonly controllerGeneration: number;
    }
  | {
      readonly status: 'conflict';
      readonly lease: SessionControllerLease | null;
      readonly controllerGeneration: number;
    };

export interface SessionControllerStoredState {
  readonly lease: SessionControllerLease | null;
  readonly controllerGeneration: number;
}

export interface SessionControllerStore {
  inspect(sessionId: string): Promise<SessionControllerStoredState>;
  lookupOperation(
    sessionId: string,
    requestId: string,
    requestDigest: string,
  ): Promise<ControllerOperationResult | 'digest_mismatch' | null>;
  commitOperation(input: {
    readonly request: ControllerOperationRequest;
    readonly expectedGeneration: number;
    readonly result: ControllerOperationResult;
  }): Promise<ControllerOperationResult>;
  markDetached(clientId: string, connectionGeneration: number): Promise<void>;
}

export interface SessionControllerAuthority {
  open(request: ControllerOperationRequest): Promise<ControllerOperationResult>;
  requestControl(request: ControllerOperationRequest): Promise<ControllerOperationResult>;
  releaseControl(request: ControllerOperationRequest): Promise<ControllerOperationResult>;
  markConnectionDetached(clientId: string, connectionGeneration: number): Promise<void>;
  authorizeMutation(input: {
    readonly sessionId: string;
    readonly clientId: string;
    readonly connectionGeneration: number;
    readonly controllerGeneration: number;
  }): Promise<boolean>;
}

/**
 * In-memory Controller conformance seam retained for the focused unit tests below. Production
 * Worker composition must use `createWorkspaceWorkerControllerAdapter`, which delegates to the
 * injected Store 8 `workspaceAuthority.controller`; this helper is never a production owner.
 */
export function createSessionControllerAuthority(input: {
  readonly workerInstanceId: string;
  readonly store: SessionControllerStore;
}): SessionControllerAuthority {
  const sessionTails = new Map<string, Promise<void>>();

  const serialized = <Result>(
    sessionId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const prior = sessionTails.get(sessionId) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    sessionTails.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };

  const replay = async (
    request: ControllerOperationRequest,
  ): Promise<ControllerOperationResult | undefined> => {
    const found = await input.store.lookupOperation(
      request.sessionId,
      request.requestId,
      request.requestDigest,
    );
    if (found === 'digest_mismatch') throw new Error('Controller operation digest mismatch.');
    return found ?? undefined;
  };

  return Object.freeze({
    open(request: ControllerOperationRequest) {
      assertRequest(request);
      return serialized(request.sessionId, async () => {
        const existing = await input.store.inspect(request.sessionId);
        return {
          status: 'observer' as const,
          lease: existing.lease,
          controllerGeneration: existing.controllerGeneration,
        };
      });
    },
    requestControl(request: ControllerOperationRequest) {
      assertRequest(request);
      if (request.clientKind === 'web_observer') {
        return input.store.inspect(request.sessionId).then((existing) => ({
          status: 'observer' as const,
          lease: existing.lease,
          controllerGeneration: existing.controllerGeneration,
        }));
      }
      return serialized(request.sessionId, async () => {
        const prior = await replay(request);
        if (prior) return prior;
        const existing = await input.store.inspect(request.sessionId);
        if (existing.lease) {
          return {
            status: 'conflict' as const,
            lease: existing.lease,
            controllerGeneration: existing.controllerGeneration,
          };
        }
        const generation = existing.controllerGeneration + 1;
        const result = {
          status: 'applied' as const,
          lease: {
            sessionId: request.sessionId,
            clientId: request.clientId,
            connectionGeneration: request.connectionGeneration,
            controllerGeneration: generation,
            workerInstanceId: input.workerInstanceId,
            state: 'active' as const,
          },
        };
        return input.store.commitOperation({
          request,
          expectedGeneration: existing.controllerGeneration,
          result,
        });
      });
    },
    releaseControl(request: ControllerOperationRequest) {
      assertRequest(request);
      if (request.clientKind === 'web_observer') {
        return input.store.inspect(request.sessionId).then((existing) => ({
          status: 'observer' as const,
          lease: existing.lease,
          controllerGeneration: existing.controllerGeneration,
        }));
      }
      return serialized(request.sessionId, async () => {
        const prior = await replay(request);
        if (prior) return prior;
        const existing = await input.store.inspect(request.sessionId);
        if (
          !existing.lease ||
          existing.lease.clientId !== request.clientId ||
          existing.lease.connectionGeneration !== request.connectionGeneration
        ) {
          return {
            status: 'conflict' as const,
            lease: existing.lease,
            controllerGeneration: existing.controllerGeneration,
          };
        }
        const result = {
          status: 'observer' as const,
          lease: null,
          controllerGeneration: existing.controllerGeneration + 1,
        };
        return input.store.commitOperation({
          request,
          expectedGeneration: existing.controllerGeneration,
          result,
        });
      });
    },
    markConnectionDetached(clientId: string, connectionGeneration: number) {
      if (!safeId(clientId) || !Number.isSafeInteger(connectionGeneration)) {
        return Promise.reject(new TypeError('Controller connection identity is invalid.'));
      }
      return input.store.markDetached(clientId, connectionGeneration);
    },
    async authorizeMutation(authority: {
      readonly sessionId: string;
      readonly clientId: string;
      readonly connectionGeneration: number;
      readonly controllerGeneration: number;
    }) {
      return serialized(authority.sessionId, async () => {
        const { lease } = await input.store.inspect(authority.sessionId);
        return Boolean(
          lease &&
            lease.state === 'active' &&
            lease.workerInstanceId === input.workerInstanceId &&
            lease.clientId === authority.clientId &&
            lease.connectionGeneration === authority.connectionGeneration &&
            lease.controllerGeneration === authority.controllerGeneration,
        );
      });
    },
  });
}

function assertRequest(request: ControllerOperationRequest): void {
  if (
    !safeId(request.requestId) ||
    !/^[a-f0-9]{64}$/u.test(request.requestDigest) ||
    !safeId(request.sessionId) ||
    !safeId(request.clientId) ||
    !Number.isSafeInteger(request.connectionGeneration) ||
    request.connectionGeneration < 1
  ) {
    throw new TypeError('Controller operation request is invalid.');
  }
}

function safeId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value);
}
