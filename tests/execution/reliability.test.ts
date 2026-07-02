import { describe, expect, test } from 'bun:test';
import {
  classifyExecutionFailure,
  type ExecutionJournalState,
  failureFingerprint,
  isFingerprintExhausted,
  maxFailuresFor,
  recordExecutionResult,
} from '../../src/core/execution/journal';

describe('execution reliability journal', () => {
  test('marks repeated shell failures as exhausted at the configured limit', () => {
    let journal: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };

    for (let i = 0; i < 5; i++) {
      journal = recordExecutionResult(journal, {
        toolCallId: `call-${i}`,
        toolName: 'shell_execute',
        ok: false,
        stderr: 'test failed',
        exitCode: 1,
      });
    }

    const failure = classifyExecutionFailure(journal, {
      toolName: 'shell_execute',
      ok: false,
      stderr: 'test failed',
      exitCode: 1,
    });

    expect(failure.exhausted?.consecutiveFailures).toBe(5);
    expect(journal.exhaustedFingerprints[failure.fingerprint]).toBe(true);
  });

  test('success entry breaks consecutive failure chain', () => {
    let journal: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };

    // 2 failures
    journal = recordExecutionResult(journal, {
      toolCallId: 'c1',
      toolName: 'shell_execute',
      ok: false,
      stderr: 'fail',
      exitCode: 1,
    });
    journal = recordExecutionResult(journal, {
      toolCallId: 'c2',
      toolName: 'shell_execute',
      ok: false,
      stderr: 'fail',
      exitCode: 1,
    });
    // 1 success (e.g. write_file fix) — should break the chain
    journal = recordExecutionResult(journal, {
      toolCallId: 'c3',
      toolName: 'write_file',
      ok: true,
      path: 'test.ts',
    });
    // 1 more failure with same fingerprint
    journal = recordExecutionResult(journal, {
      toolCallId: 'c4',
      toolName: 'shell_execute',
      ok: false,
      stderr: 'fail',
      exitCode: 1,
    });

    const failure = classifyExecutionFailure(journal, {
      toolName: 'shell_execute',
      ok: false,
      stderr: 'fail',
      exitCode: 1,
    });

    // Success broke the chain — only 1 consecutive failure (the last one)
    expect(failure.exhausted).toBeUndefined();
  });

  test('different error codes produce different fingerprints', () => {
    const fp1 = failureFingerprint({
      toolName: 'shell_execute',
      errorCode: 'ENOENT',
      affectedPath: 'foo.ts',
    });
    const fp2 = failureFingerprint({
      toolName: 'shell_execute',
      errorCode: 'EXIT_NONZERO',
      affectedPath: 'foo.ts',
    });
    expect(fp1).not.toBe(fp2);
    expect(fp1).toContain('ENOENT');
    expect(fp2).toContain('EXIT_NONZERO');
  });

  test('different error codes produce independent exhaustion tracking', () => {
    let journal: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };

    // 3 ENOENT failures (hits ENOENT limit → exhaustedFingerprints records it)
    for (let i = 0; i < 3; i++) {
      journal = recordExecutionResult(journal, {
        toolCallId: `e${i}`,
        toolName: 'shell_execute',
        ok: false,
        stderr: `ENOENT: no such file`,
        exitCode: 1,
        path: 'missing.ts',
      });
    }

    const enoentFp = failureFingerprint({
      toolName: 'shell_execute',
      errorCode: 'ENOENT',
      affectedPath: 'missing.ts',
    });
    // ENOENT fingerprint was written to exhaustedFingerprints by recordExecutionResult
    expect(journal.exhaustedFingerprints[enoentFp]).toBe(true);

    // EXIT_NONZERO failure — different fingerprint, starts fresh count
    journal = recordExecutionResult(journal, {
      toolCallId: 'x1',
      toolName: 'shell_execute',
      ok: false,
      stderr: 'test failed',
      exitCode: 1,
      path: 'missing.ts',
    });

    const nonzeroFailure = classifyExecutionFailure(journal, {
      toolName: 'shell_execute',
      ok: false,
      stderr: 'test failed',
      exitCode: 1,
      path: 'missing.ts',
    });
    // EXIT_NONZERO only has 1 consecutive — not exhausted (limit is 5)
    expect(nonzeroFailure.exhausted).toBeUndefined();
  });

  test('ENOENT limit is lower than TIMEOUT limit', () => {
    expect(maxFailuresFor('ENOENT')).toBe(3);
    expect(maxFailuresFor('TIMEOUT')).toBe(10);
    expect(maxFailuresFor('EXIT_NONZERO')).toBe(5);
    expect(maxFailuresFor('ENOENT')).toBeLessThan(maxFailuresFor('TIMEOUT'));
  });

  test('default limit is 3 for unknown error codes', () => {
    expect(maxFailuresFor('UNKNOWN_ERROR')).toBe(3);
  });

  test('isFingerprintExhausted matches tool+path regardless of errorCode', () => {
    const exhausted: Record<string, true> = {
      'write_file:EXIT_NONZERO:foo.txt': true,
    };

    // Same tool + same path → match (regardless of errorCode in the stored fingerprint)
    expect(isFingerprintExhausted(exhausted, 'write_file', 'foo.txt')).toBe(true);
  });

  test('isFingerprintExhausted does not match different path', () => {
    const exhausted: Record<string, true> = {
      'write_file:EXIT_NONZERO:foo.txt': true,
    };

    expect(isFingerprintExhausted(exhausted, 'write_file', 'bar.txt')).toBe(false);
  });

  test('isFingerprintExhausted matches tool without path', () => {
    const exhausted: Record<string, true> = {
      'shell_execute:EXIT_NONZERO:': true,
    };

    expect(isFingerprintExhausted(exhausted, 'shell_execute')).toBe(true);
    expect(isFingerprintExhausted(exhausted, 'write_file')).toBe(false);
  });

  test('isFingerprintExhausted returns false for empty record', () => {
    expect(isFingerprintExhausted({}, 'shell_execute', 'foo.ts')).toBe(false);
  });

  test('recordExecutionResult writes exhausted fingerprint to state', () => {
    let journal: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };

    // 5 failures → EXIT_NONZERO limit hit
    for (let i = 0; i < 5; i++) {
      journal = recordExecutionResult(journal, {
        toolCallId: `c${i}`,
        toolName: 'shell_execute',
        ok: false,
        stderr: 'same error every time',
        exitCode: 1,
        path: 'test.ts',
      });
    }

    const fp = failureFingerprint({
      toolName: 'shell_execute',
      errorCode: 'EXIT_NONZERO',
      affectedPath: 'test.ts',
    });
    expect(journal.exhaustedFingerprints[fp]).toBe(true);
  });
});
