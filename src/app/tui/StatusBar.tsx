import { Box, Text, useStdout } from 'ink';
import { useEffect, useRef, useState } from 'react';
import {
  formatRunStatusLine,
  type RunStatusSnapshot,
  type RunStatusTone,
  WORKING_GRADIENT,
} from './run-status';
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

/**
 * Rotating arc spinner — 4-frame clockwise sweep @ 100 ms/frame.
 * Distinct from the Braille spinner used by shells and subagents.
 * Inspired by macOS / cli-spinners "arc" variant.
 */
const ARC = ['◜', '◝', '◞', '◟'];

// ── color gradient animation ──

/** Linear interpolation between two hex colors */
function interpolateHex(a: string, c2: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(c2.slice(1, 3), 16);
  const bg = parseInt(c2.slice(3, 5), 16);
  const bb = parseInt(c2.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const blue = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
}

/** Current color on the working gradient at a given progress position */
function gradientColor(progress: number): string {
  const len = WORKING_GRADIENT.length;
  const idx = Math.floor(progress) % len;
  const frac = progress - Math.floor(progress);
  const a = WORKING_GRADIENT[idx]!;
  const b = WORKING_GRADIENT[(idx + 1) % len]!;
  return interpolateHex(a, b, frac);
}

export default function StatusBar({ status, runStatus, running }: StatusBarProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [liveElapsedMs, setLiveElapsedMs] = useState(runStatus?.elapsedMs ?? 0);
  const [colorProgress, setColorProgress] = useState(0);

  // Refs for timer-stable values — updated without restarting timers
  const startedAtRef = useRef(Date.now());
  const tickRef = useRef(0);

  // Sync elapsed baseline from prop → ref only (no re-render triggered)
  // This fires on every App render, but only writes to a ref — cheap.
  useEffect(() => {
    if (running && runStatus?.elapsedMs != null) {
      startedAtRef.current = Date.now() - runStatus.elapsedMs;
    }
  });

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
      setColorProgress(0);
      setLiveElapsedMs(0);
      tickRef.current = 0;
      return;
    }

    const initialElapsed = runStatus?.elapsedMs ?? 0;
    startedAtRef.current = Date.now() - initialElapsed;
    setLiveElapsedMs(initialElapsed);
    tickRef.current = 0;

    // Single 100 ms tick drives all animations.
    // React 18 batches the 3 state updates into 1 render.
    const timer = setInterval(() => {
      tickRef.current++;
      setLiveElapsedMs(Date.now() - startedAtRef.current);
      // Spinner: advance every tick → 400 ms full rotation
      setSpinnerIdx((prev) => (prev + 1) % ARC.length);
      setColorProgress((prev) => (prev + 0.08) % (WORKING_GRADIENT.length - 1));
    }, 100);

    return () => clearInterval(timer);
  }, [running]);

  if (!running && status.phase !== 'planning') return null;

  const idlePlanMode = !running && status.phase === 'planning';
  const cols = stdout?.columns ?? 80;
  const liveRunStatus = runStatus ? { ...runStatus, elapsedMs: liveElapsedMs } : undefined;
  const statusLine = liveRunStatus ? formatRunStatusLine(liveRunStatus, cols) : '';

  // Color: animated gradient during working phase, static tones otherwise
  const isWorking = liveRunStatus?.phase === 'working' && running;
  const statusColor = isWorking
    ? gradientColor(colorProgress)
    : liveRunStatus
      ? runStatusColor(t, liveRunStatus.tone)
      : t.primary;

  return (
    <Box>
      {running ? (
        <Text color={statusColor}>{ARC[spinnerIdx]} </Text>
      ) : (
        <Text color={t.warning}>* </Text>
      )}
      <Text color={idlePlanMode ? t.muted : statusColor}>
        {idlePlanMode ? 'Shift+Tab to exit - describe your task' : statusLine}
      </Text>
    </Box>
  );
}
