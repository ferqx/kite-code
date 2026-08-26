import { Box, Text, useInput } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { useRef, useState } from 'react';
import { type AvailableModel, listAvailableModels } from '#kite-cli/config';
import { useTheme } from '#kite-cli/tui/theme';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useI18n } from '../i18n';
import OverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './OverlayFrame';
import { OverlayEmptyState, OverlayListRow } from './OverlayPrimitives';

export interface ModelOption extends AvailableModel {
  id: string;
}

export function modelOptionId(model: Pick<AvailableModel, 'provider' | 'name'>): string {
  return `${model.provider}:${model.name}`;
}

export function toModelOption(model: AvailableModel): ModelOption {
  return { ...model, id: modelOptionId(model) };
}

interface ModelSelectorProps {
  currentModel: string;
  currentProvider: string;
  models?: readonly AvailableModel[];
  onSelect: (model: AvailableModel) => void;
  onClose: () => void;
}

export default function ModelSelector({
  currentModel,
  currentProvider,
  models: availableModels,
  onSelect,
  onClose,
}: ModelSelectorProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const models: ModelOption[] = (availableModels ?? listAvailableModels()).map(toModelOption);
  const providerGroups = new Map<string, ModelOption[]>();
  for (const model of models) {
    const group = providerGroups.get(model.provider);
    if (group) group.push(model);
    else providerGroups.set(model.provider, [model]);
  }
  const groupedModels = [...providerGroups.values()].flat();
  const [selected, setSelected] = useState(
    groupedModels.length > 0
      ? Math.max(
          0,
          groupedModels.findIndex((m) => m.name === currentModel && m.provider === currentProvider),
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
      if (groupedModels.length === 0) return;
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(groupedModels.length - 1, s + 1));
      if (key.return) {
        const model = groupedModels[selectedRef.current];
        if (model) onSelect(model);
        onClose();
      }
    },
  );

  if (groupedModels.length === 0) {
    return (
      <OverlayFrame
        title={translate('model.title')}
        footer={
          <OverlayShortcutBar shortcuts={[{ keys: 'Esc', label: translate('common.close') }]} />
        }
      >
        <OverlayEmptyState>{translate('model.noneAvailable')}</OverlayEmptyState>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      title={translate('model.title')}
      meta={
        <Text color={t.dim}>
          {selected + 1} / {groupedModels.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('common.navigate') },
            { keys: 'Enter', label: translate('common.select') },
            { keys: 'Esc', label: translate('common.close') },
          ]}
        />
      }
    >
      <Box maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          {[...providerGroups].flatMap(([provider, providerModels], providerIndex) =>
            providerModels.map((model, providerModelIndex) => {
              const index = groupedModels.indexOf(model);
              const isSelected = index === selected;
              const isActive = model.name === currentModel && model.provider === currentProvider;
              const modelRow = (
                <OverlayListRow
                  selected={isSelected}
                  primary={model.name}
                  trailing={<OverlayStatusColumn active={isActive} />}
                />
              );

              if (providerModelIndex === 0) {
                return (
                  <Box key={`model:${model.id}`} flexDirection="column">
                    {providerIndex > 0 && <Box height={1} />}
                    <Box paddingLeft={3} paddingRight={1}>
                      <Text bold color={t.accent}>
                        {provider}
                      </Text>
                    </Box>
                    {modelRow}
                  </Box>
                );
              }

              return <Box key={`model:${model.id}`}>{modelRow}</Box>;
            }),
          )}
        </ScrollList>
      </Box>
    </OverlayFrame>
  );
}
