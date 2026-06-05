import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { useTheme } from "./theme";
import { SPINNER } from "./components/render-utils";

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
}

export default function StatusBar({ status, running, compacting, timerKey }: StatusBarProps) {
  const t = useTheme();
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  useEffect(() => {
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

  return (
    <Box>
      {running && (
        <Text color={t.primary}>{SPINNER[spinnerIdx]} </Text>
      )}
      <Text color={phaseColor}>{phaseIcon} </Text>
      <Text bold color={t.primary}>{phaseLabel}</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.muted}>{planLabel()}</Text>
    </Box>
  );
}
