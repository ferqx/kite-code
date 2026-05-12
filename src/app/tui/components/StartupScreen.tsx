import React from "react";
import { Box, Text } from "ink";
import { darkTheme as t } from "./theme";

interface StartupScreenProps {
  modelName: string;
  workspace: string;
}

export default function StartupScreen({ modelName, workspace }: StartupScreenProps) {
  const projectName = workspace.split("/").pop() ?? workspace.split("\\").pop() ?? "unknown";

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color={t.primary}>openpx</Text>
      <Text color={t.muted}>Interactive coding agent</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Model: <Text color={t.primary}>{modelName}</Text>
        </Text>
        <Text>
          Workspace: <Text color={t.muted}>{workspace}</Text>
        </Text>
        <Text>
          Project: <Text>{projectName}</Text>
        </Text>
      </Box>
      <Text color={t.dim} marginTop={1}>Type your task or /help for commands</Text>
      <Text color={t.dim}>Ctrl+C to exit</Text>
    </Box>
  );
}
