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
  const matching = state.executionJournal.filter((entry) => entry.fingerprint === fingerprint);
  const maxFailures = maxFailuresFor(errorCode);
  if (matching.length >= maxFailures) {
    return {
      fingerprint,
      exhausted: {
        fingerprint,
        consecutiveFailures: matching.length,
        maxFailures,
        suggestion: result.toolName === 'shell_execute' ? 'skip_step' : 'replan',
        reason: `Repeated ${errorCode} failure reached limit ${maxFailures}.`,
        suggestedAlternatives: ['Continue another independent step', 'Safely finalize if blocked'],
      },
    };
  }
  return { fingerprint };
}

function failureFingerprint(input: {
  toolName: string;
  errorCode: string;
  affectedPath?: string;
}): string {
  return [input.toolName, input.errorCode, input.affectedPath ?? ''].join(':');
}

function errorCodeFor(result: { stderr?: string; exitCode?: number }): string {
  if (result.stderr?.includes('ENOENT') || result.stderr?.toLowerCase().includes('not found')) {
    return 'ENOENT';
  }
  if (result.stderr?.toLowerCase().includes('timeout') || result.exitCode === 124) {
    return 'TIMEOUT';
  }
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return 'EXIT_NONZERO';
  return 'ERROR';
}

function maxFailuresFor(errorCode: string): number {
  if (errorCode === 'ENOENT') return 3;
  if (errorCode === 'EXIT_NONZERO') return 5;
  if (errorCode === 'TIMEOUT') return 10;
  return 3;
}
