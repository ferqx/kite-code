import { useInput, usePaste } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { ComposerBuffer, composerDisplay } from './composer';
import { type TuiController, terminalText } from './controller';
import OverlayChoiceList from './ink/OverlayChoiceList';
import TuiOverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlayListRow } from './ink/OverlayPrimitives';
import OverlaySearchInput from './ink/OverlaySearchInput';
import type { TuiMcpSourceSnapshot } from './mcp-source';
import type { TuiMcpSourceEntryPreview, TuiMcpSourceMutationInput } from './mcp-source-mutation';
import { toolMetadataText } from './mcp-tools-panel';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

type Review = {
  action: 'mcp.source.add' | 'mcp.source.remove';
  input: TuiMcpSourceMutationInput;
  observed: TuiMcpSourceSnapshot;
  preview?: TuiMcpSourceEntryPreview;
};
export function TuiMcpSourceMutationPanel({ controller }: { controller: TuiController }) {
  const { t: originalLabel } = useInkI18n();
  const state = controller.state,
    { t, testDiagnostics } = useTuiPresentation(),
    facts = state.mcpMutationFacts;
  const [index, setIndex] = useState(0),
    [step, setStep] = useState<'list' | 'name' | 'type' | 'value' | 'scope' | 'review' | 'confirm'>(
      'list',
    ),
    [name, setName] = useState(''),
    [transport, setTransport] = useState<'http' | 'stdio'>('http'),
    [value, setValue] = useState(''),
    [scope, setScope] = useState<'user' | 'workspace'>('workspace'),
    [review, setReview] = useState<Review>(),
    [error, setError] = useState<string>(),
    [offset, setOffset] = useState(0),
    [reading, setReading] = useState(false),
    [, render] = useState(0);
  const buffer = useRef(new ComposerBuffer()),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const choices = [
    { kind: 'add' as const, label: t('Add source entry') },
    ...(facts?.items ?? []).map((row) => ({
      kind: 'remove' as const,
      id: row.id,
      label: `${t('Remove source entry:')} ${row.name} · ${row.source.kind}`,
    })),
    ...(state.mcpMutationSaved ?? []).map((row) => ({
      kind: 'original' as const,
      id: row.intent.request.commandId,
      label: `${t('Original source change:')} ${testDiagnostics ? row.intent.request.commandId : (state.mcpMutationSaved ?? []).indexOf(row) + 1}`,
    })),
    ...(state.mcpMutationOutcome
      ? [{ kind: 'check' as const, label: t('Check original source change') }]
      : []),
    { kind: 'back' as const, label: originalLabel('common.back') },
  ];
  const editable = step === 'name' || step === 'value';
  buffer.current.sync(step === 'name' ? name : value);
  const update = () => {
    const text = buffer.current.text;
    if (text.length > 8192) {
      setError(t('Source entry input exceeds limit'));
      return;
    }
    if (step === 'name') setName(text);
    else setValue(text);
    render((n) => n + 1);
  };
  usePaste(
    (text) => {
      if (editable) {
        buffer.current.insert(text, true);
        update();
      }
    },
    { isActive: editable },
  );
  const full = review
    ? (testDiagnostics ? JSON.stringify : (value: unknown) => toolMetadataText(value))(
        {
          scope: review.input.scope,
          ...('name' in review.input
            ? { name: review.input.name, entry: review.input.entry }
            : { target: review.preview?.target, fallback: review.preview?.fallback }),
        },
        null,
        2,
      )
    : '';
  const lines = full.split('\n').flatMap((line) => {
    const chars = Array.from(terminalText(line));
    const rows: string[] = [];
    for (let i = 0; i < chars.length; i += 64) rows.push(chars.slice(i, i + 64).join(''));
    return rows.length ? rows : [''];
  });
  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape) {
      if (step === 'list') {
        controller.closeMcpSourceMutations();
        return;
      }
      if (step === 'confirm') setStep('review');
      else if (step === 'review') setStep(review?.action === 'mcp.source.add' ? 'scope' : 'list');
      else
        setStep(
          step === 'scope'
            ? 'value'
            : step === 'value'
              ? 'name'
              : step === 'name'
                ? 'type'
                : 'list',
        );
      return;
    }
    if (key.ctrl || key.meta || reading) return;
    if (editable) {
      if (key.return) {
        if (step === 'name') {
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
            ['constructor', 'prototype'].includes(name)
          ) {
            setError(t('Invalid source entry name'));
            return;
          }
          setError(undefined);
          setStep('value');
        } else {
          let valid = false;
          if (transport === 'http') {
            try {
              const url = new URL(value);
              valid =
                value.length <= 8192 &&
                !value.includes('${') &&
                !value.includes('?') &&
                !value.includes('#') &&
                !Array.from(value).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) &&
                ['http:', 'https:'].includes(url.protocol) &&
                !url.username &&
                !url.password;
            } catch {}
          } else
            valid =
              value.length <= 4096 &&
              value.startsWith('/') &&
              !value.includes('${') &&
              !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
          if (!valid) {
            setError(t('Invalid source entry value'));
            return;
          }
          setError(undefined);
          setStep('scope');
        }
        return;
      }
      if (key.leftArrow) buffer.current.horizontal(-1);
      else if (key.rightArrow) buffer.current.horizontal(1);
      else if (key.home) buffer.current.boundary(false, 64);
      else if (key.end) buffer.current.boundary(true, 64);
      else if (key.backspace) buffer.current.remove(true);
      else if (key.delete) buffer.current.remove(false);
      else if (input) buffer.current.insert(input);
      update();
      return;
    }
    if (step === 'type') {
      if (key.upArrow || key.downArrow) setTransport((v) => (v === 'http' ? 'stdio' : 'http'));
      else if (key.return) setStep('name');
      return;
    }
    if (step === 'scope') {
      if (key.upArrow || key.downArrow) setScope((v) => (v === 'user' ? 'workspace' : 'user'));
      else if (key.return && facts?.readSet) {
        const entry =
          transport === 'http'
            ? { type: 'http' as const, url: value }
            : { type: 'stdio' as const, command: value };
        setReview({
          action: 'mcp.source.add',
          input: { scope, name, entry, expectedReadSet: facts.readSet },
          observed: facts,
        });
        setOffset(0);
        setStep('review');
      }
      return;
    }
    if (step === 'review' || step === 'confirm') {
      if (key.upArrow) setOffset((v) => Math.max(0, v - 1));
      else if (key.downArrow) setOffset((v) => Math.min(Math.max(0, lines.length - 8), v + 1));
      else if (key.home) setOffset(0);
      else if (key.end) setOffset(Math.max(0, lines.length - 8));
      else if (key.return && review) {
        if (step === 'review') {
          setOffset(0);
          setStep('confirm');
        } else {
          void controller.submitMcpSourceMutation(review.action, review.input, review.observed);
          setStep('list');
        }
      }
      return;
    }
    if (key.upArrow) setIndex((v) => Math.max(0, v - 1));
    else if (key.downArrow) setIndex((v) => Math.min(choices.length - 1, v + 1));
    else if (key.return) {
      const choice = choices[index];
      if (!choice) return;
      if (choice.kind === 'back') controller.closeMcpSourceMutations();
      else if (choice.kind === 'check') void controller.lookupMcpSourceMutation();
      else if (choice.kind === 'original') controller.selectMcpSourceMutation(choice.id);
      else if (choice.kind === 'add') {
        if (!facts?.readSet) {
          setError(t('Source directory unavailable'));
          return;
        }
        setStep('type');
        setError(undefined);
      } else if (facts?.readSet) {
        const row = facts.items.find((r) => r.id === choice.id);
        if (!row) return;
        setReading(true);
        void controller.previewMcpSourceRemoval(row.id, row.source.kind, facts).then((preview) => {
          if (!alive.current) return;
          setReading(false);
          if (!preview) {
            setError(t('Source removal preview unavailable'));
            return;
          }
          setReview({
            action: 'mcp.source.remove',
            input: {
              scope: row.source.kind,
              serverId: row.id,
              expectedRawEntryDigest: row.rawEntryDigest,
              expectedReadSet: facts.readSet!,
            },
            observed: facts,
            preview,
          });
          setOffset(0);
          setStep('review');
        });
      }
    }
  });
  const start = Math.max(0, index - 2);
  const editingRow = buffer.current.row(64, (part) => composerDisplay(part, t));
  const editingLine = editingRow.lines[editingRow.index]!;
  return (
    <TuiOverlayFrame
      title={
        step === 'list'
          ? t('MCP server configuration')
          : review?.action === 'mcp.source.remove'
            ? t('Remove MCP server')
            : t('Add MCP server')
      }
      meta={step === 'list' ? `${index + 1} / ${choices.length}` : undefined}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: t(editable ? 'Edit' : 'Select') },
            { keys: 'Enter', label: originalLabel('rewind.continue') },
            { keys: 'Esc', label: originalLabel('common.back') },
          ]}
        />
      }
    >
      <Text>
        {t(
          'Removal clears owned OAuth credentials locally; shared credentials are retained. Connection status is separate.',
        )}
      </Text>
      {review?.action === 'mcp.source.remove' && (step === 'review' || step === 'confirm') ? (
        <Text>
          {review.preview?.fallback
            ? `${t('Removal reveals user source:')} ${terminalText(review.preview.fallback.name)}`
            : t('Removal reveals no fallback source.')}
        </Text>
      ) : null}
      {step === 'list' ? (
        <>
          {choices.slice(start, start + 5).map((row, i) => (
            <OverlayListRow
              key={
                row.kind === 'remove' || row.kind === 'original'
                  ? `${row.kind}:${row.id}`
                  : row.kind
              }
              selected={index === start + i}
              primary={row.label}
            />
          ))}
          <Text>{t('↑/↓ choose · Enter select · Esc back')}</Text>
        </>
      ) : step === 'name' || step === 'value' ? (
        <>
          <OverlaySearchInput
            active
            value={step === 'name' ? name : value}
            onChange={() => undefined}
            label={t(
              testDiagnostics
                ? step === 'name'
                  ? 'Source entry name'
                  : 'Source entry value'
                : step === 'name'
                  ? 'Source entry name'
                  : transport === 'http'
                    ? 'Server URL'
                    : 'Server command',
            )}
            editor={
              <Text>
                {buffer.current.parts.slice(editingLine.start, editingLine.end).map((part, i) => (
                  <Text
                    key={editingLine.start + i}
                    inverse={buffer.current.cursor === editingLine.start + i}
                  >
                    {composerDisplay(part, t)}
                  </Text>
                ))}
                {buffer.current.cursor === editingLine.end && <Text inverse> </Text>}
              </Text>
            }
          />
          <Text>{t('Enter continues; no configuration is submitted.')}</Text>
        </>
      ) : step === 'type' ? (
        <OverlayChoiceList
          selectedId={transport}
          options={[
            { id: 'http', label: 'HTTP', description: t('Connect to an MCP server at a URL.') },
            {
              id: 'stdio',
              label: 'STDIO',
              description: t('Launch an MCP server as a local process.'),
            },
          ]}
        />
      ) : step === 'scope' ? (
        <OverlayChoiceList
          selectedId={scope}
          options={[
            {
              id: 'workspace',
              label: t('Current project'),
              description: t('Make this MCP server available in the current project.'),
            },
            {
              id: 'user',
              label: t('All projects'),
              description: t('Make this MCP server available in all projects.'),
            },
          ]}
        />
      ) : (
        <>
          <Text bold>
            {t(step === 'review' ? 'Review source entry change' : 'Confirm source entry change')}
          </Text>
          {lines.slice(offset, offset + 8).map((line, i) => (
            <Text key={`${offset + i}:${line}`}>{line}</Text>
          ))}
          <Text>{t('↑/↓ scroll · Home/End · Enter continues · Esc back')}</Text>
          <Text>
            {t(
              step === 'review'
                ? 'Enter opens independent confirmation.'
                : 'Enter submits a new ordinary request; approval is separate.',
            )}
          </Text>
        </>
      )}
      {reading || state.mcpMutationFactsReading || state.mcpMutationReading ? (
        <Text>{t('Reading source entry facts')}</Text>
      ) : null}
      {state.mcpMutationOutcome && step === 'list' ? (
        <>
          {testDiagnostics && (
            <Text>
              {t('Original source change:')}{' '}
              {terminalText(state.mcpMutationOutcome.intent.request.commandId)}
            </Text>
          )}
          {testDiagnostics && (
            <Text>
              {t('Original Store:')}{' '}
              {terminalText(state.mcpMutationOutcome.intent.request.expectedStoreId)} ·{' '}
              {t('Session')} {terminalText(state.mcpMutationOutcome.intent.sessionId)}
            </Text>
          )}
          <Text>
            {testDiagnostics
              ? state.mcpMutationOutcome.phase
              : t(
                  {
                    pending: 'Waiting for configuration change',
                    completed: 'Configuration change saved',
                    saved: 'Configuration change saved',
                    failed: 'Configuration change failed',
                    cancelled: 'Configuration change cancelled',
                    outcome_unknown: 'Configuration change outcome unknown',
                  }[state.mcpMutationOutcome.phase] ?? state.mcpMutationOutcome.phase,
                )}
          </Text>
          {state.mcpMutationOutcome.fact?.credentialCleanup && (
            <Text>
              {t('Credential cleanup:')}{' '}
              {t(
                {
                  not_attempted: 'Credential cleanup not attempted',
                  not_needed: 'No owned OAuth credentials to clear',
                  completed: 'Owned OAuth credentials cleared',
                  failed: 'Source removed; credential cleanup failed',
                  outcome_unknown: 'Source removed; credential cleanup unknown',
                }[state.mcpMutationOutcome.fact.credentialCleanup.status],
              )}
            </Text>
          )}
        </>
      ) : null}
      {error || state.mcpMutationError ? (
        <Text>
          {t('Error:')} {terminalText(error ?? t(state.mcpMutationError ?? ''))}
        </Text>
      ) : null}
    </TuiOverlayFrame>
  );
}
