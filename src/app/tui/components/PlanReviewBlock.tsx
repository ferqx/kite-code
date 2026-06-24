import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type MutableRefObject, useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { AgentPlan } from '@/protocol/events';

interface PlanReviewBlockProps {
  plan: AgentPlan;
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
      key: 'a',
      label: 'Yes, and use auto mode',
      desc: 'Plan executes without further approvals',
      action: 'approved_auto',
    },
    {
      key: 'm',
      label: 'Yes, manually approve edits',
      desc: 'Each file edit requires confirmation',
      action: 'approved_manual',
    },
    {
      key: 't',
      label: 'Tell Agent what to change',
      desc: 'Provide feedback to revise the plan',
      action: 'supplemented',
    },
  ];

  function resolve(action: string, feedback?: string) {
    switch (action) {
      case 'approved_auto':
        provider.submitAction({ type: 'approve_plan_auto' });
        onResolved('approved_auto');
        break;
      case 'approved_manual':
        provider.submitAction({ type: 'approve_plan_manual' });
        onResolved('approved_manual');
        break;
      case 'supplemented':
        provider.submitAction({ type: 'supplement_plan', feedback: feedback ?? '' });
        onResolved('supplemented', feedback);
        break;
      case 'rejected':
        provider.submitAction({ type: 'reject_plan' });
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
      input: string,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
    ) => {
      // Esc is handled by global handler

      if (mode === 'supplement') {
        if (key.escape) {
          if (supplementEscRef) supplementEscRef.current = false;
          setMode('options');
          return;
        }
        if (key.return) {
          handleSupplementSubmit(supplementText);
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
      // Letter shortcuts: a → auto, m → manual, t → tell
      const lower = input.toLowerCase();
      const match = options.find((o) => o.key === lower);
      if (match) {
        if (match.action === 'supplemented') {
          if (supplementEscRef) supplementEscRef.current = true;
          setMode('supplement');
        } else {
          resolve(match.action);
        }
      }
    },
  );

  // 方案内容已在 OutputArea 以 Markdown tool_card 渲染，Footer 只显示确认操作条
  // Plan content is rendered in OutputArea as Markdown tool_card; Footer only shows the confirmation bar
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      {mode === 'options' ? (
        <>
          <Text color={t.primary}>Review the plan above and choose:</Text>
          {options.map((o, i) => {
            const isSelected = i === selectedIndex;
            const isRec = i === 0;
            return (
              <Box key={o.key} flexDirection="column">
                <Text color={isSelected ? t.primary : t.muted}>
                  {isSelected ? '▶' : ' '} {i + 1}. {o.label}
                  {isRec ? <Text color={t.dim}> (Recommended)</Text> : null}
                </Text>
                {o.desc && <Text color={t.dim}> {o.desc}</Text>}
              </Box>
            );
          })}
          <Text color={t.dim}>↑↓ select Enter confirm a/m/t quick key Esc cancel</Text>
        </>
      ) : (
        <>
          <Text color={t.primary}>Enter your feedback for the plan:</Text>
          <Box marginY={1}>
            <Text color={t.primary}>{'> '}</Text>
            <TextInput
              value={supplementText}
              onChange={setSupplementText}
              onSubmit={handleSupplementSubmit}
            />
          </Box>
          {showEmptyHint && <Text color={t.error}>Feedback cannot be empty.</Text>}
          <Text color={t.dim}>Enter submit Esc back</Text>
        </>
      )}
    </Box>
  );
}
