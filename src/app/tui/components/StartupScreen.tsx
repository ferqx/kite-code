import React from "react";
import { Box, Text } from "ink";
import { darkTheme as t } from "../theme";

interface StartupScreenProps {
  modelName: string;
  workspace: string;
}

export default function StartupScreen({ modelName, workspace }: StartupScreenProps) {
  const projectName = workspace.split("/").pop() ?? workspace.split("\\").pop() ?? "unknown";

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Banner */}
      <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={2} paddingY={1}>
        <Text bold color={t.primary}>
          ⚡ openpx
        </Text>
        <Text color={t.dim}>Interactive coding agent TUI</Text>
      </Box>

      {/* Info */}
      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        <Box gap={2}>
          <Box>
            <Text color={t.dim}>Model     </Text>
            <Text color={t.primary} bold>{modelName}</Text>
          </Box>
          <Box>
            <Text color={t.dim}>Project   </Text>
            <Text color={t.warning}>{projectName}</Text>
          </Box>
        </Box>
        <Box marginTop={0}>
          <Text color={t.dim}>Workspace </Text>
          <Text color={t.muted}>{workspace}</Text>
        </Box>
      </Box>

      {/* Help tips */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={t.muted}>  Type your task and press Enter to start</Text>
        <Text color={t.muted}>  Type /help for commands · Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
}
