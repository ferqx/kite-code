import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { Box } from 'ink';
import { terminalText } from './controller';
import { TerminalMarkdown } from './markdown';
import { TuiText as Text, useTuiPresentation } from './presentation';

export type TuiTranscriptCall = NonNullable<Message['toolCalls']>[number];
export type TuiTranscriptMessage = {
  kind: 'message';
  message: Message;
  toolCalls: readonly TuiTranscriptCall[];
  reasoning?: string;
  bodyAvailability: 'verified' | 'projection';
  modelBodyComplete?: boolean;
  sourceIds: readonly string[];
};
export type TuiTranscriptToolResult = {
  kind: 'tool-result';
  message: Message;
  call: TuiTranscriptCall;
  ownerMessageId: string;
  sourceIds: readonly string[];
};
export type TuiTranscriptItem = TuiTranscriptMessage | TuiTranscriptToolResult;

const originalScope = (message: Message) =>
  JSON.stringify([
    message.originMessage?.storeId ?? null,
    message.originMessage?.sessionId ?? message.sessionId,
    message.originMessage ? message.originMessage.runId : message.runId,
  ]);

/** Source-order messages. Only a unique exact call identity links a Tool result.
 * Execution has no sequence here: callers must not invent its message position.
 */
export function projectTuiMessages(
  messages: readonly Message[],
  loadedOutputs: ReadonlyMap<string, ModelOutputSnapshot['output']> = new Map(),
): readonly TuiTranscriptItem[] {
  const ordered = [...messages].sort((a, b) => {
    const first = BigInt(a.seq),
      second = BigInt(b.seq);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  const owners = new Map<string, { call: TuiTranscriptCall; message: Message }[]>();
  for (const message of ordered) {
    if (message.role !== 'assistant') continue;
    const loaded = loadedOutputs.get(message.id);
    const calls = loaded ? loaded.toolCalls : (message.toolCalls ?? []);
    for (const call of calls) {
      const key = JSON.stringify([originalScope(message), call.id]);
      const matches = owners.get(key) ?? [];
      matches.push({ call, message });
      owners.set(key, matches);
    }
  }
  return ordered.map((message): TuiTranscriptItem => {
    const sourceIds = Object.freeze([...(message.sourceIds ?? [])]);
    if (message.role === 'tool' && message.toolCallId) {
      const matches = owners.get(JSON.stringify([originalScope(message), message.toolCallId]));
      const owner = matches?.length === 1 ? matches[0] : undefined;
      if (owner && BigInt(owner.message.seq) < BigInt(message.seq)) {
        return {
          kind: 'tool-result',
          message,
          call: owner.call,
          ownerMessageId: owner.message.id,
          sourceIds,
        };
      }
    }
    const loaded = loadedOutputs.get(message.id);
    return {
      kind: 'message',
      message,
      toolCalls: Object.freeze([...(loaded ? loaded.toolCalls : (message.toolCalls ?? []))]),
      ...(loaded
        ? { reasoning: loaded.reasoning, modelBodyComplete: loaded.complete }
        : message.outputBody
          ? { modelBodyComplete: message.outputBody.complete }
          : {}),
      bodyAvailability: loaded ? 'verified' : 'projection',
      sourceIds,
    };
  });
}

/** Parameters are user content, never shortened or filtered by their field names. */
export function TuiToolCalls({ item }: { item: TuiTranscriptMessage }) {
  const { t, testDiagnostics } = useTuiPresentation();
  if (!item.toolCalls.length) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {t(
          item.bodyAvailability === 'verified'
            ? 'Verified recorded tool calls'
            : 'Recorded tool calls',
        )}
      </Text>
      {item.toolCalls.map((call, index) => (
        <Box key={`${item.message.id}/${call.id}/${index}`} flexDirection="column" paddingLeft={2}>
          <Text bold>
            {terminalText(call.name)}
            {testDiagnostics && <> [{terminalText(call.id)}]</>}
          </Text>
          <Text>{terminalText(call.arguments)}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function TuiToolResult({ item }: { item: TuiTranscriptToolResult }) {
  const { t, testDiagnostics } = useTuiPresentation();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>
        {t('Tool result')} · {terminalText(item.call.name)}
        {testDiagnostics && (
          <>
            {' '}
            [{terminalText(item.message.id)}] {item.message.status}
          </>
        )}
      </Text>
      {/* A committed Tool message proves recorded content, not process success. */}
      {item.message.status === 'incomplete' && (
        <Text color="yellow">{t('Incomplete recorded result')}</Text>
      )}
      <Box paddingLeft={2}>
        <TerminalMarkdown content={item.message.content} />
      </Box>
    </Box>
  );
}

export interface TuiThoughtTiming {
  /** Explicit verified elapsed fact; never inferred from render time. */
  readonly elapsedMs: number;
}
export function TuiThoughtPhase({
  reasoning,
  toolCount,
  active = false,
  settled = false,
  expanded = false,
  timing,
}: {
  reasoning?: string;
  toolCount: number;
  active?: boolean;
  settled?: boolean;
  expanded?: boolean;
  timing?: TuiThoughtTiming;
}) {
  const { t } = useTuiPresentation();
  const duration =
    timing && Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0
      ? `${(timing.elapsedMs / 1000).toFixed(1)}s`
      : t('Timing unavailable');
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {t(active ? 'Thinking' : settled ? 'Thought' : 'Recorded reasoning')} ·{' '}
        {t('Recorded phase')}: {duration}
        {toolCount > 0 && ` · ${toolCount} ${t('tool calls')}`}
      </Text>
      {expanded &&
        reasoning !== undefined &&
        (reasoning ? (
          <TerminalMarkdown content={reasoning} />
        ) : (
          <Text dimColor>{t('Recorded reasoning is empty')}</Text>
        ))}
    </Box>
  );
}
