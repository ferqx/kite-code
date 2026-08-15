import { Box, Text, useStdout } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { type MessageKey, useI18n } from './i18n';
import { formatRunStatusLine, type RunStatusSnapshot, type RunStatusTone } from './run-status';
import { type Theme, useTheme } from './theme';
import type { StatusState } from './types';

const RUN_VERB_KEYS: Record<string, MessageKey> = {
  Thinking: 'status.thinking',
  Planning: 'status.planning',
  Working: 'status.working',
  Finishing: 'status.finishing',
  Retrying: 'status.retrying',
  Waiting: 'status.waiting',
  Asking: 'status.asking',
  'Awaiting approval': 'status.awaitingApproval',
  'Auto-reviewing': 'status.autoReviewing',
  'Review queued': 'status.reviewQueued',
  Delegating: 'status.delegating',
  Queued: 'status.queued',
  Running: 'status.running',
  Inspecting: 'status.inspecting',
  Locating: 'status.locating',
  Changing: 'status.changing',
  'Updating plan': 'status.updatingPlan',
  'Preparing context': 'status.preparingContext',
  'Summarizing context': 'status.summarizingContext',
  'Validating context': 'status.validatingContext',
};

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface StatusBarProps {
  status: StatusState;
  runStatus?: RunStatusSnapshot;
  running: boolean;
  timerKey: number;
}

export function runStatusColor(
  theme: Theme,
  tone: RunStatusTone,
  phase?: RunStatusSnapshot['phase'],
): string {
  return phase === 'working' ? theme.primary : theme[tone];
}

// ── spinner ──
// Variable-duration frames: breathes slower at ★ peak, faster at edges
const SPINNER: [string, number][] = [
  ['·', 150],
  ['⋄', 240],
  ['⋆', 180],
  ['✧', 200],
  ['✦', 240],
  ['✧', 200],
  ['⋆', 180],
  ['⋄', 240],
];

export default function StatusBar({ runStatus, running, timerKey }: StatusBarProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const { stdout } = useStdout();
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsedMs, setLiveElapsedMs] = useState(runStatus?.elapsedMs ?? 0);

  // Refs for timer-stable values — updated without restarting timers
  const startedAtRef = useRef(Date.now());

  // Sync elapsed baseline from prop -> ref only when the parent-provided
  // elapsed value changes. Internal timer renders must not reset the baseline.
  useEffect(() => {
    if (running && runStatus?.elapsedMs != null) {
      startedAtRef.current = Date.now() - runStatus.elapsedMs;
    }
  }, [running, runStatus?.elapsedMs]);

  // Reset spinner on mount
  useEffect(() => {
    setSpinnerIdx(0);
  }, []);

  // Single animation timer — depends only on `running`.
  // Tool output re-renders do NOT restart this timer.
  // runStatus?.elapsedMs is intentionally excluded: synced via startedAtRef instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — timer must not restart on prop changes
  useEffect(() => {
    if (!running) {
      setSpinnerIdx(0);
      setLiveElapsedMs(0);
      return;
    }

    const initialElapsed = runStatus?.elapsedMs ?? 0;
    startedAtRef.current = Date.now() - initialElapsed;
    setLiveElapsedMs(initialElapsed);

    // Elapsed timer — fixed 200 ms interval
    const elapsedTimer = setInterval(() => {
      setLiveElapsedMs(Date.now() - startedAtRef.current);
    }, 200);

    // Spinner — recursive setTimeout with per-frame duration
    let spinnerTimer: ReturnType<typeof setTimeout>;
    const scheduleNext = (idx: number) => {
      const [, ms] = SPINNER[idx]!;
      spinnerTimer = setTimeout(() => {
        const next = (idx + 1) % SPINNER.length;
        setSpinnerIdx(next);
        scheduleNext(next);
      }, ms);
    };
    setSpinnerIdx(0);
    scheduleNext(0);

    return () => {
      clearInterval(elapsedTimer);
      clearTimeout(spinnerTimer);
    };
  }, [running, timerKey]);

  if (!running) return null;

  const cols = stdout?.columns ?? 80;
  const liveRunStatus = runStatus ? { ...runStatus, elapsedMs: liveElapsedMs } : undefined;
  const verbKey = liveRunStatus ? RUN_VERB_KEYS[liveRunStatus.verb] : undefined;
  const localizedRunStatus = liveRunStatus
    ? { ...liveRunStatus, verb: verbKey ? translate(verbKey) : liveRunStatus.verb }
    : undefined;
  const statusLine = localizedRunStatus
    ? formatRunStatusLine(localizedRunStatus, cols, translate('status.working'))
    : '';

  // Working stays on the theme primary color, regardless of the active tool.
  const statusColor = liveRunStatus
    ? runStatusColor(t, liveRunStatus.tone, liveRunStatus.phase)
    : t.primary;

  return (
    <Box>
      <Text color={statusColor}>{SPINNER[spinnerIdx]![0]} </Text>
      <Text color={statusColor}>{statusLine}</Text>
    </Box>
  );
}
