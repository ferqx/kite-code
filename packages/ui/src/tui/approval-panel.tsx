import type { Interaction } from '@kite-ai/client';
import { Box } from 'ink';
import { terminalText } from './controller';
import OverlayChoiceList from './ink/OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

/** Pure UI: Root retains the focused original identity and sole submission listener. */
export function TuiApprovalPanel({
  card,
  choices,
  selected,
  busy = false,
  error,
}: {
  card: Interaction;
  choices: readonly string[];
  selected?: number;
  busy?: boolean;
  error?: string;
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
  const options = choices.map((answer) => ({
    id: answer,
    label:
      answer === 'approve same_command'
        ? t('same command in original Session')
        : translate(
            answer === 'approve'
              ? 'approval.once'
              : answer === 'approve same_command'
                ? 'approval.session'
                : 'approval.deny',
          ),
    description:
      answer === 'approve same_command'
        ? t(
            'Only this exact command in the original Session; other commands still require approval.',
          )
        : translate(
            answer === 'approve'
              ? 'approval.onceDescription'
              : answer === 'approve same_command'
                ? 'approval.sessionToolDescription'
                : 'approval.denyToolDescription',
          ),
  }));
  return (
    <OverlayFrame
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
      {typeof card.definitionId === 'string' && (
        <Text dimColor>{terminalText(card.definitionId)}</Text>
      )}
      {target && <Text>{terminalText(target)}</Text>}
      {typeof summary === 'string' && (
        <Box
          marginLeft={1}
          paddingLeft={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          <Text>{terminalText(summary)}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <OverlayChoiceList
          options={options}
          selectedId={selected === undefined ? undefined : options[selected]?.id}
          selectionBackground={false}
        />
      </Box>
      {selected === undefined && <Text dimColor>{t('none (Enter has no answer)')}</Text>}
      {busy && (
        <Text dimColor>
          {t('Original outcome pending or unknown; check original before another answer')}
        </Text>
      )}
      {error && <Text color="red">{terminalText(error)}</Text>}
    </OverlayFrame>
  );
}
