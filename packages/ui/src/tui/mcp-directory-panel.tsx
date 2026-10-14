import { useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import TuiOverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlayListRow } from './ink/OverlayPrimitives';
import type { TuiMcpReadDirectory } from './mcp';
import { mcpTextRows, mcpTextWindow } from './mcp-tools';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** Local, retained external data. Enter reads a descriptor, never invokes its prompt. */
export function TuiMcpDirectoryPanel({
  controller,
  family,
  serverId,
  onBack,
}: {
  controller: TuiController;
  family: 'resources' | 'prompts';
  serverId?: string;
  onBack(): void;
}) {
  const { t, testDiagnostics } = useTuiPresentation();
  const sessionId = controller.state.sessionId;
  const [page, setPage] = useState<TuiMcpReadDirectory>(),
    [failed, setFailed] = useState(false),
    [reading, setReading] = useState(true),
    [cursor, setCursor] = useState<string>(),
    [attempt, setAttempt] = useState(0),
    [selected, setSelected] = useState(0),
    [descriptor, setDescriptor] = useState<Readonly<Record<string, unknown>>>(),
    [line, setLine] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry starts a fresh bounded read.
  useEffect(() => {
    const abort = new AbortController();
    setReading(true);
    setFailed(false);
    setPage(undefined);
    setSelected(0);
    setDescriptor(undefined);
    if (!sessionId || !controller.port.mcp?.readDirectory) {
      setFailed(true);
      setReading(false);
      return;
    }
    void controller.port.mcp
      .readDirectory(sessionId, family, abort.signal, {
        ...(serverId ? { serverId } : {}),
        ...(cursor ? { afterKey: cursor } : {}),
      })
      .then((value) => {
        if (abort.signal.aborted) return;
        if (value.sessionId !== sessionId || value.family !== family)
          throw Error('mcp_directory_scope_changed');
        setPage(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setReading(false);
      });
    return () => abort.abort();
  }, [controller, sessionId, family, serverId, cursor, attempt]);
  const validPage =
    page && page.sessionId === sessionId && page.family === family ? page : undefined;
  const entries = (validPage?.items ?? []).flatMap((snapshot) =>
    snapshot.descriptors.map((value) => ({ snapshot, value })),
  );
  const text = useMemo(
    () => (descriptor ? terminalText(JSON.stringify(descriptor, null, 2)) : ''),
    [descriptor],
  );
  const lines = useMemo(() => mcpTextRows(text), [text]);
  const choices = entries.length + (page?.nextAfterKey ? 1 : 0) + 1;
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      controller.closePanel();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.escape) {
      if (descriptor) {
        setDescriptor(undefined);
        setLine(0);
      } else if (cursor) setCursor(undefined);
      else onBack();
      return;
    }
    if (reading) return;
    if (descriptor) {
      const last = Math.max(0, lines.length - 8);
      if (key.upArrow) setLine((value) => Math.max(0, value - 1));
      else if (key.downArrow) setLine((value) => Math.min(last, value + 1));
      else if (key.home) setLine(0);
      else if (key.end) setLine(last);
      else if (key.return) setDescriptor(undefined);
      return;
    }
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(choices - 1, value + 1));
    else if (key.return) {
      if (failed) setAttempt((value) => value + 1);
      else if (entries[selected]) {
        setDescriptor(entries[selected]!.value);
        setLine(0);
      } else if (selected === entries.length && page?.nextAfterKey) setCursor(page.nextAfterKey);
      else onBack();
    }
  });
  const offset = Math.max(0, selected - 4);
  return (
    <TuiOverlayFrame
      title={t(family === 'prompts' ? 'Saved MCP prompts' : 'Saved MCP resources')}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: t('Select') },
            { keys: 'Enter', label: t('Read details') },
            { keys: 'Esc', label: t('Back') },
          ]}
        />
      }
    >
      <Text>{t('Retained external data; reading does not connect or execute a prompt.')}</Text>
      {reading && <Text>{t('Reading saved directory')}</Text>}
      {failed && <Text>{t('Saved directory unavailable; Enter retries')}</Text>}
      {!reading && !failed && !descriptor && !entries.length && (
        <Text>{t('No saved descriptors in this window')}</Text>
      )}
      {descriptor ? (
        <Text>{mcpTextWindow(text, lines, line, 8).join('\n')}</Text>
      ) : (
        entries
          .slice(offset, offset + 5)
          .map((entry, index) => (
            <OverlayListRow
              key={`${entry.snapshot.key}:${offset + index}`}
              selected={selected === offset + index}
              primary={terminalText(String(entry.value.name))}
              secondary={terminalText(
                `${controller.state.mcp?.facts?.labels?.[entry.snapshot.serverId] ?? t('Saved server')} · ${typeof entry.value.description === 'string' ? entry.value.description : ''}`,
              )}
              trailing={
                <Text>{t(entry.snapshot.live ? 'Live binding' : 'Historical binding')}</Text>
              }
            />
          ))
      )}
      {!descriptor && !reading && !failed && (
        <>
          {page?.nextAfterKey && (
            <OverlayListRow
              selected={selected === entries.length}
              primary={t('Next saved window')}
            />
          )}
          <OverlayListRow selected={selected === choices - 1} primary={t('Back')} />
        </>
      )}
      {testDiagnostics && <Text>{terminalText(JSON.stringify(page))}</Text>}
    </TuiOverlayFrame>
  );
}
