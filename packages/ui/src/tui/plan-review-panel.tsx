import type { Interaction } from '@kite-ai/client';
import { Box, useInput, usePaste, useStdout } from 'ink';
import { useState } from 'react';
import { type ComposerBuffer, composerDisplay } from './composer';
import { isCtrlCBatch } from './composer-input';
import { terminalText } from './controller';
import OverlayChoiceList from './ink/OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';
import { TuiAnswerInput } from './question-panel';

export function TuiPlanReviewPanel({
  card,
  feedback,
  onAnswer,
  busy = false,
  error,
}: {
  card: Interaction;
  feedback: ComposerBuffer;
  onAnswer(answer: string): void;
  busy?: boolean;
  error?: string;
}) {
  const { t } = useTuiPresentation();
  const { t: translate } = useInkI18n();
  const { stdout } = useStdout();
  const [editing, setEditing] = useState(false);
  const [showEmptyHint, setShowEmptyHint] = useState(false);
  const [selected, setSelected] = useState<number>();
  const [, render] = useState(0);
  const request = card.request;
  const offered =
    request !== null &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    Array.isArray(request.allowedModes)
      ? request.allowedModes
      : [];
  const modes = ['auto', 'accept_edits'].filter((mode) => offered.includes(mode));
  const choices = [
    ...modes.map((mode) => ({
      answer: `approve ${mode}`,
      label:
        mode === 'auto'
          ? `${translate('planReview.auto')}${translate('common.recommended')}`
          : translate('planReview.acceptEdits'),
      description: translate(
        mode === 'auto' ? 'planReview.autoDescription' : 'planReview.acceptEditsDescription',
      ),
    })),
    {
      answer: 'revise',
      label: translate('planReview.feedback'),
      description: translate('planReview.feedbackDescription'),
    },
  ];
  const mutable = !busy && card.state === 'pending';
  usePaste((text) => {
    if (editing && mutable) {
      feedback.insert(text, true);
      render((n) => n + 1);
    }
  });
  useInput((input, key) => {
    if (key.ctrl || isCtrlCBatch(input) || (key.tab && key.shift) || !mutable) return;
    if (key.escape) {
      if (editing) setEditing(false);
      else onAnswer('deny');
      return;
    }
    if (!editing) {
      if (key.upArrow || key.downArrow)
        setSelected((value) =>
          value === undefined
            ? key.downArrow
              ? 0
              : choices.length - 1
            : Math.max(0, Math.min(choices.length - 1, value + (key.downArrow ? 1 : -1))),
        );
      else if (key.return && selected !== undefined) {
        const choice = choices[selected]!;
        if (choice.answer === 'revise') setEditing(true);
        else onAnswer(choice.answer);
      }
      return;
    }
    const width = Math.max(24, (stdout.columns ?? 80) - 12),
      display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t);
    if (key.return && !key.shift && !key.meta) {
      if (feedback.text.trim()) onAnswer(`revise ${feedback.text}`);
      else setShowEmptyHint(true);
      return;
    }
    if (key.return) feedback.insert('\n');
    else if (key.leftArrow) feedback.horizontal(-1);
    else if (key.rightArrow) feedback.horizontal(1);
    else if (key.upArrow) feedback.vertical(-1, width, display);
    else if (key.downArrow) feedback.vertical(1, width, display);
    else if (key.home) feedback.boundary(false, width, display);
    else if (key.end) feedback.boundary(true, width, display);
    else if (key.backspace) feedback.remove(true);
    else if (key.delete) feedback.remove(false);
    else if (input) feedback.insert(input);
    render((n) => n + 1);
  });
  return (
    <OverlayFrame
      title={translate('planReview.title')}
      footer={
        <OverlayShortcutBar
          shortcuts={
            editing
              ? [
                  { keys: 'Enter', label: translate('help.submit') },
                  { keys: 'Esc', label: translate('common.back') },
                ]
              : [
                  { keys: '↑↓', label: translate('common.navigate') },
                  { keys: 'Enter', label: translate('common.confirm') },
                  { keys: 'Esc', label: translate('common.cancel') },
                ]
          }
        />
      }
    >
      {editing ? (
        <>
          <Text>{translate('planReview.enterFeedback')}</Text>
          <TuiAnswerInput buffer={feedback} />
          {showEmptyHint && !feedback.text.trim() && (
            <Text color="red">{translate('input.emptyAnswer')}</Text>
          )}
          <Text>{t('Enter submits feedback · Shift+Enter newline · Esc returns to choices')}</Text>
        </>
      ) : (
        <>
          <Text>{translate('planReview.choose')}</Text>
          <Box marginTop={1}>
            <OverlayChoiceList
              options={choices.map((choice) => ({
                id: choice.answer,
                label: choice.label,
                description: choice.description,
              }))}
              selectedId={selected === undefined ? undefined : choices[selected]?.answer}
              numbered
            />
          </Box>
          <Text>{t('Up/Down: choose · Enter: confirm · Esc: deny')}</Text>
          {selected === undefined && <Text>{t('none (Enter has no answer)')}</Text>}
        </>
      )}
      {busy && (
        <Text>
          {t('Original outcome pending or unknown; check original before another answer')}
        </Text>
      )}
      {error && <Text color="red">{terminalText(error)}</Text>}
    </OverlayFrame>
  );
}
