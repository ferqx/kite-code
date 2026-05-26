import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme";

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

interface HeaderProps {
  running: boolean;
  error?: boolean;
}

export default function Header({ running, error }: HeaderProps) {
  const t = useTheme();
  const mood = catMood(running, !!error);
  const [catTop, catMid, catBot] = CAT_LINES[mood];

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.primary}>{catTop}  </Text>
        <Text bold color={t.primary}>OpenPX</Text>
      </Box>
      <Box>
        <Text color={t.primary}>{catMid}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={t.primary}>{catBot}</Text>
      </Box>
      <Box>
        <Text color={t.dim}>? shortcuts</Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.dim}>Ctrl+C exit</Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.dim}>/ commands</Text>
        <Text color={t.dim}> · </Text>
        <Text color={t.dim}>! shell</Text>
      </Box>
    </Box>
  );
}
