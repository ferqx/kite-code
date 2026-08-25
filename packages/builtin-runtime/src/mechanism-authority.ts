import type { CapabilityExecutionMechanism } from '@kite-ai/runtime-spi';

/**
 * The mechanism map is an invocation authority, not an open-ended bag of
 * convenience dependencies.  A prepared map may contribute the operation's
 * Builtin-owned port and the runner may contribute the one generic port that
 * it constructed for the same operation.  They must never contribute the
 * same key: a right-biased object spread would otherwise silently replace an
 * already-admitted provider.
 */
export type BuiltinMechanismRecord = Readonly<Record<string, unknown>>;

export interface MergeBuiltinMechanismBundleInput {
  readonly executionMechanism: CapabilityExecutionMechanism;
  readonly prepared?: BuiltinMechanismRecord;
  readonly runner?: BuiltinMechanismRecord;
}

export class BuiltinMechanismAuthorityError extends Error {
  readonly code = 'builtin_mechanism_authority_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'BuiltinMechanismAuthorityError';
  }
}

const REQUIRED_MECHANISM_KEYS_: Readonly<Partial<Record<CapabilityExecutionMechanism, string>>> =
  Object.freeze({
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

const EMPTY_MECHANISM_RECORD_ = Object.freeze({});

/**
 * Validate and merge the only mechanism bundle accepted by Runtime Host
 * execution.  The returned object is always a fresh frozen map.  Nested
 * mechanism wrappers are validated as frozen objects, while the MCP runtime
 * reference itself intentionally remains mutable internal provider state.
 */
export function mergeBuiltinMechanismBundle(
  input: MergeBuiltinMechanismBundleInput,
): BuiltinMechanismRecord {
  const prepared = normalizeMechanismRecord(input.prepared, 'prepared');
  const runner = normalizeMechanismRecord(input.runner, 'runner');
  const preparedKeys = ownKeys(prepared, 'prepared mechanism map');
  const runnerKeys = ownKeys(runner, 'runner mechanism map');
  const duplicate = preparedKeys.find((key) => runnerKeys.includes(key));
  if (duplicate) {
    throw new BuiltinMechanismAuthorityError(
      `Builtin mechanism '${duplicate}' was supplied by both prepared and runner authority.`,
    );
  }

  const keys = [...preparedKeys, ...runnerKeys].sort();
  const requiredKey = REQUIRED_MECHANISM_KEYS_[input.executionMechanism];
  if (requiredKey !== undefined) {
    if (keys.length !== 1 || keys[0] !== requiredKey) {
      throw new BuiltinMechanismAuthorityError(
        `Builtin execution mechanism '${input.executionMechanism}' requires only '${requiredKey}'.`,
      );
    }
    assertMechanismWrapper(requiredKey, prepared[requiredKey] ?? runner[requiredKey]);
  } else if (keys.length !== 0) {
    throw new BuiltinMechanismAuthorityError(
      `Builtin execution mechanism '${input.executionMechanism}' does not accept mechanism ports.`,
    );
  }

  return Object.freeze({ ...prepared, ...runner });
}

function normalizeMechanismRecord(
  value: BuiltinMechanismRecord | undefined,
  owner: 'prepared' | 'runner',
): BuiltinMechanismRecord {
  if (value === undefined) return EMPTY_MECHANISM_RECORD_;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  ) {
    throw new BuiltinMechanismAuthorityError(
      `Builtin ${owner} mechanism map must be a frozen object.`,
    );
  }
  return value;
}

function assertMechanismWrapper(key: string, value: unknown): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  ) {
    throw new BuiltinMechanismAuthorityError(
      `Builtin mechanism '${key}' wrapper must be a frozen object.`,
    );
  }
  const record = value as Readonly<Record<string, unknown>>;

  switch (key) {
    case 'mcp':
      assertExactKeys(value, ['invocation', 'runtime']);
      assertMcpRuntime(record.runtime, key);
      if (record.invocation !== undefined) {
        assertFrozenRecord(record.invocation, `${key}.invocation`);
        if (
          typeof (record.invocation as Record<string, unknown>).capabilityId !== 'string' ||
          typeof (record.invocation as Record<string, unknown>).expectedRevision !== 'string'
        ) {
          throw new BuiltinMechanismAuthorityError(
            `Builtin mechanism '${key}' invocation identity is invalid.`,
          );
        }
      }
      return;
    case 'web':
      assertExactKeys(value, ['fetch', 'networkBoundary', 'unavailable']);
      if (record.fetch !== undefined && typeof record.fetch !== 'function') {
        throw new BuiltinMechanismAuthorityError(
          `Builtin mechanism '${key}' fetch port is invalid.`,
        );
      }
      if (record.unavailable !== undefined) {
        assertFrozenRecord(record.unavailable, `${key}.unavailable`);
        const unavailable = record.unavailable as Record<string, unknown>;
        if (typeof unavailable.code !== 'string' || typeof unavailable.message !== 'string') {
          throw new BuiltinMechanismAuthorityError(
            `Builtin mechanism '${key}' unavailable fact is invalid.`,
          );
        }
      }
      if ((record.fetch === undefined) === (record.unavailable === undefined)) {
        throw new BuiltinMechanismAuthorityError(
          `Builtin mechanism '${key}' requires exactly one fetch or unavailable port.`,
        );
      }
      if (record.networkBoundary !== undefined) {
        assertFrozenRecord(record.networkBoundary, `${key}.networkBoundary`);
      }
      return;
    case 'skill':
      assertExactKeys(value, ['catalog', 'flags', 'runFork', 'state', 'verificationEnabled']);
      assertFrozenRecord(record.state, `${key}.state`);
      if (typeof record.verificationEnabled !== 'boolean') {
        throw new BuiltinMechanismAuthorityError(
          `Builtin mechanism '${key}' verification flag is invalid.`,
        );
      }
      if (record.runFork !== undefined && typeof record.runFork !== 'function') {
        throw new BuiltinMechanismAuthorityError(
          `Builtin mechanism '${key}' fork port is invalid.`,
        );
      }
      return;
    case 'filesystem':
      assertExactKeys(value, ['allowExternalPaths', 'dispatch']);
      assertBoolean(record, 'allowExternalPaths', key);
      assertFunction(record, 'dispatch', key);
      return;
    case 'git':
      assertExactKeys(value, ['inspect']);
      assertFunction(record, 'inspect', key);
      return;
    case 'shell':
      assertExactKeys(value, ['execute']);
      assertFunction(record, 'execute', key);
      return;
    case 'planning':
      assertExactKeys(value, ['read', 'update', 'write']);
      assertFunction(record, 'read', key);
      assertFunction(record, 'update', key);
      assertFunction(record, 'write', key);
      return;
    case 'subagent':
      assertExactKeys(value, ['executeTask', 'phase']);
      if (record.phase !== 'planning' && record.phase !== 'building') {
        throw new BuiltinMechanismAuthorityError(`Builtin mechanism '${key}' phase is invalid.`);
      }
      assertFunction(record, 'executeTask', key);
      return;
    case 'verification':
      assertExactKeys(value, ['execute']);
      assertFunction(record, 'execute', key);
      return;
    case 'model':
      assertExactKeys(value, ['execute']);
      assertFunction(record, 'execute', key);
      return;
    default:
      throw new BuiltinMechanismAuthorityError(`Unknown Builtin mechanism wrapper: ${key}.`);
  }
}

