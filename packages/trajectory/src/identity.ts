import { type Decimal64, decimal64Schema } from './cursor';

export const TRAJECTORY_EVENT_ID_DOMAIN = 'kite.trajectory.event@1';
export const TRAJECTORY_LEGACY_ID_DOMAIN = 'kite.trajectory.legacy-local@1';
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };
/** Stable UTF-8 JSON input. Reject values that JSON would silently omit or change. */
export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalSerialize).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSerialize((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  throw new TypeError('invalid_canonical_json');
}
export interface TrajectoryOrigin {
  storeId: string;
  cursor: Decimal64;
}
/** The caller may hash these bytes synchronously at a storage commit boundary. */
export function trajectoryIdentityPayload(
  origin: TrajectoryOrigin,
  legacyNamespace?: string,
): string {
  decimal64Schema.parse(origin.cursor);
  if (typeof origin.storeId !== 'string' || !origin.storeId.length)
    throw new TypeError('invalid_origin');
  if (legacyNamespace !== undefined && !legacyNamespace.length)
    throw new TypeError('invalid_legacy_namespace');
  return canonicalSerialize(
    legacyNamespace === undefined
      ? [TRAJECTORY_EVENT_ID_DOMAIN, origin.storeId, origin.cursor]
      : [TRAJECTORY_LEGACY_ID_DOMAIN, legacyNamespace, origin.storeId, origin.cursor],
  );
}
export async function createTrajectoryEventId(
  origin: TrajectoryOrigin,
  legacyNamespace?: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(trajectoryIdentityPayload(origin, legacyNamespace));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `te_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
