import type { ModelSettingsRequest, ModelSettingsView } from '@kite-ai/client';
import { Box, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';
export function TuiModelPanel({ controller }: { controller: TuiController }) {
  const { t } = useTuiPresentation();
  const state = controller.state,
    facts = state.models;
  const effortPanel = state.panel === 'effort';
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
    setIndex(0);
    setPending(undefined);
  }, [facts, effortPanel]);
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
        void controller.chooseModel(pending.operation, pending.observed);
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
          !selected ||
          selected.reasoningEffortSupport !== 'compatible_wire' ||
          selected.reasoningEffortReadonlyReason
        )
          return;
        const choices = [null, ...(selected.reasoningEffortChoices ?? [])];
        if (key.return && index >= 0 && index < choices.length)
          setPending({
            observed: facts,
            operation: {
              kind: 'effort',
              modelId: selected.id,
              reasoningEffort: choices[index]!,
            },
          });
        return;
      }
      if (!row) return;
      if (key.return)
        setPending({ observed: facts, operation: { kind: 'default', modelId: row.id } });
      else if (input === 'e')
        setPending({
          observed: facts,
          operation: { kind: 'enabled', modelId: row.id, enabled: !row.enabled },
        });
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>
        {effortPanel ? t('Reasoning effort') : t('Models')} {t('· Workspace')}{' '}
        {terminalText(facts?.workspaceId ?? t('unavailable'))}
      </Text>
      <Text>
        {t(
          'Saved project settings apply to later executions; active Run keeps its original model.',
        )}
      </Text>
      {!facts ? (
        <Text>{t('Reading actual configured models')}</Text>
      ) : (
        <>
          <Text>
            {t('Desired default:')} {terminalText(facts.defaultModelId ?? t('none'))} {'·'}{' '}
            {state.stale ? t('stale / read only') : t('available')}
          </Text>
          {effortPanel ? (
            <>
              <Text>
                {t('Current effective effort:')}{' '}
                {facts.models.find((m) => m.id === facts.defaultModelId)?.reasoningEffort ??
                  t('unspecified')}
              </Text>
              {facts.models.find((m) => m.id === facts.defaultModelId)
                ?.reasoningEffortReadonlyReason && (
                <Text>
                  {t('Read only:')}{' '}
                  {terminalText(
                    facts.models.find((m) => m.id === facts.defaultModelId)!
                      .reasoningEffortReadonlyReason!,
                  )}
                </Text>
              )}
              <Text>
                {t('Adapter wire vocabulary only; actual provider may reject unsupported effort.')}
              </Text>
              {facts.models.find((m) => m.id === facts.defaultModelId)?.reasoningEffortSupport !==
              'compatible_wire' ? (
                <Text>{t('Reasoning effort unavailable for this model')}</Text>
              ) : (
                [
                  null,
                  ...(facts.models.find((m) => m.id === facts.defaultModelId)
                    ?.reasoningEffortChoices ?? []),
                ].map((e, i) => (
                  <Text key={e ?? 'clear'}>
                    {index === i ? '›' : ' '}{' '}
                    {e ?? t('clear project effort (read resulting value)')}
                  </Text>
                ))
              )}
            </>
          ) : (
            <>
              {rows.map((row, i) => (
                <Text key={row.id}>
                  {i === index ? '›' : ' '} {terminalText(row.provider ?? t('unavailable'))} {'/'}{' '}
                  {terminalText(row.id)} {'·'} {terminalText(row.model ?? t('unavailable'))} {'·'}{' '}
                  {row.enabled ? t('enabled') : t('disabled')} {'·'}{' '}
                  {row.configured ? t('configured') : t('incomplete')}{' '}
                  {terminalText(row.diagnostics.join(' '))}
                </Text>
              ))}
            </>
          )}
          {!rows.length && <Text>{t('No configured models; unavailable')}</Text>}
          {facts.errors.map((e) => (
            <Text key={e}>{terminalText(e)}</Text>
          ))}
          <Text>
            {effortPanel
              ? t('↑↓ choose effort · Enter review effort')
              : t('↑↓ select exact ID · Enter review default · E review enabled')}{' '}
            {t('· R read · K original outcome · Esc close')}
          </Text>
        </>
      )}
      {pending && (
        <Text>
          {t('Confirm original project change')} {terminalText(JSON.stringify(pending.operation))}
          {t('; Enter save / Esc abandon')}
        </Text>
      )}
      {state.modelOutcome && (
        <Text>
          {t('Original')} {terminalText(state.modelOutcome.intent.request.commandId)}
          {':'} {state.modelOutcome.status}
        </Text>
      )}
    </Box>
  );
}
