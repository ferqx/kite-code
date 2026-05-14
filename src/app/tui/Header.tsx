import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";

interface HeaderProps {
  status: StatusState;
  running: boolean;
  timerKey: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function planLabel(status: StatusState): string {
  if (!status.plan) return "";
  const done = status.plan.steps.filter((s) => s.status === "completed").length;
  const total = status.plan.steps.length;
  const active = status.plan.steps.find((s) => s.status === "in_progress");
  return `Step ${done}/${total}${active ? `: ${active.step}` : ""}`;
}

export default function Header({ status, running, timerKey }: HeaderProps) {
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

  const authLabel = status.authorization === "full_access" ? "full" : "safe";
  const authColor = status.authorization === "full_access" ? t.warning : t.success;
  const rwLabel = status.workspaceAccess === "read-only" ? "ro" : "rw";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.primary}>
          {" ▐▛███▜▌   "}
        </Text>
        <Text bold color={t.primary}>
          OpenPX
        </Text>
        {running && (
          <Text color={t.muted}>
            {"  "}{formatDuration(elapsed)}
          </Text>
        )}
      </Box>
      <Box>
        <Text color={t.primary}>
          {"▝▜█████▛▘  "}
        </Text>
        <Text color={t.muted}>{status.modelName}</Text>
        <Text color={t.dim}> · </Text>
        <Text color={authColor}>[{authLabel}]</Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.muted}>{rwLabel}</Text>
        <Text color={t.dim}> · </Text>
        <Text color={status.thinkingMode === "max" ? t.success : t.muted}>
          think:{status.thinkingMode}
        </Text>
        {running && status.plan && (
          <>
            <Text color={t.dim}> · </Text>
            <Text color={t.warning}>{planLabel(status)}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color={t.primary}>
          {"  ▘▘ ▝▝    "}
        </Text>
        <Text color={t.dim}>{process.cwd()}</Text>
      </Box>
    </Box>
  );
}
