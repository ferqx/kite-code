import { assertCurrentRuntimeEventForWrite, type RuntimeEvent } from '@kite/agent-kernel';

/**
 * Host-facing State event admission boundary.
 *
 * App composition may receive JSON-safe Builtin event facts, but it must not
 * import the Kernel codec or claim that an arbitrary `{ type }` object is a
 * persisted event. This wrapper preserves the package direction while using
 * the one State codec authority.
 */
export function runtimeHostStateAssertCurrentRuntimeEvent(
  value: unknown,
): asserts value is RuntimeEvent {
  assertCurrentRuntimeEventForWrite(value);
}

/** Admit an untyped JSON value without intersecting its transport type with the event union. */
export function runtimeHostStateAdmitCurrentRuntimeEvent(value: unknown): RuntimeEvent {
  assertCurrentRuntimeEventForWrite(value);
  return value;
}
