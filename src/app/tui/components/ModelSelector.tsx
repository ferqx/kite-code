import React, { useState, useRef } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { darkTheme as t } from "@/app/tui/theme";
import { listAvailableModels, type AvailableModel } from "@/core/config";

export interface ModelOption {
  id: string;
  name: string;
  description: string;
}

function toModelOption(m: AvailableModel): ModelOption {
  const parts: string[] = [m.label];
  if (m.isDefault) parts.push("default");
  return { id: m.name, name: m.label, description: parts.length > 1 ? "default" : "" };
}

interface ModelSelectorProps {
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export default function ModelSelector({ currentModel, onSelect, onClose }: ModelSelectorProps) {
  const models: ModelOption[] = listAvailableModels().map(toModelOption);
  const [selected, setSelected] = useState(
    Math.max(0, models.findIndex((m) => m.id === currentModel))
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useInput((_input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(models.length - 1, s + 1));
    if (key.return) {
      const model = models[selectedRef.current];
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
              {i === selected ? "❯" : " "} {model.name}{model.id === currentModel ? " (current)" : ""}
            </Text>
            {model.description ? <Text color={t.dim}> — {model.description}</Text> : null}
          </Box>
        ))}
      </Box>
      <Box height={1} />
      <Text color={t.dim}>up/down navigate  Enter select  Esc cancel</Text>
    </Box>
  );
}
