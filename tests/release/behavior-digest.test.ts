import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BEHAVIOR_COMPONENT_NAMES,
  generateBehaviorDigest,
  parseBehaviorDigest,
  parseBehaviorDigestInput,
  verifyBehaviorDigest,
} from '../../scripts/release/behavior-digest';

const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'release', 'behavior-digest');

interface MutableComponentFixture {
  schemaVersion: number;
  inputIdentity: string;
  canonicalInput: Record<string, unknown>;
}

interface MutableBehaviorFixture {
  version: number;
  inputClass: string;
  components: Record<string, MutableComponentFixture>;
  [key: string]: unknown;
}

interface MutableDigestFixture {
  items: Record<string, { digest: string; [key: string]: unknown }>;
  aggregateDigest: string;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
    );
  }
  return value;
}

function withCrLf(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\n/g, '\r\n');
  if (Array.isArray(value)) return value.map(withCrLf);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        withCrLf(entry),
      ]),
    );
  }
  return value;
}

describe('BehaviorDigest', () => {
  test('matches the explicitly non-production cross-platform golden', () => {
    const input = fixture('synthetic-input.json');
    const golden = parseBehaviorDigest(fixture('synthetic-golden.json'));
    expect(generateBehaviorDigest(input)).toEqual(golden);
    expect((input as { inputClass: string }).inputClass).toBe('synthetic_non_production');
    expect((golden as { inputClass: string }).inputClass).toBe('synthetic_non_production');
  });

  test('is stable across map/key insertion order and CRLF platform newlines', () => {
    const input = fixture('synthetic-input.json');
    const expected = generateBehaviorDigest(input);
    expect(generateBehaviorDigest(reverseObjectKeys(input))).toEqual(expected);
    expect(generateBehaviorDigest(withCrLf(input))).toEqual(expected);
  });

  test('binds every required resolved behavior input independently and in aggregate', () => {
    const input = fixture('synthetic-input.json') as MutableBehaviorFixture;
    const baseline = generateBehaviorDigest(input);

    for (const name of BEHAVIOR_COMPONENT_NAMES) {
      const changed = clone(input);
      changed.components[name]!.canonicalInput.semanticRevision = `changed-${name}`;
      const result = generateBehaviorDigest(changed);
      expect(result.items[name].digest).not.toBe(baseline.items[name].digest);
      expect(result.aggregateDigest).not.toBe(baseline.aggregateDigest);
      for (const sibling of BEHAVIOR_COMPONENT_NAMES) {
        if (sibling !== name)
          expect(result.items[sibling].digest).toBe(baseline.items[sibling].digest);
      }
    }
  });

  test('preserves behaviorally meaningful array order', () => {
    const input = fixture('synthetic-input.json') as MutableBehaviorFixture;
    const baseline = generateBehaviorDigest(input);
    (input.components.buildRecipe!.canonicalInput.processIsolatedTests as unknown[]).reverse();
    const changed = generateBehaviorDigest(input);
    expect(changed.items.buildRecipe.digest).not.toBe(baseline.items.buildRecipe.digest);
    expect(changed.aggregateDigest).not.toBe(baseline.aggregateDigest);
  });

  test('labels synthetic inputs so they cannot splice into a production-resolved aggregate', () => {
    const synthetic = fixture('synthetic-input.json') as MutableBehaviorFixture;
    const production = clone(synthetic);
    production.inputClass = 'production_resolved';
    const syntheticDigest = generateBehaviorDigest(synthetic);
    const productionDigest = generateBehaviorDigest(production);
    expect(productionDigest.items).toEqual(syntheticDigest.items);
    expect(productionDigest.aggregateDigest).not.toBe(syntheticDigest.aggregateDigest);
  });

  test('rebuilds all item and aggregate digests during verification', () => {
    const input = fixture('synthetic-input.json');
    const digest = generateBehaviorDigest(input);
    expect(verifyBehaviorDigest(input, digest)).toEqual(digest);

    const spliced = clone(digest) as unknown as MutableDigestFixture;
    spliced.items.toolRegistry!.digest = spliced.items.lockfile!.digest;
    expect(() => parseBehaviorDigest(spliced)).toThrow(
      'aggregate digest does not match its canonical items',
    );

    const staleAggregate = clone(digest) as unknown as MutableDigestFixture;
    staleAggregate.aggregateDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => parseBehaviorDigest(staleAggregate)).toThrow(
      'aggregate digest does not match its canonical items',
    );

    const changedInput = clone(input) as MutableBehaviorFixture;
    changedInput.components.toolRegistry!.canonicalInput.semanticRevision = 'stale-input';
    const internallyValidButStale = generateBehaviorDigest(changedInput);
    expect(() => verifyBehaviorDigest(input, internallyValidButStale)).toThrow(
      'does not match the resolved canonical inputs',
    );
  });

  test('fails closed for missing, unknown, or mismatched input identity', () => {
    const baseline = fixture('synthetic-input.json') as MutableBehaviorFixture;

    const missing = clone(baseline);
    delete missing.components.lockfile;
    expect(() => parseBehaviorDigestInput(missing)).toThrow('missing: lockfile');

    const unknown = clone(baseline);
    unknown.components.futureContract = unknown.components.askUserContract!;
    expect(() => parseBehaviorDigestInput(unknown)).toThrow('unknown: futureContract');

    const unknownTopLevel = clone(baseline);
    unknownTopLevel.note = 'must not be ignored';
    expect(() => parseBehaviorDigestInput(unknownTopLevel)).toThrow('unknown: note');

    const unknownSchema = clone(baseline);
    unknownSchema.components.toolRegistry!.schemaVersion = 2;
    expect(() => parseBehaviorDigestInput(unknownSchema)).toThrow('unknown schemaVersion');

    const wrongIdentity = clone(baseline);
    wrongIdentity.components.toolRegistry!.inputIdentity = 'kite.bun-lockfile.v1';
    expect(() => parseBehaviorDigestInput(wrongIdentity)).toThrow('input identity mismatch');
  });

  test('rejects non-JSON canonical input instead of hashing a lossy projection', () => {
    const undefinedEntry = fixture('synthetic-input.json') as MutableBehaviorFixture;
    undefinedEntry.components.gatePolicy!.canonicalInput.required = undefined;
    expect(() => parseBehaviorDigestInput(undefinedEntry)).toThrow();

    const customPrototype = fixture('synthetic-input.json') as MutableBehaviorFixture;
    customPrototype.components.gatePolicy!.canonicalInput = new Date(
      '2026-08-01T00:00:00Z',
    ) as unknown as Record<string, unknown>;
    expect(() => parseBehaviorDigestInput(customPrototype)).toThrow('plain JSON object');

    const sourceDirectoryOnly = fixture('synthetic-input.json') as MutableBehaviorFixture;
    sourceDirectoryOnly.components.toolRegistry!.canonicalInput =
      'src/core/tools' as unknown as Record<string, unknown>;
    expect(() => parseBehaviorDigestInput(sourceDirectoryOnly)).toThrow(
      'must be a non-empty resolved snapshot object',
    );
  });

  test('rejects unknown output fields and digest formats before comparison', () => {
    const output = generateBehaviorDigest(fixture('synthetic-input.json'));
    const extra = clone(output) as unknown as MutableDigestFixture;
    extra.items.lockfile!.sourceDirectory = 'not-bound';
    expect(() => parseBehaviorDigest(extra)).toThrow('unknown: sourceDirectory');

    const invalid = clone(output) as unknown as MutableDigestFixture;
    invalid.aggregateDigest = 'sha256:NOT-A-DIGEST';
    expect(() => parseBehaviorDigest(invalid)).toThrow('aggregateDigest is invalid');
  });
});
