import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type MutableRefObject, useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { AgentPlan, PlanArtifactRef } from '@/protocol/events';
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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [supplementText, setSupplementText] = useState('');
  const [showEmptyHint, setShowEmptyHint] = useState(false);

  // Mode: 'options' = choose approve/supplement/reject; 'supplement' = type feedback
  const [mode, setMode] = useState<'options' | 'supplement'>('options');

  const options = [
    {
      label: '在 Auto 模式下开始执行',
      desc: '自动审核非破坏性操作',
      action: 'approved_auto',
    },
    {
      label: '在接受编辑模式下开始执行',
      desc: '工作区文件编辑无需逐次确认',
      action: 'approved_accept_edits',
    },
    {
      label: '携带反馈继续规划',
      desc: '输入反馈，让方案继续调整',
      action: 'supplemented',
    },
  ];
  const choiceOptions = options.map((option, index) => ({
    id: option.action,
    label: `${option.label}${index === 0 ? '（推荐）' : ''}`,
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
      title="方案审核"
      footer={
        <OverlayShortcutBar
          shortcuts={
            mode === 'options'
              ? [
                  { keys: '↑↓', label: '选择' },
                  { keys: 'Enter', label: '确认' },
                  { keys: 'Esc', label: '取消' },
                ]
              : [
                  { keys: 'Enter', label: '提交' },
                  { keys: 'Esc', label: '返回' },
                ]
          }
        />
      }
    >
      {mode === 'options' ? (
        <>
          <Box marginTop={1}>
            <Text color={t.primary}>请审核上方方案并选择后续操作：</Text>
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
            <Text color={t.primary}>请输入对方案的反馈：</Text>
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
