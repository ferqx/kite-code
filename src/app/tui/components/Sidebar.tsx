import React, { useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { SessionSnapshot } from "../types";
import { darkTheme as t } from "../theme";

interface SidebarProps {
  sessions: SessionSnapshot[];
  activeSessionId: string | null;
  focus: "input" | "sidebar";
  sidebarSelection: number;
  plan: import("@/protocol/events").AgentPlan | null;
  onSwitch: (threadId: string) => void;
  onNavigate: (direction: "up" | "down") => void;
  onNew: () => void;
}

const WIDTH = 20;

export default function Sidebar({ sessions, activeSessionId, focus, sidebarSelection, plan, onSwitch, onNavigate, onNew }: SidebarProps) {
  const { stdout } = useStdout();
  const termRows = (stdout?.rows as number) ?? process.stdout.rows ?? 30;

  // Estimate available lines for session list based on terminal height.
  // Reserve: sessions header(2) + plan section(0~N) + sidebar border(2) + other UI chrome(~6)
  const planLines = plan ? 2 + plan.steps.length : 0;
  const maxSessionRows = useMemo(() => {
    const reserved = 2 + planLines + 2 + 6;
    return Math.max(3, termRows - reserved);
  }, [termRows, planLines]);

  // Virtual window: show a slice of sessions centered on sidebarSelection.
  const { visibleSlice, aboveHidden, belowHidden, sliceStartIndex } = useMemo(() => {
    if (sessions.length <= maxSessionRows) {
      return { visibleSlice: sessions, aboveHidden: 0, belowHidden: 0, sliceStartIndex: 0 };
    }
    // Keep selection in view; bias: half window above, half below
    const half = Math.floor(maxSessionRows / 2);
    let start = sidebarSelection - half;
    if (start < 0) start = 0;
    let end = start + maxSessionRows;
    if (end > sessions.length) { end = sessions.length; start = Math.max(0, end - maxSessionRows); }
    return {
      visibleSlice: sessions.slice(start, end),
      aboveHidden: start,
      belowHidden: sessions.length - end,
      sliceStartIndex: start,
    };
  }, [sessions, maxSessionRows, sidebarSelection]);

  useInput((_input, key) => {
    if (focus !== "sidebar") return;
    if (key.upArrow) { onNavigate("up"); return; }
    if (key.downArrow) { onNavigate("down"); return; }
    if (key.return) {
      const selected = sessions[sidebarSelection];
      if (selected) onSwitch(selected.threadId);
      return;
    }
  });

  return (
    <Box width={WIDTH} flexDirection="column" borderStyle="single" borderColor={t.dim} paddingX={1}>
      {/* ── Sessions ── */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={t.primary}>Sessions</Text>
        <Text color={t.dim}>─────────</Text>
        {sessions.length === 0 ? (
          <Text color={t.muted}>No sessions</Text>
        ) : (
          <>
            {aboveHidden > 0 && (
              <Text color={t.dim} wrap="truncate">↑ {aboveHidden} more</Text>
            )}
            {visibleSlice.map((s, vi) => {
              const i = sliceStartIndex + vi;
              const isActive = s.threadId === activeSessionId;
              const isSelected = i === sidebarSelection;
              const prefix = isActive ? "●" : "○"; // ● or ○
              let status = " ";
              if (s.running) status = "⏳"; // ⏳
              if (s.pendingInterrupt) status = "⚠"; // ⚠
              const rawName = s.threadId === s.name
                ? s.threadId.slice(0, 10)
                : s.name;
              // Max name length: usableWidth(16) - prefix(1) - spaces(2) - status(1) = 12
              const maxNameLen = 12;
              const displayName = rawName.length > maxNameLen
                ? rawName.slice(0, maxNameLen - 1) + "…"
                : rawName;
              const color = isActive ? t.primary : (isSelected ? t.muted : t.dim);
              return (
                <Text key={s.threadId} color={color} wrap="truncate">
                  {prefix} {status} {displayName}
                </Text>
              );
            })}
            {belowHidden > 0 && (
              <Text color={t.dim} wrap="truncate">↓ {belowHidden} more</Text>
            )}
          </>
        )}
      </Box>

      {/* ── Plan ── */}
      {plan && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={t.primary}>Plan</Text>
          <Text color={t.dim}>─────────</Text>
          {plan.steps.map((step) => {
            const icon = step.status === "completed" ? "✓"
              : step.status === "in_progress" ? "◌"
              : "○";
            return (
              <Text key={step.step} color={t.muted}>{icon} {step.step}</Text>
            );
          })}
        </Box>
      )}

    </Box>
  );
}
