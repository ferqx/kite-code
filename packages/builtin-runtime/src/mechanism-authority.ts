import type { CapabilityExecutionMechanismV1 } from '@kite/runtime-spi';

/**
 * The mechanism map is an invocation authority, not an open-ended bag of
 * convenience dependencies.  A prepared map may contribute the operation's
 * Builtin-owned port and the runner may contribute the one generic port that
 * it constructed for the same operation.  They must never contribute the
 * same key: a right-biased object spread would otherwise silently replace an
 * already-admitted provider.
 */
export type BuiltinMechanismRecordV1 = Readonly<Record<string, unknown>>;

export interface MergeBuiltinMechanismBundleInputV1 {
  readonly executionMechanism: CapabilityExecutionMechanismV1;
  readonly prepared?: BuiltinMechanismRecordV1;
  readonly runner?: BuiltinMechanismRecordV1;
}

export class BuiltinMechanismAuthorityErrorV1 extends Error {
  readonly code = 'builtin_mechanism_authority_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'BuiltinMechanismAuthorityErrorV1';
  }
}

const REQUIRED_MECHANISM_KEYS_V1: Readonly<
  Partial<Record<CapabilityExecutionMechanismV1, string>>
> = Object.freeze({
  filesystem: 'filesystem',
  git: 'git',
  shell: 'shell',
  web: 'web',
  mcp: 'mcp',
  skill: 'skill',
  planning: 'planning',
  subagent: 'subagent',
  verification: 'verification',
  model: 'model',
});

const EMPTY_MECHANISM_RECORD_V1 = Object.freeze({});

/**
 * Validate and merge the only mechanism bundle accepted by Runtime Host
 * execution.  The returned object is always a fresh frozen map.  Nested
 * mechanism wrappers are validated as frozen objects, while the MCP runtime
 * reference itself intentionally remains mutable internal provider state.
 */
export function mergeBuiltinMechanismBundleV1(
  input: MergeBuiltinMechanismBundleInputV1,
): BuiltinMechanismRecordV1 {
  const prepared = normalizeMechanismRecordV1(input.prepared, 'prepared');
  const runner = normalizeMechanismRecordV1(input.runner, 'runner');
  const preparedKeys = ownKeysV1(prepared, 'prepared mechanism map');
  const runnerKeys = ownKeysV1(runner, 'runner mechanism map');
  const duplicate = preparedKeys.find((key) => runnerKeys.includes(key));
  if (duplicate) {
    throw new BuiltinMechanismAuthorityErrorV1(
      `Builtin mechanism '${duplicate}' was supplied by both prepared and runner authority.`,
    );
  }

  const keys = [...preparedKeys, ...runnerKeys].sort();
  const requiredKey = REQUIRED_MECHANISM_KEYS_V1[input.executionMechanism];
  if (requiredKey !== undefined) {
    if (keys.length !== 1 || keys[0] !== requiredKey) {
      throw new BuiltinMechanismAuthorityErrorV1(
        `Builtin execution mechanism '${input.executionMechanism}' requires only '${requiredKey}'.`,
      );
    }
    assertMechanismWrapperV1(requiredKey, prepared[requiredKey] ?? runner[requiredKey]);
  } else if (keys.length !== 0) {
    throw new BuiltinMechanismAuthorityErrorV1(
      `Builtin execution mechanism '${input.executionMechanism}' does not accept mechanism ports.`,
    );
  }

  return Object.freeze({ ...prepared, ...runner });
}

function normalizeMechanismRecordV1(
  value: BuiltinMechanismRecordV1 | undefined,
  owner: 'prepared' | 'runner',
): BuiltinMechanismRecordV1 {
  if (value === undefined) return EMPTY_MECHANISM_RECORD_V1;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  ) {
    throw new BuiltinMechanismAuthorityErrorV1(
      `Builtin ${owner} mechanism map must be a frozen object.`,
    );
  }
  return value;
}

