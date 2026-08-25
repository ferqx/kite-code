import { describe, expect, test } from 'bun:test';
import { classifyHistoricalSessionOpenFailure } from '../src/tui/session-open-diagnostic';

describe('historical Session open diagnostics', () => {
  test('classifies known admission and storage failures without returning private messages', () => {
    const privatePath = '/private/workspace/secret';
    const cases = [
      [
        'runtime_registration',
        new Error('Persisted State Session is missing its Project identity.'),
        'project_identity_missing',
      ],
      [
        'runtime_registration',
        new Error('Runtime session Project identity is invalid.'),
        'project_identity_invalid',
      ],
      [
        'persisted_load',
        Object.assign(new Error(`snapshot checksum failed at ${privatePath}`), {
          name: 'SqliteRuntimeStorageOpenError',
        }),
        'storage_corrupted',
      ],
      [
        'runtime_registration',
        new Error(`Runtime Host Builtin model operation composition unavailable: ${privatePath}`),
        'runtime_composition_unavailable',
      ],
      [
        'presentation_replay',
        new Error(`unknown private failure at ${privatePath}`),
        'presentation_replay_failed',
      ],
    ] as const;

    for (const [stage, error, expected] of cases) {
      const code = classifyHistoricalSessionOpenFailure(stage, error);
      expect(code).toBe(expected);
      expect(code).not.toContain(privatePath);
      expect(code).not.toContain(error.message);
    }
  });
});
