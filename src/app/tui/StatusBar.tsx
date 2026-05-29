import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { useTheme } from "./theme";

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface StatusBarProps {
  status: StatusState;
  running: boolean;
  compacting: boolean;
  timerKey: number;
  onTick: (elapsed: number) => void;
  thinkingVisible?: boolean;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function StatusBar({ status, running, compacting, timerKey, onTick }: StatusBarProps) {
  const t = useTheme();
  const [elapsed, setElapsed] = useState(0);
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  useEffect(() => {
    setElapsed(0);
    setSpinnerIdx(0);
  }, [timerKey]);

  useEffect(() => {
    if (!running) {
      setSpinnerIdx(0);
      return;
    }
    const timer = setInterval(() => setSpinnerIdx((prev) => (prev + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);

  useEffect(() => {
    onTick(elapsed);
  }, [elapsed, onTick]);

  const phaseIcon = status.phase === "planning" ? "○" : "●";
  const phaseColor = status.phase === "planning" ? t.warning : t.success;
  const phaseLabel = status.phase === "planning" ? "Planning" : "Building";

  function planLabel(): string {
    if (compacting) return "⟳ Compacting...";
    if (!status.plan) return status.currentNode ?? "";
    const done = status.plan.steps.filter((s) => s.status === "completed").length;
    const total = status.plan.steps.length;
    const active = status.plan.steps.find((s) => s.status === "in_progress");
    return `Step ${done}/${total}${active ? `: ${active.step}` : ""}`;
  }

  const cachePct = `${status.cacheHitRate.toFixed(0)}%`;
  const tokens = status.totalTokens.toLocaleString();
  const elapsedStr = formatDuration(elapsed);

  return (
    <Box>
      {running && (
        <Text color={t.primary}>{SPINNER[spinnerIdx]} </Text>
      )}
      <Text color={phaseColor}>{phaseIcon} </Text>
      <Text bold color={t.primary}>{phaseLabel}</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.muted}>{planLabel()}</Text>
      <Text color={t.dim}>  </Text>
      <Text color={t.muted}>{elapsedStr}</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.muted}>{cachePct}</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.muted}>{tokens}</Text>
    </Box>
  );
}
