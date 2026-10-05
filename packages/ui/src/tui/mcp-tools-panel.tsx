import { Box, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import { mcpTextRows, mcpTextWindow } from './mcp-tools';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** All metadata is external text. Navigation never dispatches or restores a Tool. */
export function TuiMcpToolsPanel({ controller }: { controller: TuiController }) {
  const { t } = useTuiPresentation();
  const state = controller.state.mcpTools!;
  const [selected, setSelected] = useState(0),
    [line, setLine] = useState(0);
  const text = useMemo(
    () => (state.metadata ? terminalText(JSON.stringify(state.metadata, null, 2)) : ''),
    [state.metadata],
  );
  const rows = useMemo(() => mcpTextRows(text), [text]);
  type Choice =
    | { kind: 'snapshot'; key: string }
    | { kind: 'tool'; index: number }
    | { kind: 'nextSnapshots' | 'nextTools' | 'previousTools' | 'back' | 'retry' };
  const choices: Choice[] =
    state.phase === 'failed'
      ? [{ kind: 'retry' }, { kind: 'back' }]
      : state.screen === 'snapshots'
        ? [
            ...(state.snapshots?.items ?? []).map((snapshot) => ({
              kind: 'snapshot' as const,
              key: snapshot.recordKey,
            })),
            ...(state.snapshots?.nextAfterKey ? [{ kind: 'nextSnapshots' as const }] : []),
            { kind: 'back' },
          ]
        : state.screen === 'tools'
          ? [
              ...(state.page?.entries ?? []).map((entry) => ({
                kind: 'tool' as const,
                index: entry.index,
              })),
              ...((state.pageStarts?.length ?? 0) > 1 ? [{ kind: 'previousTools' as const }] : []),
              ...(state.page?.nextIndex !== null && state.page?.nextIndex !== undefined
                ? [{ kind: 'nextTools' as const }]
                : []),
              { kind: 'back' },
            ]
          : [{ kind: 'back' }];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each original page or completed descriptor resets its viewport.
  useEffect(() => {
    setSelected(0);
    setLine(0);
  }, [state.screen, state.page, state.snapshots, state.metadata]);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      controller.closePanel();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.escape) {
      controller.backMcpTools();
      return;
    }
    if (state.phase === 'reading') return;
    if (state.screen === 'descriptor' && state.metadata) {
      const last = Math.max(0, rows.length - 10);
      if (key.upArrow) setLine((value) => Math.max(0, value - 1));
      else if (key.downArrow) setLine((value) => Math.min(last, value + 1));
      else if (key.leftArrow) setLine((value) => Math.max(0, value - 10));
      else if (key.rightArrow) setLine((value) => Math.min(last, value + 10));
      else if (key.home) setLine(0);
      else if (key.end) setLine(last);
      else if (key.return) controller.backMcpTools();
      return;
    }
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(choices.length - 1, value + 1));
    else if (key.return) {
      const choice = choices[selected];
      if (!choice) return;
      if (choice.kind === 'snapshot') void controller.selectMcpToolsSnapshot(choice.key);
      else if (choice.kind === 'tool') void controller.selectMcpTool(choice.index);
      else if (choice.kind === 'nextSnapshots')
        void controller.openMcpTools(state.snapshots!.nextAfterKey!);
      else if (choice.kind === 'nextTools')
        void controller.selectMcpToolsSnapshot(state.snapshot!.recordKey, state.page!.nextIndex!);
      else if (choice.kind === 'previousTools') void controller.previousMcpToolsPage();
      else if (choice.kind === 'back') controller.backMcpTools();
      else if (state.screen === 'descriptor' && state.entry)
        void controller.selectMcpTool(state.entry.index);
      else if (state.screen === 'tools' && state.snapshot)
        void controller.selectMcpToolsSnapshot(
          state.snapshot.recordKey,
          state.pageStarts?.at(-1) ?? 0,
        );
      else void controller.openMcpTools();
    }
  });
  const offset = Math.max(0, Math.min(selected - 2, choices.length - 5));
  const label = (choice: Choice): string => {
    if (choice.kind === 'snapshot') {
      const snapshot = state.snapshots!.items.find((value) => value.recordKey === choice.key)!;
      return `${t('Generation')} ${snapshot.origin.generation} · ${snapshot.toolCount} ${t('tools')} · ${snapshot.availability} · ${snapshot.origin.serverId}`;
    }
    if (choice.kind === 'tool') {
      const entry = state.page!.entries.find((value) => value.index === choice.index)!;
      const full = terminalText(`${entry.index + 1}. ${entry.label}`);
      const lines = mcpTextRows(full, 44);
      return `${mcpTextWindow(full, lines, 0, 1)[0]}${entry.labelComplete && lines.length === 1 ? '' : ` ${t('[name preview]')}`}`;
    }
    return {
      nextSnapshots: t('Next saved snapshots'),
      nextTools: t('Next tools'),
      previousTools: t('Previous tools'),
      back: t('Back'),
      retry: t('Retry read'),
    }[choice.kind];
  };
  return (
    <Box flexDirection="column">
      <Text bold>{t('MCP Tools · saved metadata')}</Text>
      <Text>{t('Reading does not connect or authorize tools.')}</Text>
      {state.snapshot && (
        <Text>
          {terminalText(state.snapshot.origin.serverId)} · {t('original generation')}{' '}
          {state.snapshot.origin.generation}
        </Text>
      )}
      {state.page && (
        <Text>
          {t(state.page.live ? 'Live connection observed' : 'Historical snapshot')} ·{' '}
          {t('current generation')} {state.page.currentGeneration ?? t('unavailable')}
        </Text>
      )}
      {state.phase === 'reading' && <Text>{t('Reading original metadata · incomplete')}</Text>}
      {state.error && <Text>{terminalText(state.error)}</Text>}
      {state.page?.availability === 'unavailable' && (
        <Text>
          {t('Metadata unavailable')} ·{' '}
          {state.page.reason === null ? t('unavailable') : terminalText(state.page.reason)}
        </Text>
      )}
      {state.screen === 'tools' && state.page?.availability === 'available' && (
        <Text>
          {t('Tools')} {state.page.startIndex + 1}–
          {state.page.startIndex + state.page.entries.length} / {state.page.toolCount} ·{' '}
          {t(state.page.complete ? 'last index page' : 'more pages')}
        </Text>
      )}
      {state.screen === 'descriptor' && state.metadata ? (
        <>
          <Text>{t('Complete metadata · EOF and hash verified')}</Text>
          {!('outputSchema' in state.metadata) && <Text>{t('outputSchema: absent')}</Text>}
          {mcpTextWindow(text, rows, line).map((value, index) => (
            <Text key={`${line + index}`}>{value || ' '}</Text>
          ))}
          <Text>
            {t('Rows')} {line + 1}–{Math.min(rows.length, line + 10)} / {rows.length}
          </Text>
          <Text>{t('↑/↓ scroll · ←/→ page · Home/End · Esc back')}</Text>
        </>
      ) : (
        <>
          {choices.slice(offset, offset + 5).map((choice, index) => (
            <Text key={`${offset + index}`}>
              {selected === offset + index ? '›' : ' '}{' '}
              {
                mcpTextWindow(
                  terminalText(label(choice)),
                  mcpTextRows(terminalText(label(choice)), 64),
                  0,
                  1,
                )[0]
              }
            </Text>
          ))}
          <Text>{t('↑/↓ choose · Enter read · Esc back')}</Text>
        </>
      )}
    </Box>
  );
}
