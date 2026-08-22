import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '@kite/agent-kernel';
import type { ModelResponseSourceV1 } from '@kite/builtin-runtime/model';
import {
  type BuiltinModelOperationAttemptV1,
  type BuiltinModelOperationExecutionPortV1,
  canonicalModelJsonV1,
  createLiveModelResponseSourceV1,
  type ModelArtifactWriterV1,
  ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  type SingleAttemptTransportV1,
} from '@kite/builtin-runtime/model';
import type { RuntimeIdSourceV1 } from '@kite/runtime-host';
import {
  createRuntimeHostState25InitialStateV1,
  planModelInvocationResourceV1,
  type RuntimeState,
} from '@kite/runtime-host';
import type {
  ModelResponseRecordV1,
  ModelSurfaceV1,
  PrivateArtifactRefV1,
} from '@kite/runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state25-reducer';

function artifactRef<K extends 'model_surface' | 'model_response'>(
  kind: K,
  value: ModelSurfaceV1 | ModelResponseRecordV1,
): PrivateArtifactRefV1 & { kind: K } {
  const bytes = Buffer.from(canonicalModelJsonV1(value), 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    artifactId: `artifact-${digest}`,
    kind,
    integrityIdentifier: `hmac-sha256:${digest}`,
    byteLength: bytes.byteLength,
  };
}

/** Test-only direct mechanism. Production must use the App-composed Host port. */
export function testBuiltinModelOperationExecutionPortV1(): BuiltinModelOperationExecutionPortV1 {
  return Object.freeze({
    execute: (input: BuiltinModelOperationAttemptV1) => input.attempt(),
  });
}

/** Explicit, in-memory test composition. It is never used by production code. */
export function createTestModelInvocationHarnessV1(input: {
  workspace: string;
  threadId?: string;
  state?: RuntimeState;
  persist?: (events: RuntimeEvent[]) => boolean | Promise<boolean>;
  artifacts?: ModelArtifactWriterV1;
  transport?: SingleAttemptTransportV1;
  source?: ModelResponseSourceV1;
  operationExecution?: BuiltinModelOperationExecutionPortV1;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  runtimeIdSource?: RuntimeIdSourceV1;
}): {
  gateway: ModelInvocationGatewayV1;
  persistence: ModelInvocationPersistenceV1<RuntimeState, RuntimeEvent>;
  events: RuntimeEvent[];
  getState(): RuntimeState;
} {
  let state =
    input.state ??
    createRuntimeHostState25InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: input.threadId ?? 'test-model-invocation',
      userId: 'test',
      workspace: input.workspace,
    });
  const events: RuntimeEvent[] = [];
  const persistence: ModelInvocationPersistenceV1<RuntimeState, RuntimeEvent> = {
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
  const gateway = new ModelInvocationGatewayV1({
    artifacts:
      input.artifacts ??
      ({
        writeSurface: (surface) => artifactRef('model_surface', surface),
        writeResponse: (record) => artifactRef('model_response', record),
      } satisfies ModelArtifactWriterV1),
    source: input.source ?? createLiveModelResponseSourceV1(input.transport),
    operationExecution: input.operationExecution ?? testBuiltinModelOperationExecutionPortV1(),
    ...(input.now ? { now: input.now } : {}),
    ...(input.runtimeIdSource ? { runtimeIdSource: input.runtimeIdSource } : {}),
    planResource: (state, request) => planModelInvocationResourceV1(state as RuntimeState, request),
    sleep: input.sleep ?? (async () => {}),
  });
  return { gateway, persistence, events, getState: () => state };
}
