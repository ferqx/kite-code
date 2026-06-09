import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { ToolApprovalPayload, ShellApprovalGrant } from "@/protocol/events";
import type { TuiUserInputProvider } from "@/app/tui/provider";
import { useTheme } from "@/app/tui/theme";

interface Option {
  key: string;
  label: string;
  grant: ShellApprovalGrant | null;
}

interface ApprovalBlockProps {
  approval: ToolApprovalPayload;
  provider: TuiUserInputProvider;
  onResolved: (action: string, grant?: string, pattern?: string) => void;
}

export default function ApprovalBlock({ approval, provider, onResolved }: ApprovalBlockProps) {
  const t = useTheme();
  const riskColor = t.risk[approval.risk] ?? t.risk.unknown;

  const options: Option[] = [];
  for (const g of approval.grantOptions) {
    switch (g) {
      case "approve_once": options.push({ key: "a", label: "Approve", grant: "approve_once" }); break;
      case "same_command": options.push({ key: "s", label: "Same Cmd", grant: "same_command" }); break;
      case "full_access": options.push({ key: "f", label: "Full Access", grant: "full_access" }); break;
    }
  }
  options.push({ key: "d", label: "Deny", grant: null });

  const [selectedIndex, setSelectedIndex] = useState(0);

  const prefix = approval.suggestedPrefixRule?.[0]
    ?? approval.command.split(/[;&|]/)[0]?.trim();

  function resolve(grant: ShellApprovalGrant | null) {
    if (grant) {
      const pat = grant === "same_command" && prefix ? prefix : undefined;
      provider.submitAction({ type: "approve", grant });
      onResolved(grant, grant, pat);
    } else {
      provider.submitAction({ type: "reject" });
      onResolved("denied");
    }
  }

  useInput((input: string, key: { escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    if (key.escape) {
      provider.submitAction({ type: "cancel" });
      onResolved("cancelled");
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(options.length - 1, i + 1));
      return;
    }
    if (key.return) {
      resolve(options[selectedIndex].grant);
      return;
    }
    // 字母快捷键 / Letter shortcut
    const match = options.find((o) => o.key === input.toLowerCase());
    if (match) resolve(match.grant);
  });

  const cmd = approval.command.length > 100
    ? approval.command.slice(0, 97) + "..."
    : approval.command;

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={riskColor}>⚠ </Text>
        <Text color={t.primary}>{cmd}</Text>
      </Box>
      <Box flexDirection="column">
        {options.map((o, i) => {
          const isSelected = i === selectedIndex;
          return (
            <Text key={o.key} color={isSelected ? t.primary : (o.grant ? t.muted : t.error)}>
              {isSelected ? "▶ " : "  "}[{o.key.toUpperCase()}]{o.label}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
