import { createHash } from 'node:crypto';
import {
  type ModelArtifactWriterV1,
  ModelInvocationGatewayV1,
  type ModelInvocationPersistenceV1,
  type SingleAttemptTransportV1,
} from '@/core/model/invocation-gateway';
import type { ModelResponseSourceV1 } from '@/core/model/response-source';
import { createLiveModelResponseSourceV1 } from '@/core/model/response-source';
import { canonicalModelJsonV1 } from '@/core/model/surface-canonicalizer';
import type { RuntimeEvent } from '@/core/runtime/events';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import type {
  ModelResponseRecordV1,
  ModelSurfaceV1,
  PrivateArtifactRefV1,
} from '@/protocol/model-surface';

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

/** Explicit, in-memory test composition. It is never used by production code. */
export function createTestModelInvocationHarnessV1(input: {
  workspace: string;
  threadId?: string;
  state?: RuntimeState;
  persist?: (events: RuntimeEvent[]) => boolean | Promise<boolean>;
  artifacts?: ModelArtifactWriterV1;
  transport?: SingleAttemptTransportV1;
  source?: ModelResponseSourceV1;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}): {
  gateway: ModelInvocationGatewayV1;
  persistence: ModelInvocationPersistenceV1;
  events: RuntimeEvent[];
  getState(): RuntimeState;
} {
  let state =
    input.state ??
    createInitialRuntimeState({
      threadId: input.threadId ?? 'test-model-invocation',
      userId: 'test',
      workspace: input.workspace,
    });
  const events: RuntimeEvent[] = [];
  const persistence: ModelInvocationPersistenceV1 = {
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
    ...(input.now ? { now: input.now } : {}),
    sleep: input.sleep ?? (async () => {}),
  });
  return { gateway, persistence, events, getState: () => state };
}
