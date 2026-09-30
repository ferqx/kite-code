import { digestCapability } from './capability-domain';
import { collectRuntimeSecrets, inspectRuntimeSecret } from './secret-inspector';

export type McpArgumentInspection = 'clear' | 'secret' | 'unknown';
export type McpArgumentSnapshot =
  | { ok: true; arguments: Readonly<Record<string, unknown>> }
  | { ok: false };
const REMOTE_MCP_SECRET_FIELD =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|client[_-]?secret|credential|password|secret)$/i;

/** Redacted transport identity resolved from effective runtime configuration. */
export interface McpCapabilityRoute {
  transport: 'stdio' | 'http';
  serverIdentity: string;
  endpointRevision: string;
  toolRevision: string;
}

export function mcpArgumentDigest(argumentsValue: Record<string, unknown>): string {
  return digestCapability(argumentsValue);
}

/**
 * Capture one immutable JSON-safe argument value before any asynchronous
 * authorization work. Accessors, custom serialization and non-JSON values are
 * rejected so the signed digest and SDK payload cannot diverge.
 */
export function snapshotMcpArguments(argumentsValue: Record<string, unknown>): McpArgumentSnapshot {
  const seen = new Set<object>();
  const root: { value?: unknown } = {};
  const frozen: object[] = [];
  const pending: Array<{ value: unknown; assign: (captured: unknown) => void }> = [
    { value: argumentsValue, assign: (captured) => (root.value = captured) },
  ];
  try {
    while (pending.length > 0) {
      const { value, assign } = pending.pop()!;
      if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        assign(value);
        continue;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { ok: false };
        assign(value);
        continue;
      }
      if (typeof value !== 'object' || seen.has(value)) return { ok: false };
      seen.add(value);
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false };
        const keys = Reflect.ownKeys(value);
        if (
          keys.some((key) => typeof key !== 'string') ||
          keys.length !== value.length + 1 ||
          !keys.includes('length')
        )
          return { ok: false };
        const copy: unknown[] = new Array(value.length);
        assign(copy);
        frozen.push(copy);
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            return { ok: false };
          pending.push({ value: descriptor.value, assign: (captured) => (copy[index] = captured) });
        }
        continue;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return { ok: false };
      const copy = Object.create(null) as Record<string, unknown>;
      assign(copy);
      frozen.push(copy);
      for (const key of Reflect.ownKeys(value).reverse()) {
        if (typeof key !== 'string') return { ok: false };
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return { ok: false };
        pending.push({
          value: descriptor.value,
          assign: (captured) =>
            Object.defineProperty(copy, key, {
              value: captured,
              enumerable: true,
              writable: false,
              configurable: false,
            }),
        });
      }
    }
    for (const value of frozen) Object.freeze(value);
    return root.value && typeof root.value === 'object' && !Array.isArray(root.value)
      ? { ok: true, arguments: root.value as Readonly<Record<string, unknown>> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Inspect final structured arguments before a permit is requested and again
 * at the Manager boundary. Secret/protected-path signals are never representable
 * as a sendable permit classification; unsupported input is unknown and
 * therefore fails closed. Every field is inspected, regardless of size.
 */
export function inspectMcpArguments(
  argumentsValue: Record<string, unknown>,
  options: { knownSecrets?: Iterable<string | undefined> } = {},
): McpArgumentInspection {
  const seen = new Set<object>();
  const preparedSecrets = collectRuntimeSecrets(options.knownSecrets);
  const inspectText = (text: string, field?: string): McpArgumentInspection => {
    const inspected = field ? `${field}=${text}` : text;
    return inspectRuntimeSecret({
      text: inspected,
      preparedSecrets,
      maxInspectionChars: inspected.length,
    });
  };
  const pending: Array<{ value: unknown; field?: string }> = [{ value: argumentsValue }];
  while (pending.length > 0) {
    const { value, field } = pending.pop()!;
    if (field) {
      if (REMOTE_MCP_SECRET_FIELD.test(field) && value != null && value !== '') return 'secret';
    }
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      const verdict = inspectText(value, field);
      if (verdict !== 'clear') return verdict;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'unknown';
      continue;
    }
    if (typeof value !== 'object') return 'unknown';
    if (seen.has(value)) return 'unknown';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return 'unknown';
        const keys = Reflect.ownKeys(value);
        if (
          keys.some((key) => typeof key !== 'string') ||
          keys.length !== value.length + 1 ||
          !keys.includes('length')
        )
          return 'unknown';
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return 'unknown';
          pending.push({ value: descriptor.value });
        }
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return 'unknown';
        for (const key of Reflect.ownKeys(value).reverse()) {
          if (typeof key !== 'string') return 'unknown';
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return 'unknown';
          pending.push({ value: descriptor.value, field: key });
        }
      }
    } catch {
      return 'unknown';
    }
  }
  return 'clear';
}
