import { canonicalJson, sha256DomainSeparated } from './canonical-json';

export const BEHAVIOR_DIGEST_SCHEMA_VERSION = 1 as const;
export const BEHAVIOR_DIGEST_CANONICALIZER = 'RFC8785' as const;

export const BEHAVIOR_COMPONENT_NAMES = [
  'agentSystemContract',
  'askUserContract',
  'compactionPolicy',
  'toolRegistry',
  'runtimeSchedulingPolicy',
  'skillsContracts',
  'defaultConfiguration',
  'providerRoute',
  'releaseProfile',
  'gatePolicy',
  'buildRecipe',
  'lockfile',
] as const;

export type BehaviorComponentName = (typeof BEHAVIOR_COMPONENT_NAMES)[number];
export type BehaviorDigestInputClass = 'production_resolved' | 'synthetic_non_production';
export type BehaviorSha256Digest = `sha256:${string}`;

export const BEHAVIOR_COMPONENT_INPUT_IDENTITIES: Readonly<Record<BehaviorComponentName, string>> =
  Object.freeze({
    agentSystemContract: 'kite.agent-system-contract.v1',
    askUserContract: 'kite.ask-user-contract.v1',
    compactionPolicy: 'kite.compaction-policy.v1',
    toolRegistry: 'kite.model-visible-tool-registry.v1',
    runtimeSchedulingPolicy: 'kite.runtime-scheduling-policy.v1',
    skillsContracts: 'kite.builtin-skills-contracts.v1',
    defaultConfiguration: 'kite.default-configuration.v1',
    providerRoute: 'kite.provider-route.v1',
    releaseProfile: 'kite.release-profile.v1',
    gatePolicy: 'kite.release-gate-policy.v1',
    buildRecipe: 'kite.build-recipe.v1',
    lockfile: 'kite.bun-lockfile.v1',
  });

export type CanonicalBehaviorValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalBehaviorValue[]
  | { readonly [key: string]: CanonicalBehaviorValue };
export type CanonicalBehaviorObject = Readonly<Record<string, CanonicalBehaviorValue>>;

export interface BehaviorComponentInput {
  schemaVersion: 1;
  inputIdentity: string;
  /** The generated or domain-parser-approved snapshot, never a source directory identity. */
  canonicalInput: CanonicalBehaviorObject;
}

export interface BehaviorDigestInput {
  version: 1;
  inputClass: BehaviorDigestInputClass;
  components: Readonly<Record<BehaviorComponentName, BehaviorComponentInput>>;
}

export interface BehaviorComponentDigest {
  schemaVersion: 1;
  inputIdentity: string;
  digest: BehaviorSha256Digest;
}

