import { Box, Text, useInput } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { useRef, useState } from 'react';
import { ACTIVE_DOT, INACTIVE_DOT } from '@/app/tui/constants';
import { useTheme } from '@/app/tui/theme';
import { type AvailableModel, listAvailableModels } from '@/core/config';
import { useOverlayHeight } from '../hooks/useOverlayHeight';

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
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={t.primary}
        paddingX={1}
        marginY={1}
      >
        <Text bold color={t.primary}>
          选择模型
        </Text>
        <Box marginY={1}>
          <Text color={t.muted}>没有可用模型，请在 kite-code.jsonc 中配置 models 列表</Text>
        </Box>
        <Text color={t.dim}>Esc 关闭</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        选择模型
      </Text>
      <Box marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          {models.map((model, i) => {
            const activeDot = model.id === currentModel ? ACTIVE_DOT : INACTIVE_DOT;
            return (
              <Box key={model.id}>
                <Text color={i === selected ? t.primary : t.muted}>
                  {i === selected ? '❯' : ' '} {activeDot}
                  {model.name}
                </Text>
                {model.description ? <Text color={t.dim}> — {model.description}</Text> : null}
              </Box>
            );
          })}
        </ScrollList>
      </Box>
      <Box height={1} />
      <Text color={t.dim}>上/下 导航 Enter 选择 Esc 取消</Text>
    </Box>
  );
}
