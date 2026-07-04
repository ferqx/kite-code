export interface ExecutionJournalEntry {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'applied' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
  fingerprint?: string;
  stderrDigest?: string;
}

export interface ExecutionJournalState {
  executionJournal: ExecutionJournalEntry[];
  exhaustedFingerprints: Record<string, true>;
}

export interface ExhaustionSignal {
  fingerprint: string;
  consecutiveFailures: number;
  maxFailures: number;
  suggestion: 'replan' | 'skip_step' | 'finalize';
  reason: string;
  suggestedAlternatives?: string[];
}

export function recordExecutionResult<T extends ExecutionJournalState>(
  state: T,
  result: {
    toolCallId: string;
    toolName: string;
    ok: boolean;
    stderr?: string;
    exitCode?: number;
    path?: string;
  },
): T {
  const errorCode = result.ok ? undefined : errorCodeFor(result);
  const fingerprint = result.ok
    ? undefined
    : failureFingerprint({
        toolName: result.toolName,
        errorCode: errorCode ?? 'ERROR',
        affectedPath: result.path,
      });
  const entry: ExecutionJournalEntry = {
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    status: result.ok ? 'applied' : 'failed',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    ...(errorCode ? { errorCode } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(result.stderr ? { stderrDigest: result.stderr.slice(0, 200) } : {}),
  };
  const executionJournal = [...state.executionJournal, entry].slice(-50);
  const next = { ...state, executionJournal };
  const failure = classifyExecutionFailure(next, {
    toolName: result.toolName,
    ok: result.ok,
    stderr: result.stderr,
    exitCode: result.exitCode,
    path: result.path,
  });
  if (failure.exhausted) {
    return {
      ...next,
      exhaustedFingerprints: {
        ...state.exhaustedFingerprints,
        [failure.fingerprint]: true,
      },
    };
  }
  return next;
}

export function classifyExecutionFailure(
  state: ExecutionJournalState,
  result: {
    toolName: string;
    ok: boolean;
    stderr?: string;
    exitCode?: number;
    path?: string;
  },
): { fingerprint: string; exhausted?: ExhaustionSignal } {
  const errorCode = result.ok ? 'OK' : errorCodeFor(result);
  const fingerprint = failureFingerprint({
    toolName: result.toolName,
    errorCode,
    affectedPath: result.path,
  });
  if (result.ok) return { fingerprint };
  const consecutive = countConsecutiveFailures(state.executionJournal, fingerprint);
  const maxFailures = maxFailuresFor(errorCode);
  if (consecutive >= maxFailures) {
    return {
      fingerprint,
      exhausted: {
        fingerprint,
        consecutiveFailures: consecutive,
        maxFailures,
        suggestion: result.toolName === 'shell_execute' ? 'skip_step' : 'replan',
        reason: `Repeated ${errorCode} failure reached limit ${maxFailures}.`,
        suggestedAlternatives: ['Continue another independent step', 'Safely finalize if blocked'],
      },
    };
  }
  return { fingerprint };
}

/** Count only consecutive failures with the same fingerprint from the tail of the journal.
 *  Stops at: success entry (no fingerprint), different fingerprint, or significant stderr change
 *  (indicating actual progress was made). */
function countConsecutiveFailures(journal: ExecutionJournalEntry[], fingerprint: string): number {
  let count = 0;
  let lastDigest: string | undefined;
  for (let i = journal.length - 1; i >= 0; i--) {
    const entry = journal[i]!;
    // Success or different error → chain broken
    if (entry.fingerprint !== fingerprint) break;
    // Same fingerprint but stderr changed significantly → progress was made, reset from here
    if (
      count > 0 &&
      lastDigest &&
      entry.stderrDigest &&
      entry.stderrDigest.slice(0, 100) !== lastDigest.slice(0, 100)
    ) {
      break;
    }
    lastDigest = entry.stderrDigest;
    count++;
  }
  return count;
}

export function failureFingerprint(input: {
  toolName: string;
  errorCode: string;
  affectedPath?: string;
}): string {
  return [input.toolName, input.errorCode, input.affectedPath ?? ''].join(':');
}

/** Check if any exhausted fingerprint matches this tool+path combination.
 *  Uses prefix+suffix matching because the stored fingerprint includes the original errorCode,
 *  while the preflight check runs before execution (errorCode unknown).
 *  Falls back to pathless prefix matching when the specific path doesn't match —
 *  some tool results don't include a path field, producing pathless fingerprints
 *  (e.g., `search_content:ERROR:`) that would be bypassed by path-specific preflight. */
export function isFingerprintExhausted(
  exhausted: Record<string, true>,
  toolName: string,
  affectedPath?: string,
): boolean {
  if (Object.keys(exhausted).length === 0) return false;
  const prefix = `${toolName}:`;
  if (!affectedPath) {
    return Object.keys(exhausted).some((fp) => fp.startsWith(prefix));
  }
  const suffix = `:${affectedPath}`;
  // Exact path match first, then fall back to pathless (prefix-only) match
  // to catch fingerprints where the stored path is empty (execution result
  // didn't include a path field).
  return Object.keys(exhausted).some(
    (fp) => fp.startsWith(prefix) && (fp.endsWith(suffix) || fp.endsWith(':')),
  );
}

export function errorCodeFor(result: { stderr?: string; exitCode?: number }): string {
  if (result.stderr?.includes('ENOENT') || result.stderr?.toLowerCase().includes('not found')) {
    return 'ENOENT';
  }
  if (result.stderr?.toLowerCase().includes('timeout') || result.exitCode === 124) {
    return 'TIMEOUT';
  }
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return 'EXIT_NONZERO';
  return 'ERROR';
}

export function maxFailuresFor(errorCode: string): number {
  if (errorCode === 'ENOENT') return 3;
  if (errorCode === 'EXIT_NONZERO') return 5;
  if (errorCode === 'TIMEOUT') return 10;
  return 3;
}
