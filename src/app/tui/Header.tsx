import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./types";
import { darkTheme as t } from "./theme";
import { formatDuration } from "./StatusBar";

interface HeaderProps {
  status: StatusState;
  running: boolean;
  timerKey: number;
  error?: boolean;
  paused?: boolean;
}

type CatMood = "working" | "error" | "idle";

function catMood(running: boolean, error: boolean): CatMood {
  if (running) return "working";
  if (error) return "error";
  return "idle";
}

const CAT_LINES: Record<CatMood, [string, string, string]> = {
  working: ["  /\\_/\\  ", " ( ^ ^ ) ", "  > w <  "],
  error:   ["  /\\_/\\  ", " ( T T ) ", "  > . <  "],
  idle:    ["  /\\_/\\  ", " ( = = ) ", "  > ~ <  "],
};

function planLabel(status: StatusState): string {
  if (!status.plan) return "";
  const done = status.plan.steps.filter((s) => s.status === "completed").length;
  const total = status.plan.steps.length;
  const active = status.plan.steps.find((s) => s.status === "in_progress");
  return `Step ${done}/${total}${active ? `: ${active.step}` : ""}`;
}

export default function Header({ status, running, timerKey, error, paused }: HeaderProps) {
  const [elapsed, setElapsed] = useState(0);
  const prevTimerKeyRef = useRef(timerKey);

  useEffect(() => {
    // New run: reset elapsed and restart
    if (timerKey !== prevTimerKeyRef.current) {
      prevTimerKeyRef.current = timerKey;
      setElapsed(0);
    }

    if (!running || paused) {
      return; // timer stopped, keep current elapsed
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running, paused]);

  const mood = catMood(running, !!error);
  const [catTop, catMid, catBot] = CAT_LINES[mood];

  const authLabel = status.authorization === "full_access" ? "full" : "safe";
  const authColor = status.authorization === "full_access" ? t.warning : t.success;
  const rwLabel = status.workspaceAccess === "read-only" ? "ro" : "rw";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.primary}>{catTop}  </Text>
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
        <Text color={t.primary}>{catMid}  </Text>
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
        <Text color={t.primary}>{catBot}  </Text>
        <Text color={t.dim}>{process.cwd()}</Text>
      </Box>
    </Box>
  );
}
