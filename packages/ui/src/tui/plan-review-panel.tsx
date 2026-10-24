import type { Interaction } from '@kite-ai/client';
import { Box, useInput, usePaste, useStdout } from 'ink';
import { useRef, useState } from 'react';
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
  compact = false,
}: {
  card: Interaction;
  feedback: ComposerBuffer;
  onAnswer(answer: string): void;
  busy?: boolean;
  error?: string;
  compact?: boolean;
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
  // Ink's actual terminal listener may outlive the render that selected a row.
  // Keep the explicit user choice, rather than reading an old callback index.
  const explicitChoice = useRef<string | undefined>(undefined);
  const current = useRef({ mutable, editing, choices, onAnswer });
  current.current = { mutable, editing, choices, onAnswer };
  const shownChoice =
    selected === undefined
      ? undefined
      : choices.find((choice) => choice.answer === explicitChoice.current);
  usePaste((text) => {
    if (current.current.editing && current.current.mutable) {
      feedback.insert(text, true);
      render((n) => n + 1);
    }
  });
  useInput((input, key) => {
    const active = current.current;
    if (key.ctrl || isCtrlCBatch(input) || (key.tab && key.shift) || !active.mutable) return;
    if (key.escape) {
      if (active.editing) {
        current.current.editing = false;
        setEditing(false);
      } else active.onAnswer('deny');
      return;
    }
    if (!active.editing) {
      if (key.upArrow || key.downArrow) {
        const previous = active.choices.findIndex(
          (choice) => choice.answer === explicitChoice.current,
        );
        const next =
          previous < 0
            ? key.downArrow
              ? 0
              : active.choices.length - 1
            : Math.max(0, Math.min(active.choices.length - 1, previous + (key.downArrow ? 1 : -1)));
        explicitChoice.current = active.choices[next]?.answer;
        setSelected(next);
      } else if (key.return && explicitChoice.current !== undefined) {
        const choice = active.choices.find(
          (candidate) => candidate.answer === explicitChoice.current,
        );
        if (!choice) {
          explicitChoice.current = undefined;
          setSelected(undefined);
        } else if (choice.answer === 'revise') {
          current.current.editing = true;
          setEditing(true);
        } else active.onAnswer(choice.answer);
      }
      return;
    }
    const width = Math.max(24, (stdout.columns ?? 80) - 12),
      display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t);
    if (key.return && !key.shift && !key.meta) {
      if (feedback.text.trim()) active.onAnswer(`revise ${feedback.text}`);
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
      compact={compact}
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
          <Box marginTop={compact ? 0 : 1}>
            <OverlayChoiceList
              options={choices.map((choice) => ({
                id: choice.answer,
                label: choice.label,
                description: choice.description,
              }))}
              selectedId={shownChoice?.answer}
              numbered
              compact={compact}
            />
          </Box>
          <Text>{t('Up/Down: choose · Enter: confirm · Esc: deny')}</Text>
          {!shownChoice && <Text>{t('none (Enter has no answer)')}</Text>}
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
