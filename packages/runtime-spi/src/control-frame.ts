/** Strict invocation-local process control frame. Transport identity is provided by the OS pipe. */
export const RUNTIME_CONTROL_FRAME_SCHEMA_V1 = 'kite.runtime-control-frame.v1' as const;
export interface RuntimeControlFrameInputV1<T = unknown> {
  readonly schema: typeof RUNTIME_CONTROL_FRAME_SCHEMA_V1;
  readonly domain: string;
  readonly peerId: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly payload: T;
}
export type RuntimeControlFrameV1<T = unknown> = RuntimeControlFrameInputV1<T>;
export function isRuntimeControlFrameV1(value: unknown): value is RuntimeControlFrameV1<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame).sort();
  const expected = ['domain', 'invocationId', 'payload', 'peerId', 'schema', 'sequence'].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    frame.schema === RUNTIME_CONTROL_FRAME_SCHEMA_V1 &&
    typeof frame.domain === 'string' &&
    frame.domain.length > 0 &&
    typeof frame.peerId === 'string' &&
    frame.peerId.length > 0 &&
    typeof frame.invocationId === 'string' &&
    frame.invocationId.length > 0 &&
    typeof frame.sequence === 'number' &&
    Number.isSafeInteger(frame.sequence) &&
    frame.sequence >= 0 &&
    Object.hasOwn(frame, 'payload')
  );
}
export function canonicalControlFrameJsonV1(value: unknown): string {
  return JSON.stringify(sort(value));
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sort(v)]),
    );
  if (typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'function')
    throw new Error('Control-frame payload is not canonical JSON.');
  return value;
}
