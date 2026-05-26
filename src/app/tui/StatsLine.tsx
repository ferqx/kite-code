import React from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { useTheme } from "./theme";

interface StatsLineProps {
  status: StatusState;
  thinkingVisible: boolean;
  running: boolean;
  elapsed: number; // seconds, 0 when not running
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function StatsLine({ status, thinkingVisible, running, elapsed }: StatsLineProps) {
  const t = useTheme();
  const cacheColor = status.cacheHitRate > 50 ? t.success : status.cacheHitRate > 20 ? t.warning : t.muted;
  const authLabel = status.authorization === "full_access" ? "完全" : "安全";
  const authColor = status.authorization === "full_access" ? t.warning : t.success;
  const thinkColor = thinkingVisible ? t.success : t.muted;

  return (
    <Box>
      <Text color={t.primary}>{status.modelName}</Text>
      <Text color={t.dim}> │ </Text>
      <Text color={thinkColor}>think: {status.thinkingMode}</Text>
      <Text color={t.dim}> │ </Text>
      <Text>
        <Text color={t.muted}>cache: </Text>
        <Text color={cacheColor}>{status.cacheHitRate.toFixed(0)}%</Text>
      </Text>
      <Text color={t.dim}> │ </Text>
      <Text>
        <Text color={t.muted}>tokens: </Text>
        <Text>{formatTokens(status.totalTokens)}</Text>
      </Text>
      {running && (
        <>
          <Text color={t.dim}> │ </Text>
          <Text color={t.primary}>{formatDuration(elapsed)}</Text>
        </>
      )}
      <Text color={t.dim}> │ </Text>
      <Text color={authColor}>[{authLabel}]</Text>
      <Text color={t.dim}> {status.workspaceAccess === "read-only" ? "ro" : "rw"}</Text>
    </Box>
  );
}
