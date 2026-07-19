import { describe, expect, test } from 'bun:test';
import { isFingerprintExhausted } from '../../src/core/execution/journal';

describe('execution reliability gateway', () => {
  test('preflight check blocks exhausted tool+path', () => {
    const exhausted: Record<string, true> = {
      'write_file:EXIT_NONZERO:foo.txt': true,
    };

    expect(isFingerprintExhausted(exhausted, 'write_file', 'foo.txt')).toBe(true);
  });

  test('preflight check allows different tool with same path', () => {
    const exhausted: Record<string, true> = {
      'write_file:EXIT_NONZERO:foo.txt': true,
    };

    expect(isFingerprintExhausted(exhausted, 'edit_file', 'foo.txt')).toBe(false);
  });

  test('preflight check allows same tool with different path', () => {
    const exhausted: Record<string, true> = {
      'write_file:EXIT_NONZERO:foo.txt': true,
    };

    expect(isFingerprintExhausted(exhausted, 'write_file', 'bar.txt')).toBe(false);
  });

  test('preflight check matches regardless of stored errorCode', () => {
    const exhausted: Record<string, true> = {
      'shell_execute:ENOENT:test.ts': true,
      'shell_execute:TIMEOUT:test.ts': true,
    };

    // Both errorCodes produce different fingerprints, but both match same tool+path
    expect(isFingerprintExhausted(exhausted, 'shell_execute', 'test.ts')).toBe(true);
  });

  test('preflight check with no path matches any tool-only fingerprint', () => {
    const exhausted: Record<string, true> = {
      'shell_execute:TIMEOUT:': true,
    };

    expect(isFingerprintExhausted(exhausted, 'shell_execute')).toBe(true);
    expect(isFingerprintExhausted(exhausted, 'shell_execute', undefined)).toBe(true);
  });

  test('multiple exhausted fingerprints are all checked', () => {
    const exhausted: Record<string, true> = {
      'write_file:EXIT_NONZERO:foo.txt': true,
      'shell_execute:EXIT_NONZERO:test.ts': true,
      'edit_file:ENOENT:bar.txt': true,
    };

    expect(isFingerprintExhausted(exhausted, 'write_file', 'foo.txt')).toBe(true);
    expect(isFingerprintExhausted(exhausted, 'shell_execute', 'test.ts')).toBe(true);
    expect(isFingerprintExhausted(exhausted, 'edit_file', 'bar.txt')).toBe(true);
    expect(isFingerprintExhausted(exhausted, 'shell_execute', 'other.ts')).toBe(false);
  });
});
