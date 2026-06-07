import React from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { useTheme } from "./theme";

interface StatsLineProps {
  status: StatusState;
  running: boolean;
  modelProvider?: string;
  modelName?: string;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export default function StatsLine({ status, running, modelProvider, modelName }: StatsLineProps) {
  const t = useTheme();
  const cachePct = status.cacheHitRate * 100;
  const cacheColor = cachePct > 50 ? t.success : cachePct > 20 ? t.warning : t.muted;
  const authLabel = status.authorization === "full_access" ? "完全" : "安全";
  const authColor = status.authorization === "full_access" ? t.warning : t.success;

  // 仅 DeepSeek 支持 thinking 强度配置和 prompt cache 指标
  const isDeepSeek = status.modelProvider === "deepseek";
  const showThink = isDeepSeek && !!status.thinkingMode;
  const showCache = isDeepSeek && status.totalTokens > 0;
  const showTokens = status.totalTokens > 0;

  return (
    <Box>
      <Text color={t.primary}>{status.modelName}</Text>
      {showThink && (
        <>
          <Text color={t.dim}> │ </Text>
          <Text color={t.success}>think: {status.thinkingMode}</Text>
        </>
      )}
      {showCache && (
        <>
          <Text color={t.dim}> │ </Text>
          <Text>
            <Text color={t.muted}>cache: </Text>
            <Text color={cacheColor}>{cachePct.toFixed(0)}%</Text>
          </Text>
        </>
      )}
      {showTokens && (
        <>
          <Text color={t.dim}> │ </Text>
          <Text>
            <Text color={t.muted}>tokens: </Text>
            <Text>{formatTokens(status.totalTokens)}</Text>
          </Text>
        </>
      )}
      <Text color={t.dim}> │ </Text>
      <Text color={authColor}>[{authLabel}]</Text>
      <Text color={t.dim}> {status.workspaceAccess === "read-only" ? "ro" : "rw"}</Text>
    </Box>
  );
}
