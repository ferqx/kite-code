import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '@kite/agent-kernel';
import type { ModelResponseSource } from '@kite/builtin-runtime/model';
import {
  type BuiltinModelOperationAttempt,
  type BuiltinModelOperationExecutionPort,
  canonicalModelJson,
  createLiveModelResponseSource,
  type ModelArtifactWriter,
  ModelInvocationGateway,
  type ModelInvocationPersistence,
  type SingleAttemptTransport,
} from '@kite/builtin-runtime/model';
import type { RuntimeIdSource } from '@kite/runtime-host';
import {
  createRuntimeHostStateInitialState,
  planModelInvocationResource,
  type RuntimeState,
} from '@kite/runtime-host/kernel-adapter';
import type { ModelResponseRecord, ModelSurface, PrivateArtifactRef } from '@kite/runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

function artifactRef<K extends 'model_surface' | 'model_response'>(
  kind: K,
  value: ModelSurface | ModelResponseRecord,
): PrivateArtifactRef & { kind: K } {
  const bytes = Buffer.from(canonicalModelJson(value), 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    artifactId: `artifact-${digest}`,
    kind,
    integrityIdentifier: `sha256:${digest}`,
    byteLength: bytes.byteLength,
  };
}

/** Test-only direct mechanism. Production must use the App-composed Host port. */
export function testBuiltinModelOperationExecutionPort(): BuiltinModelOperationExecutionPort {
  return Object.freeze({
    execute: (input: BuiltinModelOperationAttempt) => input.attempt(),
  });
}

/** Explicit, in-memory test composition. It is never used by production code. */
export function createTestModelInvocationHarness(input: {
  workspace: string;
  threadId?: string;
  state?: RuntimeState;
  persist?: (events: RuntimeEvent[]) => boolean | Promise<boolean>;
  artifacts?: ModelArtifactWriter;
  transport?: SingleAttemptTransport;
  source?: ModelResponseSource;
  operationExecution?: BuiltinModelOperationExecutionPort;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  runtimeIdSource?: RuntimeIdSource;
  preserveMissingProjectIdentity?: boolean;
}): {
  gateway: ModelInvocationGateway;
  persistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent>;
  events: RuntimeEvent[];
  getState(): RuntimeState;
} {
  let state =
    input.state ??
    createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: input.threadId ?? 'test-model-invocation',
      userId: 'test',
      workspace: input.workspace,
    });
  if (
    !input.preserveMissingProjectIdentity &&
    (!state.session.projectId || !state.session.canonicalWorkspaceDigest)
  ) {
    state = {
      ...state,
      session: {
        ...state.session,
        projectId: 'project_test_model_invocation',
        canonicalWorkspaceDigest: `sha256:${createHash('sha256')
          .update(input.workspace)
          .digest('hex')}`,
      },
    };
  }
  const events: RuntimeEvent[] = [];
  const persistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent> = {
    getState: () => state,
    persistEvents: async (batch) => {
      if (input.persist && !(await input.persist(batch))) return false;
      for (const event of batch) {
        state = { ...reduceRuntimeState(state, event), revision: state.revision + 1 };
        events.push(event);
      }
      return true;
    },
  };
  const gateway = new ModelInvocationGateway({
    artifacts:
      input.artifacts ??
      ({
        writeSurface: (surface) => artifactRef('model_surface', surface),
        writeResponse: (record) => artifactRef('model_response', record),
      } satisfies ModelArtifactWriter),
    source: input.source ?? createLiveModelResponseSource(input.transport),
    operationExecution: input.operationExecution ?? testBuiltinModelOperationExecutionPort(),
    ...(input.now ? { now: input.now } : {}),
    ...(input.runtimeIdSource ? { runtimeIdSource: input.runtimeIdSource } : {}),
    planResource: (state, request) => planModelInvocationResource(state as RuntimeState, request),
    sleep: input.sleep ?? (async () => {}),
  });
  return { gateway, persistence, events, getState: () => state };
}
