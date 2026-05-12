import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { darkTheme as t } from "../theme";

export interface ModelOption {
  id: string;
  name: string;
  description: string;
}

const DEFAULT_MODELS: ModelOption[] = [
  { id: "deepseek-v4", name: "DeepSeek V4", description: "Default" },
  { id: "deepseek-v3", name: "DeepSeek V3", description: "" },
  { id: "gpt-4o", name: "OpenAI GPT-4o", description: "" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", description: "" },
];

interface ModelSelectorProps {
  models?: ModelOption[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export default function ModelSelector({ models = DEFAULT_MODELS, currentModel, onSelect, onClose }: ModelSelectorProps) {
  const [selected, setSelected] = useState(
    Math.max(0, models.findIndex((m) => m.id === currentModel))
  );

  useInput((_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(models.length - 1, s + 1));
    if (key.return) {
      const model = models[selected];
      if (model) onSelect(model.id);
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.primary} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>── Select Model ──</Text>
      <Box flexDirection="column" marginTop={1}>
        {models.map((model, i) => (
          <Box key={model.id}>
            <Text color={i === selected ? t.primary : t.muted}>
              {i === selected ? ">" : " "} {model.name}{model.id === currentModel ? " (current)" : ""}
            </Text>
            {model.description ? <Text color={t.dim}> — {model.description}</Text> : null}
          </Box>
        ))}
      </Box>
      <Text color={t.dim} marginTop={1}>↑↓ navigate  Enter select  Esc cancel</Text>
    </Box>
  );
}
