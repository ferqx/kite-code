import React from "react";
import { Box, Text } from "ink";
import { darkTheme as t } from "./theme";

export default function Footer() {
  return (
    <Box>
      <Text color={t.dim}>?  shortcuts</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.dim}>Ctrl+C exit</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.dim}>/ commands</Text>
      <Text color={t.dim}> · </Text>
      <Text color={t.dim}>! shell</Text>
    </Box>
  );
}