function assertMechanismWrapperV1(key: string, value: unknown): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  ) {
    throw new BuiltinMechanismAuthorityErrorV1(
      `Builtin mechanism '${key}' wrapper must be a frozen object.`,
    );
  }
  const record = value as Readonly<Record<string, unknown>>;

  switch (key) {
    case 'mcp':
      assertExactKeysV1(value, ['invocation', 'runtime']);
      assertMcpRuntimeV1(record.runtime, key);
      if (record.invocation !== undefined) {
        assertFrozenRecordV1(record.invocation, `${key}.invocation`);
        if (
          typeof (record.invocation as Record<string, unknown>).capabilityId !== 'string' ||
          typeof (record.invocation as Record<string, unknown>).expectedRevision !== 'string'
        ) {
          throw new BuiltinMechanismAuthorityErrorV1(
            `Builtin mechanism '${key}' invocation identity is invalid.`,
          );
        }
      }
      return;
    case 'web':
      assertExactKeysV1(value, ['fetch', 'networkBoundary', 'unavailable']);
      if (record.fetch !== undefined && typeof record.fetch !== 'function') {
        throw new BuiltinMechanismAuthorityErrorV1(
          `Builtin mechanism '${key}' fetch port is invalid.`,
        );
      }
      if (record.unavailable !== undefined) {
        assertFrozenRecordV1(record.unavailable, `${key}.unavailable`);
        const unavailable = record.unavailable as Record<string, unknown>;
        if (typeof unavailable.code !== 'string' || typeof unavailable.message !== 'string') {
          throw new BuiltinMechanismAuthorityErrorV1(
            `Builtin mechanism '${key}' unavailable fact is invalid.`,
          );
        }
      }
      if ((record.fetch === undefined) === (record.unavailable === undefined)) {
        throw new BuiltinMechanismAuthorityErrorV1(
          `Builtin mechanism '${key}' requires exactly one fetch or unavailable port.`,
        );
      }
      if (record.networkBoundary !== undefined) {
        assertFrozenRecordV1(record.networkBoundary, `${key}.networkBoundary`);
      }
      return;
    case 'skill':
      assertExactKeysV1(value, ['catalog', 'flags', 'runFork', 'state', 'verificationEnabled']);
      assertFrozenRecordV1(record.state, `${key}.state`);
      if (typeof record.verificationEnabled !== 'boolean') {
        throw new BuiltinMechanismAuthorityErrorV1(
          `Builtin mechanism '${key}' verification flag is invalid.`,
        );
      }
      if (record.runFork !== undefined && typeof record.runFork !== 'function') {
        throw new BuiltinMechanismAuthorityErrorV1(
          `Builtin mechanism '${key}' fork port is invalid.`,
        );
      }
      return;
    case 'filesystem':
      assertExactKeysV1(value, ['allowExternalPaths', 'dispatch']);
      assertBooleanV1(record, 'allowExternalPaths', key);
      assertFunctionV1(record, 'dispatch', key);
      return;
    case 'git':
      assertExactKeysV1(value, ['inspect']);
      assertFunctionV1(record, 'inspect', key);
      return;
    case 'shell':
      assertExactKeysV1(value, ['execute']);
      assertFunctionV1(record, 'execute', key);
      return;
    case 'planning':
      assertExactKeysV1(value, ['read', 'update', 'write']);
      assertFunctionV1(record, 'read', key);
      assertFunctionV1(record, 'update', key);
      assertFunctionV1(record, 'write', key);
      return;
    case 'subagent':
      assertExactKeysV1(value, ['executeTask', 'phase']);
      if (record.phase !== 'planning' && record.phase !== 'building') {
        throw new BuiltinMechanismAuthorityErrorV1(`Builtin mechanism '${key}' phase is invalid.`);
      }
      assertFunctionV1(record, 'executeTask', key);
      return;
    case 'verification':
      assertExactKeysV1(value, ['execute']);
      assertFunctionV1(record, 'execute', key);
      return;
    case 'model':
      assertExactKeysV1(value, ['execute']);
      assertFunctionV1(record, 'execute', key);
      return;
    default:
      throw new BuiltinMechanismAuthorityErrorV1(`Unknown Builtin mechanism wrapper: ${key}.`);
  }
}

function assertMcpRuntimeV1(value: unknown, key: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuiltinMechanismAuthorityErrorV1(`Builtin mechanism '${key}' runtime is invalid.`);
  }
  for (const method of [
    'getCapabilitySnapshot',
    'getProviderDirectorySnapshot',
    'getResourceDirectorySnapshot',
    'findCapability',
    'callCapability',
    'readResource',
  ]) {
    if (typeof (value as Record<string, unknown>)[method] !== 'function') {
      throw new BuiltinMechanismAuthorityErrorV1(
        `Builtin mechanism '${key}' runtime is missing '${method}'.`,
      );
    }
  }
}

function assertExactKeysV1(value: object, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const keys = ownKeysV1(value, 'Builtin mechanism wrapper').sort();
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new BuiltinMechanismAuthorityErrorV1(
      `Builtin mechanism wrapper has an unexpected key: ${keys.join(', ')}.`,
    );
  }
}

function ownKeysV1(value: object, label: string): string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new BuiltinMechanismAuthorityErrorV1(`${label} must not contain symbol keys.`);
  }
  const stringKeys = keys as string[];
  if (stringKeys.some((key) => !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new BuiltinMechanismAuthorityErrorV1(`${label} must contain only enumerable keys.`);
  }
  return stringKeys;
}

function assertFrozenRecordV1(
  value: unknown,
  label: string,
): asserts value is BuiltinMechanismRecordV1 {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  ) {
    throw new BuiltinMechanismAuthorityErrorV1(`${label} must be a frozen object.`);
  }
}

function assertFunctionV1(value: object, key: string, mechanism: string): void {
  if (typeof (value as Record<string, unknown>)[key] !== 'function') {
    throw new BuiltinMechanismAuthorityErrorV1(
      `Builtin mechanism '${mechanism}' port '${key}' is invalid.`,
    );
  }
}

function assertBooleanV1(value: object, key: string, mechanism: string): void {
  if (typeof (value as Record<string, unknown>)[key] !== 'boolean') {
    throw new BuiltinMechanismAuthorityErrorV1(
      `Builtin mechanism '${mechanism}' field '${key}' is invalid.`,
    );
  }
}