export interface BehaviorDigest {
  version: 1;
  canonicalizer: typeof BEHAVIOR_DIGEST_CANONICALIZER;
  inputClass: BehaviorDigestInputClass;
  items: Readonly<Record<BehaviorComponentName, BehaviorComponentDigest>>;
  aggregateDigest: BehaviorSha256Digest;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} has an invalid shape (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}).`,
    );
  }
}

/**
 * Normalize transport-only newline differences before RFC 8785. Array order is
 * deliberately retained because prompts, question options, tool precedence,
 * and default-runner order can all be behavioral.
 */
function normalizeCanonicalInput(value: unknown, path: string): CanonicalBehaviorValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry, index) => normalizeCanonicalInput(entry, `${path}[${index}]`)),
    );
  }
  if (isRecord(value)) {
    const normalized: Record<string, CanonicalBehaviorValue> = {};
    for (const key of Object.keys(value)) {
      const entry = value[key];
      if (entry === undefined) throw new Error(`${path}.${key} is undefined.`);
      normalized[key] = normalizeCanonicalInput(entry, `${path}.${key}`);
    }
    return Object.freeze(normalized);
  }
  throw new Error(`${path} contains unsupported canonical input type ${typeof value}.`);
}

function parseInputClass(value: unknown): BehaviorDigestInputClass {
  if (value !== 'production_resolved' && value !== 'synthetic_non_production') {
    throw new Error(`Unknown behavior digest inputClass: ${String(value)}.`);
  }
  return value;
}

function parseComponentInput(name: BehaviorComponentName, value: unknown): BehaviorComponentInput {
  if (!isRecord(value)) throw new Error(`Behavior component ${name} must be an object.`);
  assertExactKeys(value, ['schemaVersion', 'inputIdentity', 'canonicalInput'], name);
  if (value.schemaVersion !== 1) {
    throw new Error(`Behavior component ${name} has an unknown schemaVersion.`);
  }
  const expectedIdentity = BEHAVIOR_COMPONENT_INPUT_IDENTITIES[name];
  if (value.inputIdentity !== expectedIdentity) {
    throw new Error(
      `Behavior component ${name} input identity mismatch: expected ${expectedIdentity}.`,
    );
  }
  // Reject accessors, custom prototypes, sparse arrays, invalid Unicode, and
  // every other non-JSON value before applying the transport-only EOL fold.
  canonicalJson(value.canonicalInput);
  if (!isRecord(value.canonicalInput) || Object.keys(value.canonicalInput).length === 0) {
    throw new Error(
      `Behavior component ${name} canonicalInput must be a non-empty resolved snapshot object.`,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    inputIdentity: expectedIdentity,
    canonicalInput: normalizeCanonicalInput(
      value.canonicalInput,
      `${name}.canonicalInput`,
    ) as CanonicalBehaviorObject,
  });
}

export function parseBehaviorDigestInput(value: unknown): BehaviorDigestInput {
  if (!isRecord(value)) throw new Error('BehaviorDigestInput must be an object.');
  assertExactKeys(value, ['version', 'inputClass', 'components'], 'BehaviorDigestInput');
  if (value.version !== BEHAVIOR_DIGEST_SCHEMA_VERSION) {
    throw new Error(`Unknown behavior digest input version: ${String(value.version)}.`);
  }
  if (!isRecord(value.components)) {
    throw new Error('BehaviorDigestInput.components must be an object.');
  }
  assertExactKeys(value.components, BEHAVIOR_COMPONENT_NAMES, 'BehaviorDigestInput.components');

  const components = {} as Record<BehaviorComponentName, BehaviorComponentInput>;
  for (const name of BEHAVIOR_COMPONENT_NAMES) {
    components[name] = parseComponentInput(name, value.components[name]);
  }
  return Object.freeze({
    version: BEHAVIOR_DIGEST_SCHEMA_VERSION,
    inputClass: parseInputClass(value.inputClass),
    components: Object.freeze(components),
  });
}

export function generateBehaviorDigest(value: unknown): BehaviorDigest {
  const input = parseBehaviorDigestInput(value);
  const items = {} as Record<BehaviorComponentName, BehaviorComponentDigest>;

  for (const name of BEHAVIOR_COMPONENT_NAMES) {
    const component = input.components[name];
    items[name] = Object.freeze({
      schemaVersion: component.schemaVersion,
      inputIdentity: component.inputIdentity,
      digest: sha256DomainSeparated(
        `kite.behavior-digest.item.v1/${name}`,
        canonicalJson({
          component: name,
          schemaVersion: component.schemaVersion,
          inputIdentity: component.inputIdentity,
          canonicalInput: component.canonicalInput,
        }),
      ),
    });
  }

  const aggregateInput = Object.freeze({
    version: BEHAVIOR_DIGEST_SCHEMA_VERSION,
    canonicalizer: BEHAVIOR_DIGEST_CANONICALIZER,
    inputClass: input.inputClass,
    items: Object.freeze(items),
  });
  return Object.freeze({
    ...aggregateInput,
    aggregateDigest: sha256DomainSeparated(
      'kite.behavior-digest.aggregate.v1',
      canonicalJson(aggregateInput),
    ),
  });
}

function parseComponentDigest(
  name: BehaviorComponentName,
  value: unknown,
): BehaviorComponentDigest {
  if (!isRecord(value)) throw new Error(`Behavior digest item ${name} must be an object.`);
  assertExactKeys(value, ['schemaVersion', 'inputIdentity', 'digest'], `items.${name}`);
  if (value.schemaVersion !== 1)
    throw new Error(`Behavior digest item ${name} has unknown schema.`);
  const expectedIdentity = BEHAVIOR_COMPONENT_INPUT_IDENTITIES[name];
  if (value.inputIdentity !== expectedIdentity) {
    throw new Error(`Behavior digest item ${name} input identity mismatch.`);
  }
  if (typeof value.digest !== 'string' || !SHA256_PATTERN.test(value.digest)) {
    throw new Error(`Behavior digest item ${name} has an invalid digest.`);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    inputIdentity: expectedIdentity,
    digest: value.digest as BehaviorSha256Digest,
  });
}

export function parseBehaviorDigest(value: unknown): BehaviorDigest {
  if (!isRecord(value)) throw new Error('BehaviorDigest must be an object.');
  assertExactKeys(
    value,
    ['version', 'canonicalizer', 'inputClass', 'items', 'aggregateDigest'],
    'BehaviorDigest',
  );
  if (value.version !== BEHAVIOR_DIGEST_SCHEMA_VERSION) {
    throw new Error(`Unknown behavior digest version: ${String(value.version)}.`);
  }
  if (value.canonicalizer !== BEHAVIOR_DIGEST_CANONICALIZER) {
    throw new Error(`Unknown behavior digest canonicalizer: ${String(value.canonicalizer)}.`);
  }
  if (!isRecord(value.items)) throw new Error('BehaviorDigest.items must be an object.');
  assertExactKeys(value.items, BEHAVIOR_COMPONENT_NAMES, 'BehaviorDigest.items');
  const items = {} as Record<BehaviorComponentName, BehaviorComponentDigest>;
  for (const name of BEHAVIOR_COMPONENT_NAMES) {
    items[name] = parseComponentDigest(name, value.items[name]);
  }
  if (typeof value.aggregateDigest !== 'string' || !SHA256_PATTERN.test(value.aggregateDigest)) {
    throw new Error('BehaviorDigest.aggregateDigest is invalid.');
  }
  const inputClass = parseInputClass(value.inputClass);
  const expectedAggregateDigest = sha256DomainSeparated(
    'kite.behavior-digest.aggregate.v1',
    canonicalJson({
      version: BEHAVIOR_DIGEST_SCHEMA_VERSION,
      canonicalizer: BEHAVIOR_DIGEST_CANONICALIZER,
      inputClass,
      items,
    }),
  );
  if (value.aggregateDigest !== expectedAggregateDigest) {
    throw new Error('BehaviorDigest aggregate digest does not match its canonical items.');
  }
  return Object.freeze({
    version: BEHAVIOR_DIGEST_SCHEMA_VERSION,
    canonicalizer: BEHAVIOR_DIGEST_CANONICALIZER,
    inputClass,
    items: Object.freeze(items),
    aggregateDigest: value.aggregateDigest as BehaviorSha256Digest,
  });
}

/** Rebuild every item and the aggregate; stale or spliced output fails closed. */
export function verifyBehaviorDigest(input: unknown, candidate: unknown): BehaviorDigest {
  const parsed = parseBehaviorDigest(candidate);
  const rebuilt = generateBehaviorDigest(input);
  if (canonicalJson(parsed) !== canonicalJson(rebuilt)) {
    throw new Error('Behavior digest does not match the resolved canonical inputs.');
  }
  return parsed;
}
