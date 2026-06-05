import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { ToolApprovalPayload, ShellApprovalGrant } from "@/protocol/events";
import type { TuiUserInputProvider } from "@/app/tui/provider";
import { useTheme } from "@/app/tui/theme";

interface ApprovalBlockProps {
  approval: ToolApprovalPayload;
  provider: TuiUserInputProvider;
  onResolved: (action: string, grant?: string, pattern?: string) => void;
}

const GRANTS: { key: string; label: string; grant: ShellApprovalGrant | null; desc: string; showPattern: boolean }[] = [
  { key: "a", label: "Approve once", grant: "approve_once", desc: "仅批准本次", showPattern: false },
  { key: "s", label: "Same command", grant: "same_command", desc: "", showPattern: true },
  { key: "f", label: "Full access", grant: "full_access", desc: "完整 shell 权限", showPattern: false },
  { key: "d", label: "Deny", grant: null, desc: "拒绝", showPattern: false },
];

export default function ApprovalBlock({ approval, provider, onResolved }: ApprovalBlockProps) {
  const t = useTheme();
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const riskColor = t.risk[approval.risk] ?? t.risk.unknown;

  const pattern = approval.suggestedPrefixRule?.[0]
    ?? approval.command.split(/[;&|]/)[0].trim();
  // Only pass pattern to onResolved if non-empty and showPattern is true
  const effectivePattern = pattern.length > 0 ? pattern : undefined;

  function resolve(grant: ShellApprovalGrant | null, patternToUse: string | undefined) {
    if (grant) {
      provider.submitAction({ type: "approve", grant });
      onResolved(grant, grant, patternToUse);
    } else {
      provider.submitAction({ type: "reject" });
      onResolved("denied");
    }
  }

  useInput((input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
    if (key.escape) {
      provider.submitAction({ type: "cancel" });
      onResolved("cancelled");
      return;
    }

    const lower = input.toLowerCase();

    const match = GRANTS.find((g) => g.key === lower);
    if (match) {
      resolve(match.grant, match.showPattern ? effectivePattern : undefined);
      return;
    }

    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(GRANTS.length - 1, s + 1));
    if (key.return) {
      const opt = GRANTS[selectedRef.current];
      resolve(opt.grant, opt.showPattern ? effectivePattern : undefined);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={riskColor} paddingX={1} marginY={1}>
      <Text bold color={riskColor}>⚠ Approval</Text>
      <Text>
        <Text color={t.muted}>Command: </Text>
        <Text color={t.primary}>{approval.command}</Text>
      </Text>
      <Text>
        <Text color={t.muted}>Risk: </Text>
        <Text color={riskColor}>{approval.risk}</Text>
        <Text> · {approval.summary}</Text>
      </Text>
      {approval.reason && (
        <Text>
          <Text color={t.muted}>Reason: </Text>
          <Text>{approval.reason}</Text>
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {GRANTS.map((g, i) => (
          <Text key={g.key} color={i === selected ? t.primary : t.muted}>
            {i === selected ? ">" : " "} [{g.key.toUpperCase()}] {g.label}
            {g.showPattern && effectivePattern ? ` ("${effectivePattern}")` : ""}{!g.showPattern && g.desc ? `  ${g.desc}` : ""}
          </Text>
        ))}
      </Box>
      <Box height={1} />
      <Text color={t.dim}>Press key to select, up/down + Enter</Text>
    </Box>
  );
}
