import {
  type RuntimeJsonValue,
  TOOL_PIPELINE_STAGE_SCHEMA_,
  type ToolArgumentOrigin,
  type ToolCallSnapshotResult,
} from '@kite-ai/runtime-spi';

const MAX_IDENTITY_LENGTH_ = 256;
const SNAPSHOT_KEYS_ = Object.freeze([
  'toolCallId',
  'name',
  'rawArguments',
  'argumentOrigin',
  'createdAtTurnId',
  'modelMessageId',
  'bindingId',
  'capabilityId',
  'capabilityRevision',
] as const);

export interface RuntimeHostToolCallSnapshotInput {
  readonly toolCallId: string;
  readonly name: string;
  readonly rawArguments: unknown;
  readonly argumentOrigin: ToolArgumentOrigin;
  readonly createdAtTurnId: string;
  readonly modelMessageId: string;
  readonly bindingId: string | null;
  readonly capabilityId: string | null;
  readonly capabilityRevision: string | null;
}

/**
 * Capture an untrusted proposal as the immutable SPI snapshot stage.
 *
 * This Host seam owns only bounded identity and JSON transport hygiene. It
 * does not parse a capability schema, classify effects, resolve a binding, or
 * select an executor.
 */
export function createRuntimeHostToolCallSnapshot(
  input: Readonly<RuntimeHostToolCallSnapshotInput>,
): ToolCallSnapshotResult {
  try {
    if (!validSnapshotInputShape(input)) {
      return snapshotFailure(input, 'invalid_identity');
    }

    const rawArguments = cloneCanonicalJson(input.rawArguments);
    const snapshot = Object.freeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_,
      stage: 'snapshot' as const,
      toolCallId: input.toolCallId,
      name: input.name,
      rawArguments,
      argumentOrigin: input.argumentOrigin,
      createdAtTurnId: input.createdAtTurnId,
      modelMessageId: input.modelMessageId,
      bindingId: input.bindingId,
      capabilityId: input.capabilityId,
      capabilityRevision: input.capabilityRevision,
    });
    return Object.freeze({ ok: true as const, value: snapshot });
  } catch {
    return snapshotFailure(input, 'arguments_not_canonical_json');
  }
}

function validSnapshotInputShape(input: unknown): input is RuntimeHostToolCallSnapshotInput {
  if (!plainRecord(input) || !exactKeys(input, SNAPSHOT_KEYS_)) return false;
  return (
    boundedIdentity(input.toolCallId) &&
    boundedIdentity(input.name) &&
    (input.argumentOrigin === 'model_public' || input.argumentOrigin === 'runtime_private') &&
    boundedIdentity(input.createdAtTurnId) &&
    boundedIdentity(input.modelMessageId) &&
    nullableIdentity(input.bindingId) &&
    nullableIdentity(input.capabilityId) &&
    nullableIdentity(input.capabilityRevision)
  );
}

function snapshotFailure(
  input: unknown,
  code: 'invalid_identity' | 'arguments_not_canonical_json',
): ToolCallSnapshotResult {
  const toolCallId = safeBoundedIdentity(readDataProperty(input, 'toolCallId'));
  const toolName = safeBoundedIdentity(readDataProperty(input, 'name'));
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      stage: 'snapshot' as const,
      code,
      toolCallId,
      toolName,
      diagnostic:
        code === 'invalid_identity'
          ? 'Tool call snapshot identity is invalid.'
          : 'Tool call arguments are not canonical JSON.',
    }),
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    });
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && expected.has(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function readDataProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH_;
}

function safeBoundedIdentity(value: unknown): string | null {
  return boundedIdentity(value) ? value : null;
}

function nullableIdentity(value: unknown): value is string | null {
  return value === null || boundedIdentity(value);
}

function cloneCanonicalJson(value: unknown): RuntimeJsonValue {
  return cloneCanonicalJsonValue(value, new WeakSet<object>(), new WeakMap<object, object>());
}

function cloneCanonicalJsonValue(
  value: unknown,
  active: WeakSet<object>,
  clones: WeakMap<object, object>,
): RuntimeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('unsupported JSON value');
  if (active.has(value)) throw new TypeError('cyclic JSON value');
  const existing = clones.get(value);
  if (existing !== undefined) return existing as RuntimeJsonValue;

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError('unreadable JSON value');
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError('invalid array prototype');
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        !lengthDescriptor ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw new TypeError('invalid array length');
      }
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1) throw new TypeError('sparse or extended array');
      const clone: RuntimeJsonValue[] = new Array(length);
      clones.set(value, clone);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !descriptor ||
          !('value' in descriptor) ||
          !descriptor.enumerable ||
          Object.getOwnPropertySymbols(value).length > 0
        ) {
          throw new TypeError('invalid array property');
        }
        clone[index] = cloneCanonicalJsonValue(descriptor.value, active, clones);
      }
      for (const key of keys) {
        if (
          typeof key !== 'string' ||
          (key !== 'length' && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length))
        ) {
          throw new TypeError('extended array property');
        }
      }
      return Object.freeze(clone);
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('invalid object prototype');
    }
    const clone = Object.create(prototype) as Record<string, RuntimeJsonValue>;
    clones.set(value, clone);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('symbol JSON property');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('accessor or hidden JSON property');
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneCanonicalJsonValue(descriptor.value, active, clones),
        writable: true,
      });
    }
    return Object.freeze(clone) as RuntimeJsonValue;
  } finally {
    active.delete(value);
  }
}
