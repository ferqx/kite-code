import { describe, expect, test } from 'bun:test';
import {
  BuiltinMechanismAuthorityErrorV1,
  mergeBuiltinMechanismBundleV1,
} from '@kite/builtin-runtime';

describe('Builtin mechanism authority', () => {
  test('accepts one exact frozen mechanism and freezes the merged bundle', () => {
    const filesystem = Object.freeze({
      allowExternalPaths: false,
      dispatch: async () => Object.freeze({ ok: true }),
    });
    const merged = mergeBuiltinMechanismBundleV1({
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
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'mcp',
        prepared: Object.freeze({ mcp }),
        runner: Object.freeze({ mcp }),
      }),
    ).toThrow(BuiltinMechanismAuthorityErrorV1);
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'filesystem',
        prepared: Object.freeze({ mcp }),
      }),
    ).toThrow(BuiltinMechanismAuthorityErrorV1);
  });

  test('rejects mutable maps before any mechanism can be selected', () => {
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'mcp',
        prepared: { mcp: Object.freeze({ runtime: Object.freeze({}) }) },
      }),
    ).toThrow(BuiltinMechanismAuthorityErrorV1);
  });
});
