import type { TrajectoryEvidenceRef, TrajectoryOutputPresence } from '@kite-ai/trajectory';
import { isToolCallModel } from '../../model-tools';
import type { Json } from '../types';
import { verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Same-transaction public shape only; never expand an Artifact or infer absent fields as empty. */
export function trajectoryOutputPresence(
  db: SqliteOperations,
  execution: Row,
  value: Json | undefined,
  complete: boolean,
  reference: TrajectoryEvidenceRef,
): TrajectoryOutputPresence | undefined {
  const output = object(value);
  if (!output || execution.kind !== 'model' || complete !== (execution.state === 'succeeded'))
    return;
  let hasText: boolean, toolCallCount: number;
  if (Object.hasOwn(output, 'modelOutput')) {
    try {
      const descriptor = verifyModelOutput(db, output.modelOutput, execution);
      if (descriptor.complete !== complete) return;
      // Preview text and inline calls may deliberately be empty for a large real output.
      hasText = descriptor.contentBytes !== '0';
      toolCallCount = descriptor.toolCallCount;
    } catch {
      return;
    }
  } else {
    if (typeof output.content !== 'string' || !Array.isArray(output.toolCalls)) return;
    if (
      !output.toolCalls.every((value) => {
        const call = object(value);
        return (
          call &&
          Object.keys(call).every((key) => ['id', 'name', 'arguments', 'model'].includes(key)) &&
          typeof call.id === 'string' &&
          call.id.length > 0 &&
          typeof call.name === 'string' &&
          call.name.length > 0 &&
          typeof call.arguments === 'string' &&
          (call.model === undefined || isToolCallModel(call.model))
        );
      })
    )
      return;
    // Conservatively retain whitespace: zero means no original text bytes at all.
    hasText = output.content.length > 0;
    toolCallCount = output.toolCalls.length;
  }
  return {
    hasText,
    toolCallCount,
    complete,
    evidenceId: reference.evidenceId,
    contentVersion: reference.contentVersion,
  };
}
