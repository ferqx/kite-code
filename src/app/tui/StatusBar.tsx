import { Box, Text, useStdout } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { formatRunStatusLine, type RunStatusSnapshot, type RunStatusTone } from './run-status';
import { type Theme, useTheme } from './theme';
import type { StatusState } from './types';

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

export function runStatusColor(theme: Theme, tone: RunStatusTone): string {
  return theme[tone];
}

// ── spinner ──

/** Flowing dot — 6-frame ping-pong @ 200 ms/frame (1200 ms round trip). */
const SPINNER = ['●···', '·●··', '··●·', '···●', '··●·', '·●··'];

export default function StatusBar({ status, runStatus, running, timerKey }: StatusBarProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsedMs, setLiveElapsedMs] = useState(runStatus?.elapsedMs ?? 0);

  // Refs for timer-stable values — updated without restarting timers
  const startedAtRef = useRef(Date.now());
  const tickRef = useRef(0);

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
      tickRef.current = 0;
      return;
    }

    const initialElapsed = runStatus?.elapsedMs ?? 0;
    startedAtRef.current = Date.now() - initialElapsed;
    setLiveElapsedMs(initialElapsed);
    tickRef.current = 0;

    // Single 200 ms tick drives all animations.
    // React 18 batches the 2 state updates into 1 render.
    const timer = setInterval(() => {
      tickRef.current++;
      setLiveElapsedMs(Date.now() - startedAtRef.current);
      // Spinner: advance every tick → 1200 ms full ping-pong
      setSpinnerIdx((prev) => (prev + 1) % SPINNER.length);
    }, 200);

    return () => clearInterval(timer);
  }, [running, timerKey]);

  if (!running && status.phase !== 'planning') return null;

  const idlePlanMode = !running && status.phase === 'planning';
  const cols = stdout?.columns ?? 80;
  const liveRunStatus = runStatus ? { ...runStatus, elapsedMs: liveElapsedMs } : undefined;
  const statusLine = liveRunStatus ? formatRunStatusLine(liveRunStatus, cols) : '';

  // Color: use theme tone color consistently across all phases
  const statusColor = liveRunStatus ? runStatusColor(t, liveRunStatus.tone) : t.primary;

  return (
    <Box>
      {running ? (
        <Text color={statusColor}>{SPINNER[spinnerIdx]} </Text>
      ) : (
        <Text color={t.warning}>* </Text>
      )}
      <Text color={idlePlanMode ? t.muted : statusColor}>
        {idlePlanMode ? 'Shift+Tab to exit - describe your task' : statusLine}
      </Text>
    </Box>
  );
}
