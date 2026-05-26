import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface StatusBarProps {
  status: StatusState;
  thinkingVisible: boolean;
  timerKey: number;
  running: boolean;
  compacting: boolean;
}

function planLabel(status: StatusState): string {
  if (!status.plan) return status.currentNode ?? "—";
  const done = status.plan.steps.filter((s) => s.status === "completed").length;
  const total = status.plan.steps.length;
  const active = status.plan.steps.find((s) => s.status === "in_progress");
  return `Step ${done}/${total}${active ? `: ${active.step}` : ""}`;
}

export default function StatusBar({ status, thinkingVisible, timerKey, running, compacting }: StatusBarProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);

  const phaseIcon = status.phase === "planning" ? "○" : "●";
  const phaseColor = status.phase === "planning" ? t.warning : t.success;

  const cacheColor = status.cacheHitRate > 50 ? t.success : status.cacheHitRate > 20 ? t.warning : t.muted;
  const authColor = status.authorization === "full_access" ? t.warning : t.success;

  return (
    <Box flexDirection="column">
      {/* Compacting indicator */}
      {compacting && (
        <Box>
          <Text color={t.warning}>⏳ Compacting...</Text>
        </Box>
      )}

      {/* Row 1 — phase + progress */}
      <Box>
        <Text color={phaseColor}>{phaseIcon} </Text>
        <Text bold color={t.primary}>
          {status.phase === "planning" ? "Planning" : "Building"}
        </Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.muted}>{planLabel(status)}</Text>
      </Box>

      {/* Row 2 — stats */}
      <Box gap={2}>
        <Text color={t.muted}>
          <Text color={t.primary}>{status.modelName}</Text>
        </Text>
        <Text color={t.dim}>│</Text>
        <Text color={thinkingVisible ? t.success : t.muted}>
          think: {status.thinkingMode}
        </Text>
        <Text color={t.dim}>│</Text>
        <Text>
          <Text color={t.muted}>cache: </Text>
          <Text color={cacheColor}>{`${status.cacheHitRate.toFixed(0)}%`}</Text>
        </Text>
        <Text color={t.dim}>│</Text>
        <Text>
          <Text color={t.muted}>tokens: </Text>
          <Text>{status.totalTokens.toLocaleString()}</Text>
        </Text>
        <Text color={t.dim}>│</Text>
        {running && <Text color={t.primary}>{formatDuration(elapsed)}</Text>}
        {running && <Text color={t.dim}>│</Text>}
        <Text color={authColor}>
          [{status.authorization === "full_access" ? "full" : "safe"}]
        </Text>
        <Text color={t.dim}>
          {status.workspaceAccess === "read-only" ? " ro" : " rw"}
        </Text>
      </Box>
    </Box>
  );
}
