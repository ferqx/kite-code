import React from "react";
import { Box, Text, useInput } from "ink";
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
  // Only consume keyboard events when sidebar is focused
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
          sessions.map((s, i) => {
            const isActive = s.threadId === activeSessionId;
            const isSelected = i === sidebarSelection;
            const prefix = isActive ? "\u25CF" : "\u25CB"; // ● or ○
            let status = " ";
            if (s.running) status = "\u23F3"; // ⏳
            if (s.pendingInterrupt) status = "\u26A0"; // ⚠
            const displayName = s.threadId === s.name
              ? s.threadId.slice(0, 10)
              : s.name;
            const color = isActive ? t.primary : (isSelected ? t.muted : t.dim);
            return (
              <Text key={s.threadId} color={color}>
                {prefix} {status} {displayName}
              </Text>
            );
          })
        )}
      </Box>

      {/* ── Plan ── */}
      {plan && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={t.primary}>Plan</Text>
          <Text color={t.dim}>─────────</Text>
          {plan.steps.map((step) => {
            const icon = step.status === "completed" ? "\u2713"
              : step.status === "in_progress" ? "\u25CC"
              : "\u25CB";
            return (
              <Text key={step.step} color={t.muted}>{icon} {step.step}</Text>
            );
          })}
        </Box>
      )}

      {/* ── Help ── */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={t.dim}>Tab 切换焦点</Text>
        <Text color={t.dim}>{'\u2191\u2193'} 浏览</Text>
        <Text color={t.dim}>Enter 切换</Text>
        <Text color={t.dim}>/new 新建</Text>
      </Box>
    </Box>
  );
}
