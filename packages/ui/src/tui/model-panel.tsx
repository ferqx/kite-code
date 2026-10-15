import type { ModelSettingsRequest, ModelSettingsView } from '@kite-ai/client';
import { Box, useInput, useStdout } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import TuiOverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './ink/OverlayFrame';
import {
  OverlayEmptyState,
  OverlayListRow,
  OverlayMessage,
  OverlaySection,
} from './ink/OverlayPrimitives';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';
/** Preserve original four-choice navigation while retaining every actually offered new effort. */
export function orderedTuiEfforts(
  choices: ModelSettingsView['models'][number]['reasoningEffortChoices'],
) {
  const originalOrder = ['low', 'medium', 'high', 'max'];
  const offered = choices ?? [];
  return [
    ...offered
      .filter((choice) => originalOrder.includes(choice))
      .sort((a, b) => originalOrder.indexOf(a) - originalOrder.indexOf(b)),
    null,
    ...offered.filter((choice) => !originalOrder.includes(choice)),
  ];
}
export function TuiModelPanel({ controller }: { controller: TuiController }) {
  const { t: originalLabel, language: inkLanguage } = useInkI18n();
  const { t, testDiagnostics } = useTuiPresentation();
  const state = controller.state,
    facts = state.models;
  const effortPanel = state.panel === 'effort';
  const { stdout } = useStdout();
  const page = Math.max(2, Math.min(8, (stdout.rows ?? 24) - 13));
  const rows = [...(facts?.models ?? [])].sort(
    (a, b) => (a.provider ?? '').localeCompare(b.provider ?? '') || a.id.localeCompare(b.id),
  );
  const [index, setIndex] = useState(0),
    [pending, setPending] = useState<{
      operation: ModelSettingsRequest['operation'];
      observed: ModelSettingsView;
    }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new public observation invalidates the selected index and pending confirmation.
  useEffect(() => {
    const selected = facts?.models.find((model) => model.id === facts.defaultModelId);
    setIndex(
      effortPanel
        ? Math.max(
            0,
            orderedTuiEfforts(selected?.reasoningEffortChoices).indexOf(
              selected?.reasoningEffort ?? null,
            ),
          )
        : Math.max(
            0,
            rows.findIndex((model) => model.id === facts?.defaultModelId),
          ),
    );
    setPending(undefined);
  }, [facts, effortPanel]);
  const apply = (operation: ModelSettingsRequest['operation'], observed: ModelSettingsView) => {
    const originalSessionId = state.sessionId,
      panel = state.panel,
      previousCommandId = state.modelOutcome?.intent.request.commandId;
    void controller.chooseModel(operation, observed).then(() => {
      const outcome = controller.state.modelOutcome;
      if (
        !testDiagnostics &&
        controller.state.sessionId === originalSessionId &&
        controller.state.panel === panel &&
        outcome?.status === 'applied' &&
        outcome.intent.request.commandId !== previousCommandId &&
        JSON.stringify(outcome.intent.request.operation) === JSON.stringify(operation)
      )
        controller.closePanel();
    });
  };
  useInput((input, key) => {
    if (key.ctrl) return;
    if (key.escape) {
      if (pending) setPending(undefined);
      else controller.closePanel();
      return;
    }
    if (input === 'r') {
      setPending(undefined);
      void controller.openModels(effortPanel ? 'effort' : 'models');
      return;
    }
    if (input === 'k') {
      void controller.lookupModel();
      return;
    }
    if (!facts) return;
    if (pending) {
      if (key.return) {
        apply(pending.operation, pending.observed);
        setPending(undefined);
      }
      return;
    }
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow)
      setIndex((i) =>
        Math.min(
          (effortPanel
            ? (facts.models.find((m) => m.id === facts.defaultModelId)?.reasoningEffortChoices
                ?.length ?? 0) + 1
            : rows.length) - 1,
          i + 1,
        ),
      );
    else {
      const row = rows[index];
      if (effortPanel) {
        const selected = facts.models.find((m) => m.id === facts.defaultModelId);
        if (
          selected?.reasoningEffortSupport !== 'compatible_wire' ||
          selected.reasoningEffortReadonlyReason
        )
          return;
        const choices = orderedTuiEfforts(selected.reasoningEffortChoices);
        if (key.return && index >= 0 && index < choices.length)
          apply({ kind: 'effort', modelId: selected.id, reasoningEffort: choices[index]! }, facts);
        return;
      }
      if (!row) return;
      if (key.return) apply({ kind: 'default', modelId: row.id }, facts);
      else if (input === 'e')
        setPending({
          observed: facts,
          operation: { kind: 'enabled', modelId: row.id, enabled: !row.enabled },
        });
    }
  });
  const offset = Math.max(0, Math.min(index - Math.floor(page / 2), rows.length - page));
  const selectedModel = facts?.models.find((model) => model.id === facts.defaultModelId);
  const efforts = orderedTuiEfforts(selectedModel?.reasoningEffortChoices);
  const effortDescriptions: Record<string, string> = {
    low: 'Faster responses with less reasoning.',
    medium: 'Balanced reasoning and speed.',
    high: 'More reasoning for difficult tasks.',
    max: 'Maximum reasoning for demanding tasks.',
    minimal: 'Minimal reasoning for simple tasks.',
    xhigh: 'Extended reasoning for difficult tasks.',
    none: 'Turn reasoning off.',
  };
  const displayModel = (id: string) => facts?.models.find((model) => model.id === id)?.model ?? id;
  return (
    <TuiOverlayFrame
      title={
        effortPanel
          ? testDiagnostics
            ? t('Reasoning effort')
            : originalLabel('effort.title')
          : testDiagnostics
            ? t('Models')
            : originalLabel('model.title')
      }
      meta={`${index + 1} / ${effortPanel ? efforts.length : rows.length}`}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: originalLabel('common.select') },
            { keys: 'Enter', label: originalLabel('common.confirm') },
            ...(!effortPanel ? [{ keys: 'E', label: t('Enable / Disable') }] : []),
            { keys: 'R', label: t('Refresh') },
            { keys: 'K', label: t('Check original request') },
            { keys: 'Esc', label: t(pending ? 'Back' : 'Close') },
          ]}
        />
      }
    >
      {!facts ? (
        <OverlayMessage tone="busy">{t('Reading actual configured models')}</OverlayMessage>
      ) : (
        <>
          {effortPanel ? (
            <>
              {selectedModel?.reasoningEffortReadonlyReason && (
                <OverlayMessage tone="warning">
                  {terminalText(selectedModel.reasoningEffortReadonlyReason)}
                </OverlayMessage>
              )}
              {selectedModel?.reasoningEffortSupport !== 'compatible_wire' ? (
                <OverlayEmptyState>
                  {t('Reasoning effort unavailable for this model')}
                </OverlayEmptyState>
              ) : (
                efforts.map((effort, i) => (
                  <OverlayListRow
                    key={effort ?? 'clear'}
                    selected={index === i}
                    primary={
                      effort === null
                        ? t('Default')
                        : !testDiagnostics && ['low', 'medium', 'high', 'max'].includes(effort)
                          ? originalLabel(
                              `effort.${effort}` as
                                | 'effort.low'
                                | 'effort.medium'
                                | 'effort.high'
                                | 'effort.max',
                            )
                          : t(effort)
                    }
                    secondary={
                      effort === null
                        ? t('Use the configured default reasoning effort.')
                        : ['low', 'medium', 'high', 'max'].includes(effort)
                          ? originalLabel(
                              `effort.${effort}Description` as
                                | 'effort.lowDescription'
                                | 'effort.mediumDescription'
                                | 'effort.highDescription'
                                | 'effort.maxDescription',
                            )
                          : t(
                              effortDescriptions[effort] ??
                                'Reasoning effort supported by this model.',
                            )
                    }
                    trailing={
                      <OverlayStatusColumn
                        active={effort === (selectedModel?.reasoningEffort ?? null)}
                        label={inkLanguage === 'zh-CN' ? '当前' : 'Current'}
                      />
                    }
                  />
                ))
              )}
            </>
          ) : (
            <Box flexDirection="column">
              {rows.slice(offset, offset + page).map((model, i) => {
                const rowIndex = offset + i;
                const duplicate = rows.some(
                  (other) =>
                    other.id !== model.id &&
                    other.provider === model.provider &&
                    other.model === model.model,
                );
                return (
                  <Box key={model.id} flexDirection="column">
                    {(i === 0 || rows[rowIndex - 1]?.provider !== model.provider) && (
                      <OverlaySection first={i === 0}>
                        {terminalText(model.provider ?? t('Unavailable'))}
                      </OverlaySection>
                    )}
                    <OverlayListRow
                      selected={index === rowIndex}
                      primary={terminalText(model.model ?? model.id)}
                      secondary={
                        !model.configured
                          ? t('Model configuration incomplete')
                          : !model.enabled
                            ? t('Disabled')
                            : duplicate
                              ? terminalText(model.id)
                              : undefined
                      }
                      trailing={
                        <OverlayStatusColumn
                          active={model.id === facts.defaultModelId}
                          label={inkLanguage === 'zh-CN' ? '当前' : 'Current'}
                        />
                      }
                    />
                    {testDiagnostics && (
                      <Text>
                        {terminalText(model.id)} · {t(model.enabled ? 'enabled' : 'disabled')} ·{' '}
                        {t(model.configured ? 'configured' : 'incomplete')} ·{' '}
                        {terminalText(model.diagnostics.join(' '))}
                      </Text>
                    )}
                  </Box>
                );
              })}
              {!rows.length && (
                <OverlayEmptyState>{t('No configured models; unavailable')}</OverlayEmptyState>
              )}
            </Box>
          )}
          {facts.errors.map((error) => (
            <OverlayMessage key={error} tone="error">
              {terminalText(error)}
            </OverlayMessage>
          ))}
          {state.stale && <OverlayMessage tone="warning">{t('stale / read only')}</OverlayMessage>}
          {testDiagnostics && (
            <Text>
              {t(
                effortPanel
                  ? '↑↓ choose effort · Enter review effort'
                  : '↑↓ select exact ID · Enter review default · E review enabled',
              )}{' '}
              · {t('Desired default:')} {terminalText(facts.defaultModelId ?? t('none'))} ·{' '}
              {t('Adapter wire vocabulary only; actual provider may reject unsupported effort.')}
            </Text>
          )}
        </>
      )}
      {pending && (
        <OverlayMessage tone="warning" callout>
          {t('Confirm original user model change')}{' '}
          {pending.operation.kind === 'default'
            ? displayModel(pending.operation.modelId)
            : pending.operation.kind === 'enabled'
              ? `${displayModel(pending.operation.modelId)} · ${t(pending.operation.enabled ? 'enabled' : 'disabled')}`
              : `${displayModel(pending.operation.modelId)} · ${pending.operation.reasoningEffort ?? t('Default')}`}
          {t('; Enter save / Esc abandon')}
          {testDiagnostics && terminalText(JSON.stringify(pending.operation))}
        </OverlayMessage>
      )}
      {state.modelOutcome && (
        <OverlayMessage tone="info">
          {t('Original')}{' '}
          {testDiagnostics && terminalText(state.modelOutcome.intent.request.commandId)}:{' '}
          {state.modelOutcome.status}
        </OverlayMessage>
      )}
    </TuiOverlayFrame>
  );
}
