import { Box, useStdout } from 'ink';
import { type ReactNode, useEffect, useState } from 'react';
import stringWidth from 'string-width';
import { terminalText } from './controller';
import OverlayFrame from './ink/OverlayFrame';
import { TuiText as Text, useInkI18n, useInkTheme, useTuiPresentation } from './presentation';

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
  homeDirectory?: string;
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
  const { t, testDiagnostics } = useTuiPresentation();
  const theme = useInkTheme();
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
    <Box
      flexDirection="column"
      width={width}
      paddingX={padding}
      borderStyle="round"
      borderColor={theme.dim}
    >
      <Text color={theme.dim}>
        ──
        <Text color={theme.primary}>
          ◆
          <Text bold color={theme.primary}>
            {' '}
            Kite Code
          </Text>
        </Text>
      </Text>
      <Box height={1} />
      {row('model', model)}
      {testDiagnostics && facts.runtimeModel?.active && (
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
      {row(
        'workspace',
        facts.workspacePath
          ? formatInkWorkspace(facts.workspacePath, facts.homeDirectory)
          : t('Workspace unavailable'),
      )}
      {testDiagnostics && facts.sessionTitle && row(t('Session'), facts.sessionTitle)}
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
  const theme = useInkTheme();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!activity) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % 4), 250);
    return () => clearInterval(timer);
  }, [activity]);
  return activity ? (
    <Text
      color={
        activity === 'Cancelling' || activity === 'Retrying'
          ? theme.warning
          : activity.startsWith('Waiting')
            ? theme.muted
            : theme.primary
      }
    >
      {['·', '⋄', '⋆', '✧'][frame]}{' '}
      {activity === 'Waiting for required result' ? 'Waiting · background results' : activity}
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
  const { t, testDiagnostics } = useTuiPresentation();
  const theme = useInkTheme(),
    { t: translate, formatNumber } = useInkI18n();
  const { stdout } = useStdout();
  const permission = facts.permissionMode
    ? translate(
        facts.permissionMode === 'auto'
          ? 'stats.auto'
          : facts.permissionMode === 'full'
            ? 'stats.fullAccess'
            : 'stats.acceptEdits',
      )
    : undefined;
  const permissionColor =
    facts.permissionMode === 'auto'
      ? theme.success
      : facts.permissionMode === 'full'
        ? theme.warning
        : theme.muted;
  const tokens = facts.usage?.inputTokens;
  const tokenText =
    tokens && tokens > 0
      ? tokens >= 1000
        ? `${(tokens / 1000).toFixed(1)}k`
        : formatNumber(tokens)
      : undefined;
  const cache = facts.usage?.cachedInputTokens;
  const cachePct =
    cache !== undefined && tokens && tokens > 0 ? Math.round((cache / tokens) * 100) : undefined;
  const planHint = planning ? translate('stats.exitPlanMode') : undefined;
  const compact =
    stringWidth(
      [
        facts.modelName,
        facts.effort,
        cachePct === undefined ? undefined : `${cachePct}% cache`,
        tokenText,
        permission && `[${permission}]`,
        planHint,
      ]
        .filter(Boolean)
        .join(' · '),
    ) > (stdout.columns || 80);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <TuiActivityLine activity={activity} />
      {notice}
      {testDiagnostics && facts.runtimeModel?.active && facts.nextModelName && (
        <Text dimColor>
          {t('Next model:')}{' '}
          {terminalText([facts.nextModelName, facts.nextEffort].filter(Boolean).join(' '))}
        </Text>
      )}
      {testDiagnostics && facts.usage && (
        <Text dimColor>
          {t('Recorded usage:')} {facts.usage.inputTokens.toLocaleString()} {t('input tokens')}
          {facts.usage.outputTokens !== undefined &&
            ` · ${facts.usage.outputTokens.toLocaleString()} ${t('output tokens')}`}
        </Text>
      )}
      {children}
      {inputActive && (
        <Box>
          <Text color={theme.muted}>{terminalText(facts.modelName ?? '')}</Text>
          {!compact && facts.effort && (
            <>
              <Text> </Text>
              <Text color={theme.success}>{terminalText(facts.effort)}</Text>
            </>
          )}
          {!compact && cachePct !== undefined && (
            <>
              <Text color={theme.dim}> · </Text>
              <Text
                color={cachePct > 50 ? theme.success : cachePct > 20 ? theme.warning : theme.muted}
              >
                {cachePct}% cache
              </Text>
            </>
          )}
          {!compact && tokenText && (
            <>
              <Text color={theme.dim}> · </Text>
              <Text>{tokenText}</Text>
            </>
          )}
          {permission && (
            <>
              <Text color={theme.dim}> · </Text>
              <Text color={permissionColor}>[{permission}]</Text>
            </>
          )}
          {!compact && planHint && (
            <>
              <Box flexGrow={1} />
              <Text color={theme.dim}>{planHint}</Text>
            </>
          )}
          {testDiagnostics && (
            <>
              <Box flexGrow={1} />
              <Text dimColor>
                {t(planning ? 'Shift+Tab: exit plan · /help' : 'Shift+Tab: plan · /help')}
              </Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

export function formatInkWorkspace(workspace: string, home?: string): string {
  let path = workspace;
  try {
    if (workspace.startsWith('file:'))
      path = decodeURIComponent(new URL(workspace).pathname).replace(/^\/([a-z]:)/i, '$1');
  } catch {
    /* Preserve the original observed path. */
  }
  path = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedHome = home?.replaceAll('\\', '/').replace(/\/+$/, '');
  const compare = (value: string) => (/^[a-z]:/i.test(path) ? value.toLowerCase() : value);
  if (normalizedHome && compare(path) === compare(normalizedHome)) return '~';
  if (normalizedHome && compare(path).startsWith(`${compare(normalizedHome)}/`))
    return `~${path.slice(normalizedHome.length)}`;
  return path || workspace;
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
  return (
    <OverlayFrame title={title} hint={hint}>
      {children}
    </OverlayFrame>
  );
}
