import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import TextInput from "ink-text-input";
import type { ToolApprovalPayload, ShellApprovalGrant } from "@/app/protocol/events";
import type { TuiUserInputProvider } from "@/app/tui/provider";
import { darkTheme as t } from "@/app/tui/theme";

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
  const [selected, setSelected] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [editedCommand, setEditedCommand] = useState(approval.command);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const riskColor = t.risk[approval.risk] ?? t.risk.unknown;

  const pattern = approval.suggestedPrefixRule?.[0]
    ?? approval.command.split(/[;&|]/)[0].trim();

  useInput((input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
    if (key.escape && editMode) {
      setEditMode(false);
      setEditedCommand(approval.command);
      return;
    }

    if (editMode) return; // TextInput handles input when in edit mode

    const lower = input.toLowerCase();

    // 'E' key — edit command before approving
    if (lower === "e" && !editMode) {
      setEditMode(true);
      return;
    }

    const match = GRANTS.find((g) => g.key === lower);
    if (match) {
      if (match.grant) {
        const patternStr = match.showPattern ? ` ("${pattern}")` : "";
        provider.submitAction({ type: "approve", grant: match.grant });
        onResolved(match.grant, match.grant, patternStr);
      } else {
        provider.submitAction({ type: "reject" });
        onResolved("denied");
      }
      return;
    }

    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(GRANTS.length - 1, s + 1));
    if (key.return) {
      const opt = GRANTS[selectedRef.current];
      if (opt.grant) {
        const patternStr = opt.showPattern ? ` ("${pattern}")` : "";
        provider.submitAction({ type: "approve", grant: opt.grant });
        onResolved(opt.grant, opt.grant, patternStr);
      } else {
        provider.submitAction({ type: "reject" });
        onResolved("denied");
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={riskColor} paddingX={1} marginY={1}>
      <Text bold color={riskColor}>⚠ Approval</Text>
      <Text>
        <Text color={t.muted}>Command: </Text>
        {editMode ? (
          <TextInput
            value={editedCommand}
            onChange={setEditedCommand}
            onSubmit={() => setEditMode(false)}
          />
        ) : (
          <Text color={t.primary}>{approval.command}</Text>
        )}
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
            {g.showPattern ? ` ("${pattern}")` : ""}{!g.showPattern && g.desc ? `  ${g.desc}` : ""}
          </Text>
        ))}
      </Box>
      <Box height={1} />
      <Text color={t.dim}>
        {editMode
          ? "Editing command — Enter to confirm, Esc to cancel"
          : "Press key to select, E to edit command, up/down + Enter"}
      </Text>
    </Box>
  );
}
