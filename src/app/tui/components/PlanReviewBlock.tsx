import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type MutableRefObject, useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { AgentPlan, PlanArtifactRef } from '@/protocol/events';
import { useI18n } from '../i18n';
import OverlayChoiceList from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';

interface PlanReviewBlockProps {
  plan: AgentPlan;
  artifact?: PlanArtifactRef;
  provider: TuiUserInputProvider;
  onResolved: (action: string, feedback?: string) => void;
  /** Ref set to true during supplement mode — global Esc handler checks this to avoid cancelling the interrupt */
  supplementEscRef?: MutableRefObject<boolean>;
}

export default function PlanReviewBlock({
  plan: _plan,
  provider,
  onResolved,
  supplementEscRef,
}: PlanReviewBlockProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [supplementText, setSupplementText] = useState('');
  const [showEmptyHint, setShowEmptyHint] = useState(false);

  // Mode: 'options' = choose approve/supplement/reject; 'supplement' = type feedback
  const [mode, setMode] = useState<'options' | 'supplement'>('options');

  const options = [
    {
      label: translate('planReview.auto'),
      desc: translate('planReview.autoDescription'),
      action: 'approved_auto',
    },
    {
      label: translate('planReview.acceptEdits'),
      desc: translate('planReview.acceptEditsDescription'),
      action: 'approved_accept_edits',
    },
    {
      label: translate('planReview.feedback'),
      desc: translate('planReview.feedbackDescription'),
      action: 'supplemented',
    },
  ];
  const choiceOptions = options.map((option, index) => ({
    id: option.action,
    label: `${option.label}${index === 0 ? translate('common.recommended') : ''}`,
    description: option.desc,
  }));

  function resolve(action: string, feedback?: string) {
    switch (action) {
      case 'approved_auto':
        provider.submitAction({
          type: 'plan_review_decision',
          decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
        });
        onResolved('approved_auto');
        break;
      case 'approved_accept_edits':
        provider.submitAction({
          type: 'plan_review_decision',
          decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
        });
        onResolved('approved_accept_edits');
        break;
      case 'supplemented':
        provider.submitAction({
          type: 'plan_review_decision',
          decision: { kind: 'revise', feedback: feedback ?? '' },
        });
        onResolved('supplemented', feedback);
        break;
      case 'rejected':
        provider.submitAction({ type: 'plan_review_decision', decision: { kind: 'cancel' } });
        onResolved('rejected');
        break;
    }
  }

  function handleSupplementSubmit(value: string) {
    if (value.trim()) {
      if (supplementEscRef) supplementEscRef.current = false;
      resolve('supplemented', value.trim());
    } else {
      setShowEmptyHint(true);
      setTimeout(() => setShowEmptyHint(false), 2000);
    }
  }

  useInput(
    (
      _input: string,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
    ) => {
      // Esc is handled by global handler

      if (mode === 'supplement') {
        if (key.escape) {
          if (supplementEscRef) supplementEscRef.current = false;
          setMode('options');
          return;
        }
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(options.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const opt = options[selectedIndex];
        if (!opt) return;
        if (opt.action === 'supplemented') {
          if (supplementEscRef) supplementEscRef.current = true;
          setMode('supplement');
        } else {
          resolve(opt.action);
        }
        return;
      }
    },
  );

  // 方案内容已在 OutputArea 以 Markdown tool_card 渲染，Footer 只显示确认操作条
  // Plan content is rendered in OutputArea as Markdown tool_card; Footer only shows the confirmation bar
  return (
    <OverlayFrame
      title={translate('planReview.title')}
      footer={
        <OverlayShortcutBar
          shortcuts={
            mode === 'options'
              ? [
                  { keys: '↑↓', label: translate('common.navigate') },
                  { keys: 'Enter', label: translate('common.confirm') },
                  { keys: 'Esc', label: translate('common.cancel') },
                ]
              : [
                  { keys: 'Enter', label: translate('help.submit') },
                  { keys: 'Esc', label: translate('common.back') },
                ]
          }
        />
      }
    >
      {mode === 'options' ? (
        <>
          <Box>
            <Text color={t.primary}>{translate('planReview.choose')}</Text>
          </Box>
          <Box marginTop={1}>
            <OverlayChoiceList
              options={choiceOptions}
              selectedId={choiceOptions[selectedIndex]?.id}
              numbered
            />
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1}>
            <Text color={t.primary}>{translate('planReview.enterFeedback')}</Text>
          </Box>
          <Box marginY={1}>
            <Text color={t.primary}>{'> '}</Text>
            <TextInput
              value={supplementText}
              onChange={setSupplementText}
              onSubmit={handleSupplementSubmit}
            />
          </Box>
          {showEmptyHint && <Text color={t.error}>反馈不能为空。</Text>}
        </>
      )}
    </OverlayFrame>
  );
}
