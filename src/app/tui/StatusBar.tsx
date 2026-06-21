import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { SPINNER } from './components/render-utils';
import { useTheme } from './theme';
import type { StatusState } from './types';

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDelay(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

interface StatusBarProps {
  status: StatusState;
  running: boolean;
  timerKey: number;
}

export default function StatusBar({ status, running }: StatusBarProps) {
  const t = useTheme();
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  useEffect(() => {
    setSpinnerIdx(0);
  }, []);

  useEffect(() => {
    if (!running) {
      setSpinnerIdx(0);
      return;
    }
    const timer = setInterval(() => setSpinnerIdx((prev) => (prev + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [running]);

  const phaseIcon = status.phase === 'planning' ? '○' : '●';
  const phaseColor = status.phase === 'planning' ? t.warning : t.success;
  const phaseLabel = status.phase === 'planning' ? 'Planning' : 'Building';

  function planLabel(): string {
    if (!status.plan || status.plan.status === 'completed') return status.currentNode ?? '';
    const done = status.plan.steps.filter((s) => s.status === 'completed').length;
    const total = status.plan.steps.length;
    const active = status.plan.steps.find((s) => s.status === 'in_progress');
    return `Step ${done}/${total}${active ? `: ${active.step}` : ''}`;
  }

  // 方案模式 idle 时也显示状态行，给用户持续的模式感知
  // Show status bar when idle in plan mode for persistent mode awareness
  if (!running && status.phase !== 'planning') return null;

  const idlePlanMode = !running && status.phase === 'planning';
  const retry = status.retryState;

  return (
    <Box>
      {running ? (
        <Text color={t.primary}>{SPINNER[spinnerIdx]} </Text>
      ) : (
        <Text color={t.warning}>○ </Text>
      )}
      <Text color={phaseColor}>{phaseIcon} </Text>
      <Text bold color={t.primary}>
        {phaseLabel}
      </Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.muted}>
        {idlePlanMode ? 'Shift+Tab to exit · describe your task' : planLabel()}
      </Text>
      {retry && (
        <>
          <Text color={t.dim}> ·</Text>
          <Text color={t.warning}>
            ⟳ Retry {retry.attempt}
            {retry.maxAttempts > 0 ? `/${retry.maxAttempts}` : ''} ({fmtDelay(retry.delayMs)})
          </Text>
        </>
      )}
    </Box>
  );
}
