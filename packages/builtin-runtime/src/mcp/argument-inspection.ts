import { digestCapability } from './capability-domain';
import { inspectRuntimeSecretV1 } from './secret-inspector';

export type McpArgumentInspectionV1 = 'clear' | 'secret' | 'unknown';
export type McpArgumentSnapshotV1 =
  | { ok: true; arguments: Readonly<Record<string, unknown>> }
  | { ok: false };
const REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS = 1_000_000;
const REMOTE_MCP_ARGUMENT_INSPECTION_MAX_DEPTH = 32;
const REMOTE_MCP_ARGUMENT_INSPECTION_MAX_NODES = 4_096;
const REMOTE_MCP_SECRET_FIELD =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|client[_-]?secret|credential|password|secret)$/i;

/** Redacted transport identity resolved from effective runtime configuration. */
export interface McpCapabilityRouteV1 {
  transport: 'stdio' | 'http';
  serverIdentity: string;
  endpointRevision: string;
  toolRevision: string;
}

export function mcpArgumentDigestV1(argumentsValue: Record<string, unknown>): string {
  return digestCapability(argumentsValue);
}

/**
 * Capture one immutable JSON-safe argument value before any asynchronous
 * authorization work. Accessors, custom serialization and non-JSON values are
 * rejected so the signed digest and SDK payload cannot diverge.
 */
export function snapshotMcpArgumentsV1(
  argumentsValue: Record<string, unknown>,
): McpArgumentSnapshotV1 {
  const seen = new Set<object>();
  let capturedChars = 0;
  let capturedNodes = 0;

  const capture = (value: unknown, depth: number): { ok: true; value: unknown } | { ok: false } => {
    capturedNodes += 1;
    if (
      capturedNodes > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_NODES ||
      depth > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_DEPTH
    ) {
      return { ok: false };
    }
    if (value === null || typeof value === 'boolean') return { ok: true, value };
    if (typeof value === 'string') {
      capturedChars += value.length;
      return capturedChars <= REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS
        ? { ok: true, value }
        : { ok: false };
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    if (typeof value !== 'object' || seen.has(value)) return { ok: false };
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false };
        const keys = Reflect.ownKeys(value);
        if (
          keys.some((key) => typeof key !== 'string') ||
          keys.length !== value.length + 1 ||
          !keys.includes('length')
        ) {
          return { ok: false };
        }
        const copy: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            return { ok: false };
          }
          const captured = capture(descriptor.value, depth + 1);
          if (!captured.ok) return captured;
          copy.push(captured.value);
        }
        return { ok: true, value: Object.freeze(copy) };
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return { ok: false };
      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return { ok: false };
        capturedChars += key.length;
        if (capturedChars > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS) return { ok: false };
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          return { ok: false };
        }
        const captured = capture(descriptor.value, depth + 1);
        if (!captured.ok) return captured;
        Object.defineProperty(copy, key, {
          value: captured.value,
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      return { ok: true, value: Object.freeze(copy) };
    } catch {
      return { ok: false };
    }
  };

  const captured = capture(argumentsValue, 0);
  return captured.ok &&
    captured.value &&
    typeof captured.value === 'object' &&
    !Array.isArray(captured.value)
    ? { ok: true, arguments: captured.value as Readonly<Record<string, unknown>> }
    : { ok: false };
}

/**
 * Inspect final structured arguments before a permit is requested and again
 * at the Manager boundary. Secret/protected-path signals are never representable
 * as a sendable permit classification; unsupported or over-budget input is
 * unknown and therefore fail closed.
 */
export function inspectMcpArgumentsV1(
  argumentsValue: Record<string, unknown>,
  options: { knownSecrets?: Iterable<string | undefined> } = {},
): McpArgumentInspectionV1 {
  const seen = new Set<object>();
  let inspectedChars = 0;
  let inspectedNodes = 0;

  const inspectText = (text: string, field?: string): McpArgumentInspectionV1 => {
    inspectedChars += text.length;
    if (inspectedChars > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS) return 'unknown';
    return inspectRuntimeSecretV1({
      text: field ? `${field}=${text}` : text,
      knownSecrets: options.knownSecrets,
      maxInspectionChars: REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS,
    });
  };

  const visit = (
    value: unknown,
    field: string | undefined,
    depth: number,
  ): McpArgumentInspectionV1 => {
    inspectedNodes += 1;
    if (
      inspectedNodes > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_NODES ||
      depth > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_DEPTH
    ) {
      return 'unknown';
    }
    if (field) {
      inspectedChars += field.length;
      if (inspectedChars > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS) return 'unknown';
      if (REMOTE_MCP_SECRET_FIELD.test(field) && value != null && value !== '') return 'secret';
    }
    if (value === null) return 'clear';
    if (typeof value === 'string') return inspectText(value, field);
    if (typeof value === 'boolean') return 'clear';
    if (typeof value === 'number') return Number.isFinite(value) ? 'clear' : 'unknown';
    if (typeof value !== 'object') return 'unknown';
    if (seen.has(value)) return 'unknown';
    seen.add(value);

    let values: Array<[string | undefined, unknown]>;
    try {
      if (Array.isArray(value)) {
        values = value.map((entry) => [undefined, entry]);
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return 'unknown';
        values = Object.entries(value);
      }
    } catch {
      return 'unknown';
    }
    for (const [nestedField, nestedValue] of values) {
      const verdict = visit(nestedValue, nestedField, depth + 1);
      if (verdict !== 'clear') return verdict;
    }
    return 'clear';
  };

  return visit(argumentsValue, undefined, 0);
}
