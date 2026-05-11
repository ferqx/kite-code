import React from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";

interface StatusBarProps {
  status: StatusState;
}

export default function StatusBar({ status }: StatusBarProps) {
  const planProgress = status.plan
    ? `${status.plan.steps.filter((s) => s.status === "completed").length}/${status.plan.steps.length}`
    : "—";

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box gap={2}>
        <Text color={t.primary}>Phase: {status.phase}</Text>
        <Text color={t.muted}>|</Text>
        <Text>Plan: {planProgress}</Text>
        <Text color={t.muted}>|</Text>
        <Text color={status.authorization === "full_access" ? t.warning : t.success}>
          {status.authorization}
        </Text>
      </Box>
      <Box gap={2}>
        <Text>
          Cache:{" "}
          <Text color={status.cacheHitRate > 50 ? t.success : t.muted}>
            {status.cacheHitRate.toFixed(0)}%
          </Text>
        </Text>
        <Text>
          Tokens: {status.totalTokens.toLocaleString()}
        </Text>
      </Box>
    </Box>
  );
}
