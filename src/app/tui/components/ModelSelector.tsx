import { Box, Text, useInput } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { useRef, useState } from 'react';
import { useTheme } from '@/app/tui/theme';
import { type AvailableModel, listAvailableModels } from '@/core/config';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';
import { OverlayEmptyState, OverlayList, OverlayListRow } from './OverlayPrimitives';

export interface ModelOption {
  id: string;
  name: string;
  description: string;
}

function toModelOption(m: AvailableModel): ModelOption {
  return { id: m.name, name: m.name, description: m.isDefault ? 'default' : '' };
}

interface ModelSelectorProps {
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export default function ModelSelector({ currentModel, onSelect, onClose }: ModelSelectorProps) {
  const t = useTheme();
  const models: ModelOption[] = listAvailableModels().map(toModelOption);
  const [selected, setSelected] = useState(
    models.length > 0
      ? Math.max(
          0,
          models.findIndex((m) => m.id === currentModel),
        )
      : 0,
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const maxContentHeight = useOverlayHeight(9);

  useInput(
    (
      _input: string,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
    ) => {
      if (key.escape) {
        onClose();
        return;
      }
      if (models.length === 0) return;
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(models.length - 1, s + 1));
      if (key.return) {
        const model = models[selectedRef.current];
        if (model) onSelect(model.id);
        onClose();
      }
    },
  );

  if (models.length === 0) {
    return (
      <OverlayFrame
        title="选择模型"
        footer={<OverlayShortcutBar shortcuts={[{ keys: 'Esc', label: '关闭' }]} />}
      >
        <OverlayEmptyState>没有可用模型，请在 kite-code.jsonc 中配置 models 列表</OverlayEmptyState>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      title="选择模型"
      meta={
        <Text color={t.dim}>
          {selected + 1} / {models.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: '导航' },
            { keys: 'Enter', label: '选择' },
            { keys: 'Esc', label: '关闭' },
          ]}
        />
      }
    >
      <Box flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          <OverlayList>
            {models.map((model, i) => {
              const isSelected = i === selected;
              const isActive = model.id === currentModel;
              return (
                <OverlayListRow
                  key={model.id}
                  selected={isSelected}
                  primary={model.name}
                  trailing={
                    <Box>
                      <OverlayStatusColumn active={isActive} />
                      <Box width={9} justifyContent="flex-end">
                        <Text color={t.dim}>{model.description}</Text>
                      </Box>
                    </Box>
                  }
                />
              );
            })}
          </OverlayList>
        </ScrollList>
      </Box>
    </OverlayFrame>
  );
}
