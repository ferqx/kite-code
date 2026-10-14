import { Box, useStdout } from 'ink';
import { type ReactNode, useEffect, useState } from 'react';
import stringWidth from 'string-width';
import { terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Preserve complete displayed graphemes, including wide and joined emoji. */
export function truncateDisplayWidth(value: string, width: number): string {
  const text = terminalText(value);
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  if (width === 1) return '…';
  const parts = [...graphemes.segment(text)].map((part) => part.segment);
  const available = width - 1;
  const firstBudget = Math.ceil(available * 0.4);
  let first = '',
    last = '',
    used = 0;
  for (const part of parts) {
    if (used + stringWidth(part) > firstBudget) break;
    first += part;
    used += stringWidth(part);
  }
  used = 0;
  for (const part of parts.reverse()) {
    if (used + stringWidth(part) > available - stringWidth(first)) break;
    last = part + last;
    used += stringWidth(part);
  }
  return `${first}…${last}`;
}

export interface TuiChromeFacts {
  modelName?: string;
  effort?: string;
  workspacePath?: string;
  sessionTitle?: string;
  permissionMode?: 'accept_edits' | 'auto' | 'full';
  nextModelName?: string;
  nextEffort?: string;
  runtimeModel?: {
    active: boolean;
    modelName?: string;
    effort?: string;
    source: 'model_input' | 'run_configuration' | 'unavailable';
  };
  usage?: {
    inputTokens: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    executionCount: number;
  };
}

/** Static header: the host supplies observed display facts, never runtime authority. */
export function TuiHeader({ columns, ...facts }: TuiChromeFacts & { columns?: number }) {
  const { stdout } = useStdout();
  const { t } = useTuiPresentation();
  const width = Math.max(1, Math.min(60, (columns ?? stdout.columns) || 80));
  const padding = width >= 8 ? 1 : 0;
  const inner = Math.max(1, width - 2 - padding * 2);
  const model = facts.modelName
    ? [facts.modelName, width >= 40 ? facts.effort : undefined].filter(Boolean).join(' ')
    : t('Model unavailable');
  const row = (label: string, value: string) => (
    <Box>
      {inner > 16 && (
        <Box width={11} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
      )}
      <Text>{truncateDisplayWidth(value, inner > 16 ? inner - 11 : inner)}</Text>
    </Box>
  );
  return (
    <Box flexDirection="column" width={width} paddingX={padding} borderStyle="round">
      <Text bold>{truncateDisplayWidth('──◆ Kite Code', inner)}</Text>
      <Box height={1} />
      {row('model', model)}
      {facts.runtimeModel?.active && (
        <Text dimColor>
          {t(
            facts.runtimeModel.source === 'model_input'
              ? 'Recorded Model input'
              : facts.runtimeModel.source === 'run_configuration'
                ? 'Frozen Run selection'
                : 'Current model unavailable',
          )}
        </Text>
      )}
      {row('workspace', facts.workspacePath ?? t('Workspace unavailable'))}
      {facts.sessionTitle && row(t('Session'), facts.sessionTitle)}
    </Box>
  );
}

export function TuiRule() {
  return (
    <Box
      width="100%"
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    />
  );
}

/** Clock from a committed dispatch timestamp, never from the first UI observation. */
export function TuiRecordedPhaseTime({ startedAt, label }: { startedAt: number; label: string }) {
  const { t } = useTuiPresentation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text dimColor>
      {t(label)} · {t('Recorded phase')}: {Math.max(0, (now - startedAt) / 1000).toFixed(1)}s
    </Text>
  );
}

export type TuiActivity =
  | 'Working'
  | 'Cancelling'
  | 'Retrying'
  | 'Waiting for required result'
  | 'Waiting · background results';
export function TuiActivityLine({ activity }: { activity?: TuiActivity }) {
  const { t } = useTuiPresentation();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!activity) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % 4), 250);
    return () => clearInterval(timer);
  }, [activity]);
  return activity ? (
    <Text color={activity === 'Cancelling' || activity === 'Retrying' ? 'yellow' : undefined}>
      {['⠋', '⠙', '⠹', '⠸'][frame]} {t(activity)}
    </Text>
  ) : null;
}

/** Footer presentation does not infer success from a receipt or own input handlers. */
export function TuiFooter({
  children,
  activity,
  notice,
  planning = false,
  inputActive = true,
  ...facts
}: TuiChromeFacts & {
  children?: ReactNode;
  activity?: TuiActivity;
  notice?: ReactNode;
  planning?: boolean;
  inputActive?: boolean;
}) {
  const { t } = useTuiPresentation();
  const permission =
    facts.permissionMode === 'auto'
      ? t('Automatic review')
      : facts.permissionMode === 'full'
        ? t('Full access')
        : facts.permissionMode === 'accept_edits'
          ? t('Request approval')
          : undefined;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <TuiActivityLine activity={activity} />
      {notice}
      {inputActive && <TuiRule />}
      {facts.runtimeModel?.active && facts.nextModelName && (
        <Text dimColor>
          {t('Next model:')}{' '}
          {terminalText([facts.nextModelName, facts.nextEffort].filter(Boolean).join(' '))}
        </Text>
      )}
      {facts.usage && (
        <Text dimColor>
          {t('Recorded usage:')} {facts.usage.inputTokens.toLocaleString()} {t('input tokens')}
          {facts.usage.outputTokens !== undefined &&
            ` · ${facts.usage.outputTokens.toLocaleString()} ${t('output tokens')}`}
          {facts.usage.cachedInputTokens !== undefined &&
            facts.usage.inputTokens > 0 &&
            ` · ${Math.round((facts.usage.cachedInputTokens / facts.usage.inputTokens) * 100)}% ${t('cache')}`}
        </Text>
      )}
      {children}
      {inputActive && <TuiRule />}
      <Box flexWrap="wrap">
        <Text dimColor>
          {terminalText(
            [facts.modelName, facts.effort, permission && `[${permission}]`]
              .filter(Boolean)
              .join(' · '),
          )}
        </Text>
        <Box flexGrow={1} />
        {inputActive && (
          <Text dimColor>
            {t(planning ? 'Shift+Tab: exit plan · /help' : 'Shift+Tab: plan · /help')}
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** Pure shared overlay frame; the caller retains focus, choices and original scope. */
export function TuiOverlayFrame({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  const { stdout } = useStdout();
  const width = Math.max(1, stdout.columns || 80);
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Box alignItems="center">
        <Box flexShrink={0}>
          <Text dimColor>── </Text>
        </Box>
        <Box flexShrink={0} maxWidth={Math.max(1, width - 4)}>
          <Text bold>
            {typeof title === 'string'
              ? truncateDisplayWidth(title, Math.max(1, width - 4))
              : title}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={1}>
          <TuiRule />
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
      {hint && (
        <Box marginTop={1} flexDirection="column">
          <TuiRule />
          <Text dimColor>{terminalText(hint)}</Text>
        </Box>
      )}
    </Box>
  );
}
