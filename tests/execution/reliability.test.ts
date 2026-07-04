import { describe, expect, test } from 'bun:test';
import {
  classifyExecutionFailure,
  type ExecutionJournalState,
  errorCodeFor,
  failureFingerprint,
  isFingerprintExhausted,
  maxFailuresFor,
  recordExecutionResult,
} from '../../src/core/execution/journal';
import { parseToolResultEvents } from '../../src/core/runner';
import type { ToolResultPayload } from '../../src/protocol/events';

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

describe('errorCodeFor — stderr classification', () => {
  test('"No such file or directory" → EXIT_NONZERO (not ENOENT)', () => {
    // cat /nonexistent produces "No such file or directory" — does NOT contain "not found"
    const code = errorCodeFor({
      exitCode: 1,
      stderr: 'cat: /nonexistent_file_12345: No such file or directory',
    });
    expect(code).toBe('EXIT_NONZERO');
  });

  test('"not found" (lowercase) → ENOENT', () => {
    const code = errorCodeFor({
      exitCode: 1,
      stderr: 'bash: line 1: foo: command not found',
    });
    expect(code).toBe('ENOENT');
  });

  test('EXIT_NONZERO threshold is 5', () => {
    expect(maxFailuresFor('EXIT_NONZERO')).toBe(5);
  });
});

describe('sequential cat-failure accumulation (simulates TUI session)', () => {
  test('5 consecutive "cat nonexistent" failures exhaust EXIT_NONZERO', () => {
    let journal: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };

    const catStderr = 'cat: /nonexistent_file_12345: No such file or directory';

    // Simulate 5 separate tool invocations (separate user messages → separate tool calls)
    for (let i = 0; i < 5; i++) {
      journal = recordExecutionResult(journal, {
        toolCallId: `c${i}`,
        toolName: 'shell_execute',
        ok: false,
        stderr: catStderr,
        exitCode: 1,
      });
    }

    const fp = failureFingerprint({
      toolName: 'shell_execute',
      errorCode: 'EXIT_NONZERO',
      affectedPath: undefined,
    });
    expect(journal.exhaustedFingerprints[fp]).toBe(true);
    expect(journal.executionJournal.length).toBe(5);
  });

  test('a fresh journal (new turn) does not carry over previous-turn exhaustion', () => {
    // Per-turn semantics: cleanup node resets journal → exhaustion resets each turn.
    // Only consecutive failures within a single turn trigger exhaustion.
    const fresh: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };
    expect(Object.keys(fresh.exhaustedFingerprints).length).toBe(0);
    expect(fresh.executionJournal.length).toBe(0);

    // 1 failure in a new turn → not exhausted
    const after1 = recordExecutionResult(fresh, {
      toolCallId: 'c0',
      toolName: 'shell_execute',
      ok: false,
      stderr: 'cat: /x: No such file or directory',
      exitCode: 1,
    });
    expect(Object.keys(after1.exhaustedFingerprints).length).toBe(0);
    expect(after1.executionJournal.length).toBe(1);
  });

  test('interleaved success breaks the consecutive chain', () => {
    let journal: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };

    const catStderr = 'cat: /nonexistent_file_12345: No such file or directory';

    // 2 failures → 1 success → 2 more failures = no exhaustion (chain broken)
    journal = recordExecutionResult(journal, {
      toolCallId: 'c0',
      toolName: 'shell_execute',
      ok: false,
      stderr: catStderr,
      exitCode: 1,
    });
    journal = recordExecutionResult(journal, {
      toolCallId: 'c1',
      toolName: 'shell_execute',
      ok: false,
      stderr: catStderr,
      exitCode: 1,
    });
    journal = recordExecutionResult(journal, {
      toolCallId: 'c2',
      toolName: 'shell_execute',
      ok: true,
      exitCode: 0,
    });
    journal = recordExecutionResult(journal, {
      toolCallId: 'c3',
      toolName: 'shell_execute',
      ok: false,
      stderr: catStderr,
      exitCode: 1,
    });
    journal = recordExecutionResult(journal, {
      toolCallId: 'c4',
      toolName: 'shell_execute',
      ok: false,
      stderr: catStderr,
      exitCode: 1,
    });

    const fp = failureFingerprint({
      toolName: 'shell_execute',
      errorCode: 'EXIT_NONZERO',
      affectedPath: undefined,
    });
    // After success at c2, the chain resets; only 2 consecutive failures → not exhausted
    expect(journal.exhaustedFingerprints[fp]).toBeUndefined();
    expect(journal.executionJournal.length).toBe(5);
  });

  test('10 cat failures in one batch → #5 exhausts, #6-10 preflight-blocked', () => {
    // Simulates: agent emits 10 shell_execute cat tools in one AIMessage.
    // The tools node processes mutations sequentially with per-iteration preflight.
    // After #5 exhausts, #6-10 must be preflight-blocked (no execution).
    const catStderr = 'cat: /nonexistent_file_12345: No such file or directory';
    let journal: ExecutionJournalState = {
      executionJournal: [],
      exhaustedFingerprints: {},
    };

    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      // Preflight (same as tools node Phase 2)
      if (isFingerprintExhausted(journal.exhaustedFingerprints, 'shell_execute', undefined)) {
        results.push(`#${i + 1}: BLOCKED`);
        continue;
      }

      journal = recordExecutionResult(journal, {
        toolCallId: `c${i}`,
        toolName: 'shell_execute',
        ok: false,
        stderr: catStderr,
        exitCode: 1,
      });

      const fp = failureFingerprint({
        toolName: 'shell_execute',
        errorCode: 'EXIT_NONZERO',
        affectedPath: undefined,
      });
      results.push(`#${i + 1}: ${journal.exhaustedFingerprints[fp] ? 'EXHAUSTED' : 'FAILED'}`);
    }

    expect(results).toEqual([
      '#1: FAILED',
      '#2: FAILED',
      '#3: FAILED',
      '#4: FAILED',
      '#5: EXHAUSTED',
      '#6: BLOCKED',
      '#7: BLOCKED',
      '#8: BLOCKED',
      '#9: BLOCKED',
      '#10: BLOCKED',
    ]);
    expect(journal.executionJournal.length).toBe(5); // Only 5 actually ran
  });
});

