import {
  assertCurrentRuntimeEventForWrite,
  CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS,
  type RuntimeEvent,
} from '@kite-ai/agent-kernel';

const CURRENT_STATE_EVENT_TYPES_ = Object.freeze(
  Object.keys(CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS),
);

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

/**
 * Host-owned closed State event vocabulary for decoded-log admission.
 *
 * App composition may pass this vocabulary to a storage adapter without
 * importing the Kernel's concrete event codec or becoming a second codec
 * authority.
 */
export function runtimeHostCurrentStateEventTypes(): readonly string[] {
  return CURRENT_STATE_EVENT_TYPES_;
}
