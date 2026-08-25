import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostToolCallSnapshot,
  type RuntimeHostToolCallSnapshotInput,
} from '@kite-ai/runtime-host';
import type { ToolArgumentOrigin } from '@kite-ai/runtime-spi';

const BASE: RuntimeHostToolCallSnapshotInput = {
  toolCallId: 'call-1',
  name: 'read_file',
  rawArguments: {
    path: 'README.md',
    nested: [1, true, null],
  },
  argumentOrigin: 'model_public',
  createdAtTurnId: 'turn-1',
  modelMessageId: 'message-1',
  bindingId: null,
  capabilityId: null,
  capabilityRevision: null,
};

function snapshot(
  overrides: Partial<RuntimeHostToolCallSnapshotInput> = {},
): RuntimeHostToolCallSnapshotInput {
  return { ...BASE, ...overrides };
}

function expectFailure(
  result: ReturnType<typeof createRuntimeHostToolCallSnapshot>,
  code: 'invalid_identity' | 'arguments_not_canonical_json',
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.failure.stage).toBe('snapshot');
  expect(result.failure.code).toBe(code);
  expect(typeof result.failure.diagnostic).toBe('string');
  const diagnostic = result.failure.diagnostic as string;
  expect(diagnostic.includes('README')).toBe(false);
  expect(diagnostic.includes('secret')).toBe(false);
}

describe('Runtime Host ToolCall snapshot seam', () => {
  test('captures explicit origin and deeply freezes an independent JSON copy', () => {
    const source = {
      path: 'README.md',
      nested: { limit: 10 },
    };
    const result = createRuntimeHostToolCallSnapshot(
      snapshot({ rawArguments: source, argumentOrigin: 'model_public' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    source.path = 'changed-after-snapshot';
    source.nested.limit = 99;
    expect(result.value.rawArguments).toEqual({ path: 'README.md', nested: { limit: 10 } });
    expect(result.value.argumentOrigin).toBe('model_public');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.rawArguments)).toBe(true);
    if (typeof result.value.rawArguments !== 'object' || result.value.rawArguments === null) {
      throw new Error('snapshot arguments unexpectedly non-object');
    }
    const copied = result.value.rawArguments as Record<string, unknown>;
    expect(Object.isFrozen(copied.nested)).toBe(true);
    expect(Reflect.set(result.value.rawArguments, 'path', 'tampered')).toBe(false);
  });

  test('preserves model_public and runtime_private as explicit provenance', () => {
    for (const argumentOrigin of ['model_public', 'runtime_private'] as const) {
      const result = createRuntimeHostToolCallSnapshot(snapshot({ argumentOrigin }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.argumentOrigin).toBe(argumentOrigin);
    }
    expectFailure(
      createRuntimeHostToolCallSnapshot(
        snapshot({ argumentOrigin: 'forged' as unknown as ToolArgumentOrigin }),
      ),
      'invalid_identity',
    );
  });

  test('accepts ordinary and null-prototype JSON objects and dense arrays', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.path = 'README.md';
    const result = createRuntimeHostToolCallSnapshot(
      snapshot({ rawArguments: { nullPrototype, values: ['a', 2, false] } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = result.value.rawArguments as Record<string, unknown>;
    expect(Object.getPrototypeOf(args.nullPrototype)).toBeNull();
    expect(Object.isFrozen(args.values)).toBe(true);
  });

  test('copies shared subobjects without retaining caller references', () => {
    const shared = { value: 'shared' };
    const source = { left: shared, right: shared };
    const result = createRuntimeHostToolCallSnapshot(snapshot({ rawArguments: source }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copied = result.value.rawArguments as Record<string, Record<string, unknown>>;
    expect(copied.left).toBe(copied.right);
    expect(copied.left).not.toBe(shared);
    expect(Object.isFrozen(copied.left)).toBe(true);
  });

  test('rejects identity omissions, wrong origins, and oversized identity values', () => {
    const invalidInputs: readonly Partial<RuntimeHostToolCallSnapshotInput>[] = [
      { toolCallId: '' },
      { name: '' },
      { createdAtTurnId: '' },
      { modelMessageId: '' },
      { toolCallId: 'x'.repeat(257) },
      { name: 'x'.repeat(257) },
      { bindingId: '' },
      { capabilityId: '' },
      { capabilityRevision: '' },
      { bindingId: 'x'.repeat(257) },
      { capabilityId: 'x'.repeat(257) },
      { capabilityRevision: 'x'.repeat(257) },
      { argumentOrigin: 'other' as unknown as ToolArgumentOrigin },
    ];
    for (const overrides of invalidInputs) {
      const result = createRuntimeHostToolCallSnapshot(snapshot(overrides));
      expectFailure(result, 'invalid_identity');
    }
  });

  test('rejects accessors without invoking them', () => {
    let getterCalls = 0;
    const argumentsWithGetter = {} as Record<string, unknown>;
    Object.defineProperty(argumentsWithGetter, 'path', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    expectFailure(
      createRuntimeHostToolCallSnapshot(snapshot({ rawArguments: argumentsWithGetter })),
      'arguments_not_canonical_json',
    );
    expect(getterCalls).toBe(0);

    let inputGetterCalls = 0;
    const input = { ...snapshot() } as Record<string, unknown>;
    Object.defineProperty(input, 'rawArguments', {
      enumerable: true,
      get() {
        inputGetterCalls += 1;
        return {};
      },
    });
    expectFailure(
      createRuntimeHostToolCallSnapshot(input as unknown as RuntimeHostToolCallSnapshotInput),
      'invalid_identity',
    );
    expect(inputGetterCalls).toBe(0);
  });

  test('rejects symbols, invalid prototypes, and cycles', () => {
    const withSymbol = { path: 'README.md' } as Record<string | symbol, unknown>;
    withSymbol[Symbol('secret')] = 'hidden';
    expectFailure(
      createRuntimeHostToolCallSnapshot(snapshot({ rawArguments: withSymbol })),
      'arguments_not_canonical_json',
    );

    const withPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    withPrototype.path = 'README.md';
    expectFailure(
      createRuntimeHostToolCallSnapshot(snapshot({ rawArguments: withPrototype })),
      'arguments_not_canonical_json',
    );

    const cycle = {} as Record<string, unknown>;
    cycle.self = cycle;
    expectFailure(
      createRuntimeHostToolCallSnapshot(snapshot({ rawArguments: cycle })),
      'arguments_not_canonical_json',
    );
  });

  test('rejects sparse or extended arrays', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectFailure(
      createRuntimeHostToolCallSnapshot(snapshot({ rawArguments: sparse })),
      'arguments_not_canonical_json',
    );

    const extended = ['value'] as unknown[] & { extra?: string };
    extended.extra = 'not-json-array-data';
    expectFailure(
      createRuntimeHostToolCallSnapshot(snapshot({ rawArguments: extended })),
      'arguments_not_canonical_json',
    );
  });

  test('rejects undefined, bigint, functions, and non-finite numbers', () => {
    const invalidValues: readonly unknown[] = [
      undefined,
      1n,
      () => 'function',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { path: undefined },
      { path: 1n },
      { path: () => 'function' },
      { path: Number.NEGATIVE_INFINITY },
    ];
    for (const rawArguments of invalidValues) {
      expectFailure(
        createRuntimeHostToolCallSnapshot(snapshot({ rawArguments })),
        'arguments_not_canonical_json',
      );
    }
  });
});
