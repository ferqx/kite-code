import type {
  BuiltinContextCompactorV1,
  CompactionReporter,
  ContextCompactionProgressPhase,
  ContextProjectionEnvironment,
} from '@kite/builtin-runtime/model';
import { executeBuiltinContextCompactionV1 } from '@kite/builtin-runtime/model';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

type PendingContextCompaction = NonNullable<RuntimeState['context']['pendingCompaction']>;
type ContextCompactionCheckpoint = NonNullable<RuntimeState['context']['activeCheckpoint']>;

/** App adapter from the fixed State 25 Host shape to the Builtin compaction effect. */
export type ContextCompactor = (input: {
  state: Readonly<RuntimeState>;
  pending: Readonly<PendingContextCompaction>;
  sourceRevision: number;
  projectionEnvironment?: ContextProjectionEnvironment;
}) => Promise<ContextCompactionCheckpoint>;

/**
 * Adapt the State 25 event surface to the Builtin-owned compaction effect.
 * Lease acquisition, persistence, and Kernel application stay in the App/Host coordinator.
 */
export async function executeContextCompaction(input: {
  state: Readonly<RuntimeState>;
  compactionId: string;
  compact?: ContextCompactor;
  projectionEnvironment?: ContextProjectionEnvironment;
  resolveProjectionEnvironment?: () => ContextProjectionEnvironment;
  onProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
  reporter?: CompactionReporter;
}): Promise<RuntimeEvent[]> {
  const stateCompactor = input.compact;
  const compact: BuiltinContextCompactorV1 | undefined = stateCompactor
    ? ({ pending, sourceRevision, projectionEnvironment }) =>
        stateCompactor({
          state: input.state,
          pending,
          sourceRevision,
          projectionEnvironment,
        })
    : undefined;
  const terminals = await executeBuiltinContextCompactionV1({
    state: input.state,
    compactionId: input.compactionId,
    compact,
    projectionEnvironment: input.projectionEnvironment,
    resolveProjectionEnvironment: input.resolveProjectionEnvironment,
    onProgress: input.onProgress,
    reporter: input.reporter,
  });
  return [...terminals];
}
