import { assertCurrentRuntimeEvent, type RuntimeEvent } from '@kite/agent-kernel';

/**
 * Host-facing State26 event admission boundary.
 *
 * App composition may receive JSON-safe Builtin event facts, but it must not
 * import the Kernel codec or claim that an arbitrary `{ type }` object is a
 * persisted event. This wrapper preserves the package direction while using
 * the one State26 codec authority.
 */
export function runtimeHostState26AssertCurrentRuntimeEventV1(
  value: unknown,
): asserts value is RuntimeEvent {
  assertCurrentRuntimeEvent(value);
}

/** Admit an untyped JSON value without intersecting its transport type with the event union. */
export function runtimeHostState26AdmitCurrentRuntimeEventV1(value: unknown): RuntimeEvent {
  assertCurrentRuntimeEvent(value);
  return value;
}
