import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import type { SubAgentRole } from "@/protocol/events";
import { useTheme } from "../theme";
import MarkdownBlock from "./MarkdownBlock";

function roleIcon(role: SubAgentRole): string {
  switch (role) {
    case "explore": return "🔍";
    case "code": return "🔧";
    case "review": return "👁";
    default: return "•";
  }
}

function roleLabel(role: SubAgentRole): string {
  switch (role) {
    case "explore": return "Explore";
    case "code": return "Code";
    case "review": return "Review";
    default: return role;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/** Extract human-readable label from tool args */
function toolArgsLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
    case "edit_file":
    case "write_file": {
      const p = args.path;
      return typeof p === "string" ? p.replace(/^.*[/\\]/, "").slice(-50) : "";
    }
    case "shell_execute":
    case "bash": {
      const c = args.command;
      return typeof c === "string" ? c.slice(0, 80) : "";
    }
    case "grep": {
      const q = args.pattern ?? args.query;
      return typeof q === "string" ? `"${q.slice(0, 60)}"` : "";
    }
    case "glob": {
      const p = args.pattern;
      return typeof p === "string" ? p.slice(0, 60) : "";
    }
    case "read_mcp_resource": {
      const u = args.uri ?? args.resource;
      return typeof u === "string" ? u.slice(0, 60) : "";
    }
    case "ask_user": {
      const q = args.question;
      return typeof q === "string" ? q.slice(0, 60) : "";
    }
    default: {
      // pick first string arg that isn't obviously content
      const keys = Object.keys(args);
      if (keys.length === 1) {
        const v = args[keys[0]];
        return typeof v === "string" ? v.slice(0, 60) : "";
      }
      const labelKey = keys.find((k) =>
        ["path", "name", "command", "pattern", "query", "url", "uri"].includes(k)
      );
      if (labelKey) {
        const v = args[labelKey];
        return typeof v === "string" ? v.slice(0, 60) : "";
      }
      return "";
    }
  }
}

/** Truncate task text to a readable one-liner */
function taskLabel(task: string): string {
  const firstLine = task.split("\n")[0]?.trim() ?? task;
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}

const MAX_RUNNING_STEPS = 5;

interface SubAgentBlockProps {
  block: OutputBlock & { kind: "subagent" };
}

export default function SubAgentBlock({ block }: SubAgentBlockProps) {
  const dt = useTheme();
  const icon = roleIcon(block.role);
  const label = roleLabel(block.role);
  const taskSummary = taskLabel(block.task);

  // Live elapsed time for running state
  const [liveElapsed, setLiveElapsed] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    if (block.status !== "running") return;
    startRef.current = Date.now();
    setLiveElapsed(0);
    const timer = setInterval(() => setLiveElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(timer);
  }, [block.status, block.subagentId]);

  if (block.status === "running") {
    const stepCount = block.steps.length;
    const visibleSteps = stepCount > MAX_RUNNING_STEPS
      ? block.steps.slice(-MAX_RUNNING_STEPS)
      : block.steps;
    const skipped = stepCount - MAX_RUNNING_STEPS;

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>▸ {icon} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {taskSummary}</Text>
          {stepCount > 0 && (
            <Text color={dt.dim}> ({stepCount} 步)</Text>
          )}
          <Text color={dt.dim}> ({formatDuration(liveElapsed)})</Text>
        </Box>
        {skipped > 0 && (
          <Box paddingLeft={3}>
            <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
          </Box>
        )}
        {visibleSteps.map((step, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={dt.dim}>├─ {step.toolName}</Text>
            {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (() => {
              const label = toolArgsLabel(step.toolName, step.toolArgs);
              return label ? <Text color={dt.muted}> {label}</Text> : null;
            })()}
            {step.ok !== undefined && (
              <Text color={step.ok ? dt.success : dt.error}>
                {" "}{step.ok ? "✓" : "✗"}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  if (block.status === "error") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.error}>✗ {icon} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {taskSummary}</Text>
        </Box>
        <Box paddingLeft={3}>
          <Text color={dt.error}>{block.error ?? "Unknown error"}</Text>
        </Box>
      </Box>
    );
  }

  // done — 使用 MarkdownBlock 渲染摘要，保留 Markdown 格式
  const doneStepCount = block.steps.length;
  const doneHeaderText = `${icon} ${label} · ${taskSummary} — ${block.toolCallCount} 次工具调用，${formatDuration(block.durationMs)}`;
  const isExpandable = doneStepCount > 0;

  if (block.expanded) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.success}>▼ {doneHeaderText}</Text>
        </Box>
        {isExpandable && (
          <Box paddingLeft={3} flexDirection="column">
            <Text color={dt.dim}>── Steps ──</Text>
            {(() => {
              const visibleSteps = doneStepCount > MAX_RUNNING_STEPS
                ? block.steps.slice(-MAX_RUNNING_STEPS)
                : block.steps;
              const skipped = doneStepCount - MAX_RUNNING_STEPS;
              return (
                <>
                  {skipped > 0 && (
                    <Box paddingLeft={2}>
                      <Text color={dt.dim}>... 以上 {skipped} 步已折叠</Text>
                    </Box>
                  )}
                  {visibleSteps.map((step, i) => (
                    <Box key={i} paddingLeft={2}>
                      <Text color={step.ok ? dt.success : step.ok === false ? dt.error : dt.muted}>
                        {step.ok ? "✓" : step.ok === false ? "✗" : "·"}
                      </Text>
                      <Text color={dt.muted}> {step.toolName}</Text>
                      {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (() => {
                        const label = toolArgsLabel(step.toolName, step.toolArgs);
                        return label ? <Text color={dt.dim}> {label}</Text> : null;
                      })()}
                    </Box>
                  ))}
                </>
              );
            })()}
          </Box>
        )}
        {block.summary && (
          <Box paddingLeft={3} flexDirection="column" marginTop={1}>
            <Text color={dt.dim}>── Summary ──</Text>
            <Box paddingLeft={0}>
              <MarkdownBlock content={block.summary} color={dt.dim} />
            </Box>
          </Box>
        )}
        <Box paddingLeft={3}>
          <Text color={dt.dim}>Enter 折叠</Text>
        </Box>
      </Box>
    );
  }

  // Collapsed done state — compact single line
  return (
    <Box>
      <Text color={dt.success}>{isExpandable ? "▶" : "✓"} {doneHeaderText}</Text>
    </Box>
  );
}
