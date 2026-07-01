import { describe, expect, test } from 'bun:test';
import {
  classifyExecutionFailure,
  type ExecutionJournalState,
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
});
