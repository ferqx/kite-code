import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { TuiUserInputProvider } from "./provider";
import type { ToolApprovalPayload, ShellApprovalGrant } from "../../protocol/events";
import { darkTheme as t } from "./theme";

interface ApprovalDialogProps {
  approval: ToolApprovalPayload;
  provider: TuiUserInputProvider;
}

const GRANT_OPTIONS: { key: string; label: string; grant: ShellApprovalGrant; action: "approve" | "reject" }[] = [
  { key: "a", label: "Approve once", grant: "approve_once", action: "approve" },
  { key: "s", label: "Same command", grant: "same_command", action: "approve" },
  { key: "f", label: "Full access", grant: "full_access", action: "approve" },
  { key: "r", label: "Reject", grant: "approve_once", action: "reject" },
];

export default function ApprovalDialog({ approval, provider }: ApprovalDialogProps) {
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(GRANT_OPTIONS.length - 1, s + 1));
    if (key.return) {
      const opt = GRANT_OPTIONS[selected];
      if (opt.action === "approve") {
        provider.submitAction({ type: "approve", grant: opt.grant });
      } else {
        provider.submitAction({ type: "reject" });
      }
    }
  });

  const riskColor = t.risk[approval.risk] ?? t.risk.unknown;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={riskColor} paddingX={1}>
      <Text bold color={riskColor}>
        ⚠ Tool Approval Required
      </Text>
      <Box flexDirection="column" marginY={1}>
        <Text>
          <Text color={t.muted}>Tool: </Text>
          <Text bold>{approval.tool}</Text>
        </Text>
        <Text>
          <Text color={t.muted}>Command: </Text>
          <Text color={t.primary}>{approval.command}</Text>
        </Text>
        <Text>
          <Text color={t.muted}>Risk: </Text>
          <Text color={riskColor}>{approval.risk}</Text>
        </Text>
        <Text>
          <Text color={t.muted}>Summary: </Text>
          <Text>{approval.summary}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {GRANT_OPTIONS.map((opt, i) => (
          <Text key={opt.key} color={i === selected ? t.primary : t.muted}>
            {i === selected ? "❯" : " "} [{opt.key.toUpperCase()}] {opt.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
