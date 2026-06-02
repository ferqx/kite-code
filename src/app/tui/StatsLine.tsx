import React from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { useTheme } from "./theme";

interface StatsLineProps {
  status: StatusState;
  thinkingVisible: boolean;
  running: boolean;
  elapsed: number; // seconds, 0 when not running
  modelProvider?: string;
  modelName?: string;
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

/** 估算 token 成本（价格写死常见模型，仅展示用）/ Estimate token cost for display only */
function estimateCost(provider: string | undefined, modelName: string | undefined, totalTokens: number): string | null {
  if (!provider || !modelName || totalTokens <= 0) return null;
  // 输入/输出混合平均价（美元/1K tokens），用于粗略估算
  // Blended input/output average price (USD per 1K tokens) for rough estimation
  const rates: Record<string, number> = {
    "deepseek-chat": 0.00027,      // DeepSeek V3: $0.27/M input, $1.10/M output → avg ~$0.27/K
    "deepseek-reasoner": 0.00055,   // DeepSeek R1: $0.55/M input, $2.19/M output → avg ~$0.55/K
    "claude-sonnet-4-6": 0.006,     // Claude Sonnet: $3/M input, $15/M output → avg ~$6/K
    "claude-opus-4-6": 0.020,       // Claude Opus: $15/M input, $75/M output → avg ~$20/K
    "claude-haiku-4-5": 0.002,      // Claude Haiku: $1/M input, $5/M output → avg ~$2/K
    "gpt-4o": 0.005,                // GPT-4o: $2.5/M input, $10/M output → avg ~$5/K
    "gpt-4o-mini": 0.0003,          // GPT-4o mini: $0.15/M input, $0.6/M output → avg ~$0.3/K
    "gpt-4.1": 0.004,               // GPT-4.1: $2/M input, $8/M output → avg ~$4/K
    "gpt-4.1-mini": 0.0008,         // GPT-4.1 mini: $0.4/M input, $1.6/M output → avg ~$0.8/K
    "gpt-4.1-nano": 0.0002,         // GPT-4.1 nano: $0.1/M input, $0.4/M output → avg ~$0.2/K
    "gemini-2.5-flash": 0.0003,     // Gemini Flash: cheap
    "gemini-2.5-pro": 0.003,        // Gemini Pro: moderate
  };
  // 尝试精确匹配或前缀匹配 / Try exact match then prefix match
  const rate = rates[modelName] ?? rates[`${modelName}-${provider}`] ?? null;
  if (rate === null) return null;
  const cost = (totalTokens / 1000) * rate;
  if (cost >= 0.01) return `~$${cost.toFixed(2)}`;
  if (cost >= 0.001) return `~$${cost.toFixed(3)}`;
  return "<$0.001";
}

export default function StatsLine({ status, thinkingVisible, running, elapsed, modelProvider, modelName }: StatsLineProps) {
  const t = useTheme();
  const cacheColor = status.cacheHitRate > 50 ? t.success : status.cacheHitRate > 20 ? t.warning : t.muted;
  const authLabel = status.authorization === "full_access" ? "完全" : "安全";
  const authColor = status.authorization === "full_access" ? t.warning : t.success;
  const thinkColor = thinkingVisible ? t.success : t.muted;
  const costEstimate = estimateCost(modelProvider, status.modelName, status.totalTokens);

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
        {costEstimate && (
          <>
            <Text> </Text>
            <Text color={t.muted}>{costEstimate}</Text>
          </>
        )}
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
