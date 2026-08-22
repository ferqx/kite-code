import {
  type RuntimeJsonValueV1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
  type ToolArgumentOriginV1,
  type ToolCallSnapshotResultV1,
} from '@kite/runtime-spi';

const MAX_IDENTITY_LENGTH_V1 = 256;
const SNAPSHOT_KEYS_V1 = Object.freeze([
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

export interface RuntimeHostToolCallSnapshotInputV1 {
  readonly toolCallId: string;
  readonly name: string;
  readonly rawArguments: unknown;
  readonly argumentOrigin: ToolArgumentOriginV1;
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
export function createRuntimeHostToolCallSnapshotV1(
  input: Readonly<RuntimeHostToolCallSnapshotInputV1>,
): ToolCallSnapshotResultV1 {
  try {
    if (!validSnapshotInputShapeV1(input)) {
      return snapshotFailureV1(input, 'invalid_identity');
    }

    const rawArguments = cloneCanonicalJsonV1(input.rawArguments);
    const snapshot = Object.freeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
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
    return snapshotFailureV1(input, 'arguments_not_canonical_json');
  }
}

function validSnapshotInputShapeV1(input: unknown): input is RuntimeHostToolCallSnapshotInputV1 {
  if (!plainRecordV1(input) || !exactKeysV1(input, SNAPSHOT_KEYS_V1)) return false;
  return (
    boundedIdentityV1(input.toolCallId) &&
    boundedIdentityV1(input.name) &&
    (input.argumentOrigin === 'model_public' || input.argumentOrigin === 'runtime_private') &&
    boundedIdentityV1(input.createdAtTurnId) &&
    boundedIdentityV1(input.modelMessageId) &&
    nullableIdentityV1(input.bindingId) &&
    nullableIdentityV1(input.capabilityId) &&
    nullableIdentityV1(input.capabilityRevision)
  );
}

function snapshotFailureV1(
  input: unknown,
  code: 'invalid_identity' | 'arguments_not_canonical_json',
): ToolCallSnapshotResultV1 {
  const toolCallId = safeBoundedIdentityV1(readDataPropertyV1(input, 'toolCallId'));
  const toolName = safeBoundedIdentityV1(readDataPropertyV1(input, 'name'));
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

function plainRecordV1(value: unknown): value is Record<string, unknown> {
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

function exactKeysV1(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && expected.has(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function readDataPropertyV1(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedIdentityV1(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH_V1;
}

function safeBoundedIdentityV1(value: unknown): string | null {
  return boundedIdentityV1(value) ? value : null;
}

function nullableIdentityV1(value: unknown): value is string | null {
  return value === null || boundedIdentityV1(value);
}

function cloneCanonicalJsonV1(value: unknown): RuntimeJsonValueV1 {
  return cloneCanonicalJsonValueV1(value, new WeakSet<object>(), new WeakMap<object, object>());
}

function cloneCanonicalJsonValueV1(
  value: unknown,
  active: WeakSet<object>,
  clones: WeakMap<object, object>,
): RuntimeJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('unsupported JSON value');
  if (active.has(value)) throw new TypeError('cyclic JSON value');
  const existing = clones.get(value);
  if (existing !== undefined) return existing as RuntimeJsonValueV1;

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
      const clone: RuntimeJsonValueV1[] = new Array(length);
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
        clone[index] = cloneCanonicalJsonValueV1(descriptor.value, active, clones);
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
    const clone = Object.create(prototype) as Record<string, RuntimeJsonValueV1>;
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
        value: cloneCanonicalJsonValueV1(descriptor.value, active, clones),
        writable: true,
      });
    }
    return Object.freeze(clone) as RuntimeJsonValueV1;
  } finally {
    active.delete(value);
  }
}
