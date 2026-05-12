import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";

interface StatusBarProps {
  status: StatusState;
  thinkingVisible: boolean;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function StatusBar({ status, thinkingVisible }: StatusBarProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const planLine = status.plan
    ? `Step ${status.plan.steps.filter((s) => s.status === "completed").length}/${status.plan.steps.length}: ${status.plan.steps.find((s) => s.status === "in_progress")?.step ?? status.plan.steps[0]?.step ?? ""}`
    : status.currentNode ?? "—";

  const phaseIcon = status.phase === "planning" ? "○" : "●";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.primary}>
          {phaseIcon} {status.phase === "planning" ? "Planning" : "Building"}
        </Text>
        <Text color={t.muted}> │ </Text>
        <Text>{planLine}</Text>
      </Box>
      <Box>
        <Text color={t.muted}>│</Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Box gap={2}>
          <Text>{status.modelName}</Text>
          <Text color={t.muted}>│</Text>
          <Text color={thinkingVisible ? t.success : t.muted}>{status.thinkingMode}</Text>
          <Text color={t.muted}>│</Text>
          <Text>
            Cache:{" "}
            <Text color={status.cacheHitRate > 50 ? t.success : t.muted}>
              {status.cacheHitRate.toFixed(0)}%
            </Text>
          </Text>
          <Text color={t.muted}>│</Text>
          <Text>Tokens: {status.totalTokens.toLocaleString()}</Text>
          <Text color={t.muted}>│</Text>
          <Text>{formatDuration(elapsed)}</Text>
        </Box>
        <Box gap={2}>
          <Text color={status.authorization === "full_access" ? t.warning : t.success}>
            {status.authorization === "full_access" ? "full" : "default"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