describe('parseToolResultEvents — exhaustion status extraction', () => {
  test('extracts status: exhausted from ToolMessage JSON', () => {
    const event = parseToolResultEvents({
      content: JSON.stringify({
        ok: false,
        command: 'shell_execute',
        exitCode: 1,
        stdout: '',
        stderr: 'test failed',
        status: 'exhausted',
        failure: { message: 'Tool execution failed.', tool: 'shell_execute', reason: 'exhausted' },
      }),
      tool_call_id: 'c1',
      name: 'shell_execute',
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe('tool_done');
    expect((event!.data as ToolResultPayload).status).toBe('exhausted');
    expect((event!.data as ToolResultPayload).ok).toBe(false);
  });

  test('does not set status when ToolMessage JSON has no status field', () => {
    const event = parseToolResultEvents({
      content: JSON.stringify({ ok: false, stderr: 'error' }),
      tool_call_id: 'c2',
      name: 'shell_execute',
    });
    expect(event).not.toBeNull();
    expect((event!.data as ToolResultPayload).status).toBeUndefined();
  });

  test('does not set status for unknown status values', () => {
    const event = parseToolResultEvents({
      content: JSON.stringify({ ok: true, status: 'bogus_value' }),
      tool_call_id: 'c3',
      name: 'read_file',
    });
    expect(event).not.toBeNull();
    expect((event!.data as ToolResultPayload).status).toBeUndefined();
  });

  test('extracts status: success from ToolMessage JSON', () => {
    const event = parseToolResultEvents({
      content: JSON.stringify({ ok: true, stdout: 'done', status: 'success' }),
      tool_call_id: 'c4',
      name: 'shell_execute',
    });
    expect(event).not.toBeNull();
    expect((event!.data as ToolResultPayload).status).toBe('success');
  });

  test('extracts status from preflight-block ToolMessage with full exhaustion structure', () => {
    // This mimics the ToolMessage created by the preflight check in graph.ts
    const event = parseToolResultEvents({
      content: JSON.stringify({
        ok: false,
        command: undefined,
        exitCode: -1,
        stdout: '',
        stderr: 'Execution blocked: too many repeated failures for shell_execute.',
        status: 'exhausted',
        failure: {
          message: 'Tool execution failed.',
          tool: 'shell_execute',
          reason: 'Execution blocked by exhaustion guard for shell_execute.',
          guidance: 'Stop retrying this operation.',
        },
      }),
      tool_call_id: 'c5',
      name: 'shell_execute',
      status: 'exhausted',
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe('tool_done');
    expect((event!.data as ToolResultPayload).status).toBe('exhausted');
  });
});
