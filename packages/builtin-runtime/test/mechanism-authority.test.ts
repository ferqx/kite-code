import { describe, expect, test } from 'bun:test';
import {
  BuiltinMechanismAuthorityError,
  mergeBuiltinMechanismBundle,
} from '@kite-ai/builtin-runtime';

describe('Builtin mechanism authority', () => {
  test('accepts one exact frozen mechanism and freezes the merged bundle', () => {
    const filesystem = Object.freeze({
      allowExternalPaths: false,
      dispatch: async () => Object.freeze({ ok: true }),
    });
    const merged = mergeBuiltinMechanismBundle({
      executionMechanism: 'filesystem',
      prepared: Object.freeze({ filesystem }),
    });

    expect(merged).toEqual({ filesystem });
    expect(Object.isFrozen(merged)).toBe(true);
  });

  test('rejects duplicate or mismatched mechanism owners fail closed', () => {
    const mcp = Object.freeze({
      runtime: Object.freeze({ callCapability: async () => Object.freeze({}) }),
    });

    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'mcp',
        prepared: Object.freeze({ mcp }),
        runner: Object.freeze({ mcp }),
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'filesystem',
        prepared: Object.freeze({ mcp }),
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
  });

  test('rejects mutable maps before any mechanism can be selected', () => {
    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'mcp',
        prepared: { mcp: Object.freeze({ runtime: Object.freeze({}) }) },
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
  });
});
