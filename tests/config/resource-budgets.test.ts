import { describe, expect, test } from 'bun:test';
import { configSchema, DEFAULT_RESOURCE_BUDGETS, resolveResourceBudgets } from '@/core/config';

describe('resource budget baseline', () => {
  test('resolves the reviewed PR0 defaults', () => {
    expect(resolveResourceBudgets()).toEqual(DEFAULT_RESOURCE_BUDGETS);
  });

  test('accepts safe partial overrides without changing unspecified defaults', () => {
    expect(resolveResourceBudgets({ modelTotalMs: 900_000 })).toEqual({
      ...DEFAULT_RESOURCE_BUDGETS,
      modelTotalMs: 900_000,
    });
  });

  test('rejects unknown, non-positive, and internally inconsistent values', () => {
    expect(() => configSchema.parse({ resourceBudgets: { unknown: 1 } })).toThrow();
    expect(() => resolveResourceBudgets({ readMaxBytes: 0 })).toThrow();
    expect(() => resolveResourceBudgets({ shellDefaultMs: 20_000, shellMaxMs: 10_000 })).toThrow(
      'shellDefaultMs must not exceed shellMaxMs',
    );
  });
});
