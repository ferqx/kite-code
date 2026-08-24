import { describe, expect, test } from 'bun:test';
import { createModelSecretDetector } from '../src/model';

const inspect = createModelSecretDetector({
  knownSecrets: ['KNOWN_SECRET_MARKER'],
  environment: {
    ORDINARY_SETTING: 'not-secret-by-name',
    SERVICE_API_KEY: 'ENV_SECRET_MARKER',
  },
});

describe('createModelSecretDetector legacy differential corpus', () => {
  test.each([
    ['ordinary content', 'clear'],
    ['contains KNOWN_SECRET_MARKER', 'secret'],
    ['contains ENV_SECRET_MARKER', 'secret'],
    ['-----BEGIN PRIVATE KEY-----', 'secret'],
    ['api_key=synthetic-value', 'secret'],
    ['authorization: synthetic-token', 'secret'],
    ['Authorization: Bearer synthetic-token', 'secret'],
    ['Authorization: Basic dXNlcjpwYXNz', 'secret'],
    ['accept basic keyboard input', 'clear'],
    ['readonly authorization:\n  readonly mode: InteractionMode;', 'clear'],
    ['sk-1234567890abcdef', 'secret'],
    ['read /workspace/.env.local', 'secret'],
  ] as const)('classifies %s as %s', (text, verdict) => {
    expect(inspect({ text, provenance: 'model_visible_answer' })).toEqual({
      schemaVersion: 1,
      detector: 'runtime_secret_detector',
      verdict,
    });
  });

  test('ignores non-credential environment names and fails closed above the scan bound', () => {
    expect(inspect({ text: 'not-secret-by-name', provenance: 'user_message' }).verdict).toBe(
      'clear',
    );
    const bounded = createModelSecretDetector({ environment: {}, maxInspectionChars: 4 });
    expect(bounded({ text: '1234', provenance: 'user_message' }).verdict).toBe('clear');
    expect(bounded({ text: '12345', provenance: 'user_message' })).toEqual({
      schemaVersion: 1,
      detector: 'runtime_secret_detector',
      verdict: 'unknown',
    });
  });
});
