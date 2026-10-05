import type { SkillCataloguePage } from '@kite-ai/client';
import { Box, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import { TuiText as Text, type TuiTranslator, useTuiPresentation } from './presentation';
import { manualWorkflow } from './skills';

type SkillEntry = SkillCataloguePage['entries'][number];
/** Full metadata is reachable page by page; list previews never replace the original facts. */
export function skillDetails(
  entry: SkillEntry,
  t: TuiTranslator = (label) => label,
): readonly string[] {
  const text = [
    `${t('Name:')} ${entry.name ?? 'unavailable'}`,
    `${t('ID:')} ${entry.id}`,
    `${t('State:')} ${entry.state} ${t('· Reason:')} ${entry.reason ?? 'none'}`,
    `${t('Version:')} ${entry.version ?? 'unavailable'}`,
    `${t('Required capabilities:')} ${entry.requiredCapabilities.join(', ') || 'none'}`,
    `${t('Missing capabilities:')} ${entry.missingCapabilities.join(', ') || 'none'}`,
    `${t('Description:')} ${entry.description ?? 'unavailable'}`,
    ...(entry.workflow
      ? [
          `${t('Workflow:')} ${entry.workflow.state} · ${entry.workflow.reason ?? 'none'}`,
          `${t('Manual:')} ${entry.workflow.manualAllowed} · ${t('Input {}:')} ${entry.workflow.emptyInputValid}`,
          `${t('Workflow version:')} ${entry.workflow.revision ?? 'unavailable'}`,
        ]
      : []),
  ].join('\n');
  // At most 32 code points also fit 80 columns when every displayed point is wide.
  const lines = terminalText(text)
    .replaceAll('\t', '\\t')
    .split('\n')
    .flatMap((line) => {
      const points = Array.from(line);
      return points.length
        ? Array.from({ length: Math.ceil(points.length / 32) }, (_, index) =>
            points.slice(index * 32, (index + 1) * 32).join(''),
          )
        : [''];
    });
  return Array.from({ length: Math.ceil(lines.length / 6) }, (_, index) =>
    lines.slice(index * 6, (index + 1) * 6).join('\n'),
  );
}
export function TuiSkillsPanel({ controller }: { controller: TuiController }) {
  const { t } = useTuiPresentation();
  const state = controller.state,
    snapshot = state.skills,
    facts = snapshot?.facts;
  const entries = facts?.entries ?? [];
  const [selected, setSelected] = useState(0),
    [detailPage, setDetailPage] = useState(0);
  const index = Math.max(0, Math.min(selected, entries.length - 1)),
    entry = entries[index];
  const details = useMemo(() => (entry ? skillDetails(entry, t) : []), [entry, t]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different Skill fact resets the local detail page.
  useEffect(() => {
    setDetailPage(0);
  }, [entry?.id, entry?.version, entry?.state, entry?.reason]);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) controller.closePanel();
    else if (input.toLowerCase() === 'r') void controller.openSkills();
    else if (key.upArrow)
      setSelected((previous) => Math.max(0, Math.min(previous, entries.length - 1) - 1));
    else if (key.downArrow)
      setSelected((previous) => Math.min(Math.max(0, entries.length - 1), previous + 1));
    else if (key.leftArrow) setDetailPage((page) => Math.max(0, page - 1));
    else if (key.rightArrow)
      setDetailPage((page) => Math.min(Math.max(0, details.length - 1), page + 1));
  });
  const start = Math.max(0, Math.min(index - 2, entries.length - 5));
  return (
    <Box flexDirection="column">
      <Text>
        {t('Knowledge Skills · total')}{' '}
        {facts?.availability === 'available' ? entries.length : 'unknown'}
      </Text>
      <Text>
        {t(
          facts?.entries.some((value) => value.workflow)
            ? 'Read only · Use /name [task] in the composer'
            : 'Read only · Workflow activation is not available here',
        )}
      </Text>
      {entry?.workflow?.name &&
        facts &&
        snapshot?.read === 'verified' &&
        manualWorkflow(facts, entry.workflow.name) && (
          <Text>{`/${entry.workflow.name} [task]`}</Text>
        )}
      <Text>{t('Discovery does not grant tool permissions')}</Text>
      <Text>
        {t('Catalog read:')} {snapshot?.read ?? 'unknown'} {t('· Observation:')}{' '}
        {state.observationState}
      </Text>
      <Text>{t('↑/↓ entries · ←/→ details · R refresh · Esc back')}</Text>
      {facts && (
        <Text>
          {snapshot?.read === 'verified'
            ? `${t('Catalogue:')} ${facts.availability} · ${facts.reason ?? t('none')}`
            : t('Last confirmed catalogue (current unknown)')}
        </Text>
      )}
      {facts && (
        <Text>
          {t('Revision:')} {facts.revision}
        </Text>
      )}
      <Text>
        {t('Entry')} {entry ? index + 1 : 0}
        {'/'}
        {entries.length}
      </Text>
      {entries.slice(start, start + 5).map((value, offset) => {
        const name = Array.from(
          terminalText(value.name ?? value.id)
            .replaceAll('\t', '\\t')
            .replaceAll('\n', '\\n'),
        );
        return (
          <Text key={value.id}>
            {start + offset === index ? '> ' : '  '}
            {name.slice(0, 28).join('')}
            {name.length > 28 ? '…' : ''} {'['}
            {value.state}
            {']'}
          </Text>
        );
      })}
      {entry ? (
        <>
          <Text>
            {t('Details page')} {Math.min(detailPage + 1, details.length)}
            {'/'}
            {details.length}
          </Text>
          <Text>{details[Math.min(detailPage, details.length - 1)]}</Text>
        </>
      ) : (
        <Text>
          {facts?.availability === 'available'
            ? t('No configured Skill entries')
            : facts
              ? t('Catalogue source unavailable')
              : t('No confirmed catalogue')}
        </Text>
      )}
      {snapshot?.error && (
        <Text>
          {t('Current catalogue unknown:')} {snapshot.error}
          {t('; refresh original Workspace')}
        </Text>
      )}
    </Box>
  );
}