function assertMcpRuntime(value: unknown, key: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuiltinMechanismAuthorityError(`Builtin mechanism '${key}' runtime is invalid.`);
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
      throw new BuiltinMechanismAuthorityError(
        `Builtin mechanism '${key}' runtime is missing '${method}'.`,
      );
    }
  }
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const keys = ownKeys(value, 'Builtin mechanism wrapper').sort();
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new BuiltinMechanismAuthorityError(
      `Builtin mechanism wrapper has an unexpected key: ${keys.join(', ')}.`,
    );
  }
}

function ownKeys(value: object, label: string): string[] {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new BuiltinMechanismAuthorityError(`${label} must not contain symbol keys.`);
  }
  const stringKeys = keys as string[];
  if (stringKeys.some((key) => !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new BuiltinMechanismAuthorityError(`${label} must contain only enumerable keys.`);
  }
  return stringKeys;
}

function assertFrozenRecord(
  value: unknown,
  label: string,
): asserts value is BuiltinMechanismRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  ) {
    throw new BuiltinMechanismAuthorityError(`${label} must be a frozen object.`);
  }
}

function assertFunction(value: object, key: string, mechanism: string): void {
  if (typeof (value as Record<string, unknown>)[key] !== 'function') {
    throw new BuiltinMechanismAuthorityError(
      `Builtin mechanism '${mechanism}' port '${key}' is invalid.`,
    );
  }
}

function assertBoolean(value: object, key: string, mechanism: string): void {
  if (typeof (value as Record<string, unknown>)[key] !== 'boolean') {
    throw new BuiltinMechanismAuthorityError(
      `Builtin mechanism '${mechanism}' field '${key}' is invalid.`,
    );
  }
}
