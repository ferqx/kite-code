import { type Interaction, readApprovalOptions } from '@kite-ai/client';
import { Box } from 'ink';
import { terminalText } from './controller';
import OverlayChoiceList from './ink/OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { TuiPanelViewport } from './panel-viewport';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

/** Pure UI: Root retains the focused original identity and sole submission listener. */
export function TuiApprovalPanel({
  card,
  choices,
  selected,
  busy = false,
  error,
  rows = 22,
}: {
  card: Interaction;
  choices: readonly string[];
  selected?: number;
  busy?: boolean;
  error?: string;
  rows?: number;
}) {
  const { t } = useTuiPresentation();
  const { t: translate } = useInkI18n();
  const request = card.request;
  const input =
    request &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    request.input &&
    typeof request.input === 'object' &&
    !Array.isArray(request.input)
      ? request.input
      : undefined;
  const target = input && typeof input.path === 'string' ? input.path : undefined;
  const summary =
    request && typeof request === 'object' && !Array.isArray(request)
      ? [request.command, request.title, request.summary, request.description, input?.command].find(
          (value) => typeof value === 'string',
        )
      : undefined;
  const offered = readApprovalOptions(request);
  const options = choices.map((answer) => {
    const option =
      answer === 'approve'
        ? offered.find((item) => item.kind === 'once')
        : offered.find((item) => answer === `approve ${item.optionId}`);
    return {
      id: answer,
      label: option ? terminalText(option.presentation.label) : translate('approval.deny'),
      description: option
        ? terminalText(option.presentation.details.join('\n'))
        : translate('approval.denyToolDescription'),
    };
  });
  return (
    <OverlayFrame
      compact
      title={translate('approval.title', { tool: translate('approval.genericTool') })}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('common.navigate') },
            { keys: 'Enter', label: translate('common.confirm') },
            { keys: 'Esc', label: translate('common.cancel') },
          ]}
        />
      }
    >
      <OverlayChoiceList
        options={options.map((option) => ({ id: option.id, label: option.label }))}
        selectedId={selected === undefined ? undefined : options[selected]?.id}
        selectionBackground={false}
        compact
      />
      <TuiPanelViewport
        rows={Math.max(2, rows - options.length - 3)}
        identity={`${card.id}:${card.revision}:${selected ?? 'none'}`}
      >
        {typeof card.definitionId === 'string' && (
          <Text dimColor>{terminalText(card.definitionId)}</Text>
        )}
        <Text dimColor>{terminalText(card.sessionId)}</Text>
        {target && <Text>{terminalText(target)}</Text>}
        {typeof summary === 'string' && <Text>{terminalText(summary)}</Text>}
        {selected !== undefined && options[selected] && (
          <Box flexDirection="column" flexShrink={0}>
            <Text bold>{options[selected].label}</Text>
            {options[selected].description && <Text>{options[selected].description}</Text>}
          </Box>
        )}
        {selected === undefined && <Text dimColor>{t('none (Enter has no answer)')}</Text>}
        {busy && (
          <Text dimColor>
            {t('Original outcome pending or unknown; check original before another answer')}
          </Text>
        )}
        {error && <Text color="red">{terminalText(error)}</Text>}
      </TuiPanelViewport>
    </OverlayFrame>
  );
}
