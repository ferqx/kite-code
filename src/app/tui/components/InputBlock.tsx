import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import React, { type MutableRefObject, useEffect, useState } from 'react';
import stringWidth from 'string-width';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { UserInputPayload } from '@/protocol/events';
import OverlayChoiceList from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';

interface InputBlockProps {
  question: UserInputPayload;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
  /** MultiQuestionWizard 设置此 ref（step>0），Esc 回退上一步而不取消 */
  wizardEscBackRef?: MutableRefObject<boolean>;
}

export default function InputBlock({
  question,
  provider,
  onResolved,
  wizardEscBackRef,
}: InputBlockProps) {
  const t = useTheme();
  const items = question.questions && question.questions.length > 0 ? question.questions : null;

  if (items) {
    return (
      <MultiQuestionWizard
        question={question}
        items={items}
        provider={provider}
        onResolved={onResolved}
        t={t}
        wizardEscBackRef={wizardEscBackRef}
      />
    );
  }

  return <SingleQuestion question={question} provider={provider} onResolved={onResolved} t={t} />;
}

// ── 单问题模式：选项 + ⭐ 推荐 + ✎ 自定义 / Single-question mode ──

function SingleQuestion({
  question,
  provider,
  onResolved,
  t,
}: {
  question: UserInputPayload;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
  t: ReturnType<typeof useTheme>;
}) {
  const options = question.options;
  const hasCustom = question.allow_free_text !== false;
  // 选项总数 = 实际选项 + 自定义入口 / Total = options + custom input slot
  const totalSlots = options.length + (hasCustom ? 1 : 0);
  const [selected, setSelected] = useState(0);
  const [freeText, setFreeText] = useState('');
  const [showEmptyHint, setShowEmptyHint] = useState(false);
  const [mode, setMode] = useState<'select' | 'type'>(options.length > 0 ? 'select' : 'type');
  const choiceOptions = [
    ...options.map((option, index) => ({
      id: String(index),
      label: `${index + 1}. ${option.label}${
        question.recommended != null && option.id === question.recommended ? '（推荐）' : ''
      }`,
      description: option.description,
    })),
    ...(hasCustom
      ? [
          {
            id: String(options.length),
            label: '其他（自定义输入）',
            separatorBefore: options.length > 0,
          },
        ]
      : []),
  ];

  useInput(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        tab?: boolean;
      },
    ) => {
      if ((key.tab || input === '\t') && options.length > 0) {
        setMode((m) => (m === 'select' ? 'type' : 'select'));
        return;
      }
      if (mode === 'select') {
        if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
        if (key.downArrow) setSelected((s) => Math.min(totalSlots - 1, s + 1));
        if (key.return) {
          if (hasCustom && selected === totalSlots - 1) {
            // 选中「✎ 其他」→ 切换到自定义输入 / Selected "✎ Other" → switch to type mode
            setMode('type');
            return;
          }
          if (options.length > 0) {
            const opt = options[selected];
            if (opt) {
              provider.submitAction({ type: 'input', text: opt.label });
              onResolved(opt.label);
            }
          }
        }
      }
    },
  );

  const handleSubmit = (value: string) => {
    if (value.trim()) {
      provider.submitAction({ type: 'input', text: value });
      onResolved(value);
    } else {
      setShowEmptyHint(true);
      setTimeout(() => setShowEmptyHint(false), 2000);
    }
  };

  return (
    <OverlayFrame
      title="需要你的回答"
      footer={
        <OverlayShortcutBar
          shortcuts={
            mode === 'select'
              ? [
                  { keys: '↑↓', label: '选择' },
                  { keys: 'Enter', label: '确认' },
                  ...(hasCustom ? [{ keys: 'Tab', label: '自定义输入' }] : []),
                  { keys: 'Esc', label: '取消' },
                ]
              : [
                  { keys: 'Enter', label: '提交' },
                  ...(options.length > 0 ? [{ keys: 'Tab', label: '返回选项' }] : []),
                  { keys: 'Esc', label: '取消' },
                ]
          }
        />
      }
    >
      <Box marginTop={1} flexDirection="column">
        <Text bold color={t.primary}>
          ? {question.question}
        </Text>
        {question.context && <Text color={t.dim}>{question.context}</Text>}
      </Box>

      {mode === 'select' && options.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <OverlayChoiceList options={choiceOptions} selectedId={String(selected)} />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={t.primary}>{'> '}</Text>
            <TextInput
              value={freeText}
              onChange={setFreeText}
              onSubmit={handleSubmit}
              placeholder="type your answer..."
            />
          </Box>
          {showEmptyHint && <Text color={t.dim}>请输入回答后再提交。</Text>}
        </Box>
      )}
    </OverlayFrame>
  );
}

// ── 多问题 Wizard 模式 / Multi-question wizard mode ──

/** Web-style 水平步骤条：☑ 已完成 ☐ 待处理，超宽自折叠 …，✔ Submit 固尾
 *  Web-style horizontal step bar: ☑ done ☐ pending, auto-collapse …, ✔ Submit pinned right */
function StepBar({
  items,
  current,
  t,
  width,
}: {
  items: Array<{ question: string }>;
  current: number;
  t: ReturnType<typeof useTheme>;
  width: number;
}) {
  const total = items.length;
  if (total === 0) return null;

  const PREFIX = '← ';
  const SUFFIX = ' ✔ Submit →';
  const ELLIPSIS = ' ... ';
  const SPACER = 2; // between steps
  const fixedOverhead = stringWidth(PREFIX) + stringWidth(SUFFIX);

  function truncateStepLabel(label: string, maxWidth: number): string {
    if (stringWidth(label) <= maxWidth) return label;
    const ellipsis = '…';
    const available = Math.max(0, maxWidth - stringWidth(ellipsis));
    let result = '';
    let used = 0;
    for (const char of label) {
      const charWidth = stringWidth(char);
      if (used + charWidth > available) break;
      result += char;
      used += charWidth;
    }
    return `${result}${ellipsis}`;
  }

  // 全量步骤字符串 / Full step strings (unbounded)
  const steps = items.map((item, i) => ({
    text: `${i < current ? '☑' : '☐'} ${truncateStepLabel(item.question, 20)}`,
    done: i < current,
    active: i === current,
  }));

  function stepWidth(s: (typeof steps)[number]) {
    return stringWidth(s.text) + SPACER;
  }

  const allStepsWidth = steps.reduce((sum, s) => sum + stepWidth(s), 0) - SPACER;

  // 放得下 → 全量渲染 / All fit → render everything
  if (allStepsWidth + fixedOverhead <= width) {
    return (
      <Box flexDirection="row">
        <Text>{PREFIX}</Text>
        {steps.map((s, i) => (
          <Text key={i} color={s.done ? t.success : s.active ? t.primary : t.muted}>
            {s.text}
            {i < total - 1 ? '  ' : ''}
          </Text>
        ))}
        <Text color={t.primary}>{SUFFIX}</Text>
      </Box>
    );
  }

  // 放不下 → 以 current 为中心开窗，超出折叠 … / Overflow → sliding window around current
  const windowSteps: typeof steps = [];
  let windowLeft: number | null = null;
  let windowRight: number | null = null;
  let used = 0;

  // 始终包含 current
  windowSteps[current] = steps[current]!;
  used += stepWidth(steps[current]!);

  let lo = current - 1;
  let hi = current + 1;

  // 左右交替扩展，尽量对称 / Expand left-right symmetrically
  const available = width - fixedOverhead - stringWidth(ELLIPSIS) * 2; // reserve for two … slots
  while (lo >= 0 || hi < total) {
    let added = false;
    // 优先向右（靠近 submit） / Prefer right side (closer to submit)
    if (hi < total) {
      const w = stepWidth(steps[hi]!);
      if (used + w <= available) {
        windowSteps[hi] = steps[hi]!;
        used += w;
        windowRight = hi;
        hi++;
        added = true;
      }
    }
    if (lo >= 0) {
      const w = stepWidth(steps[lo]!);
      if (used + w <= available) {
        windowSteps[lo] = steps[lo]!;
        used += w;
        windowLeft = lo;
        lo--;
        added = true;
      }
    }
    if (!added) break;
  }

  const showLeftEllipsis = windowLeft !== null && windowLeft > 0;
  const showRightEllipsis = windowRight !== null && windowRight < total - 1;

  // 组装渲染 / Assemble
  const visible: Array<{ step: (typeof steps)[number]; index: number }> = [];
  for (let i = 0; i < total; i++) {
    if (windowSteps[i]) {
      visible.push({ step: windowSteps[i]!, index: i });
    }
  }

  return (
    <Box flexDirection="row">
      <Text color={t.muted}>{PREFIX}</Text>
      {showLeftEllipsis && <Text color={t.muted}>{ELLIPSIS}</Text>}
      {visible.map(({ step: s, index }) => (
        <React.Fragment key={index}>
          <Text color={s.done ? t.success : s.active ? t.primary : t.muted}>{s.text}</Text>
          {index < (visible[visible.length - 1]?.index ?? 0) ? <Text> </Text> : null}
        </React.Fragment>
      ))}
      {showRightEllipsis && <Text color={t.muted}>{ELLIPSIS}</Text>}
      <Text color={t.primary}>{SUFFIX}</Text>
    </Box>
  );
}

function MultiQuestionWizard({
  question,
  items,
  provider,
  onResolved,
  t,
  wizardEscBackRef,
}: {
  question: UserInputPayload;
  items: NonNullable<UserInputPayload['questions']>;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
  t: ReturnType<typeof useTheme>;
  wizardEscBackRef?: MutableRefObject<boolean>;
}) {
  const total = items.length;
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState('');
  const [mode, setMode] = useState<'select' | 'type'>('select');
  const [done, setDone] = useState(false);

  // 同步 step 到 ref，供全局 ESC handler 判断是否应回退而非取消
  // Sync step to ref so global ESC handler knows to skip (back vs cancel)
  if (wizardEscBackRef) wizardEscBackRef.current = step > 0;
  // 卸载时清理 ref，防止泄漏导致后续 Esc 被全局吞掉
  // Clean ref on unmount to prevent leak that would swallow future global Esc
  useEffect(() => {
    return () => {
      if (wizardEscBackRef) wizardEscBackRef.current = false;
    };
  }, [wizardEscBackRef]);

  const cur = items[step]!;
  const curId = cur.id ?? String(step);
  const options = cur.options ?? [];
  const hasCustom = cur.allow_free_text !== false;
  const totalSlots = options.length + (hasCustom ? 1 : 0);

  useInput(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        tab?: boolean;
      },
    ) => {
      if (done) return;

      // Esc 回退：step>0 → 返回上一步；step===0 → 由全局 handler 取消
      // Esc back: step>0 → go back; step===0 → let global handler cancel
      if (key.escape) {
        if (step > 0) {
          setStep(step - 1);
          setSelected(0);
          setFreeText('');
          setMode('select');
        }
        return;
      }

      if ((key.tab || input === '\t') && options.length > 0) {
        setMode((m) => (m === 'select' ? 'type' : 'select'));
        return;
      }
      if (mode === 'type') return; // TextInput handles remaining input when typing
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(totalSlots - 1, s + 1));
      if (key.return) {
        if (hasCustom && selected === totalSlots - 1) {
          // 选中「✎ 其他」→ 切换到自定义输入 / Selected "✎ Other" → switch to type mode
          setMode('type');
          return;
        }
        if (options.length > 0) {
          const opt = options[selected];
          if (opt) {
            const next = { ...answers, [curId]: opt.label };
            setAnswers(next);
            advanceStep(next);
          }
        }
      }
    },
  );

  function advanceStep(currentAnswers: Record<string, string>) {
    if (step < total - 1) {
      setStep(step + 1);
      setSelected(0);
      setFreeText('');
      setMode('select');
    } else {
      // 最后一步 → 提交 / Final step → submit
      setDone(true);
      const summary = Object.entries(currentAnswers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      provider.submitAction({ type: 'input', text: summary, answers: currentAnswers });
      onResolved(summary, currentAnswers);
    }
  }

  const handleFreeSubmit = (value: string) => {
    if (!value.trim()) return;
    const next = { ...answers, [curId]: value };
    setAnswers(next);
    advanceStep(next);
  };
  const choiceOptions = [
    ...options.map((option, index) => ({
      id: String(index),
      label: `${index + 1}. ${option.label}${
        cur.recommended != null && option.id === cur.recommended ? '（推荐）' : ''
      }`,
      description: option.description,
    })),
    ...(hasCustom
      ? [
          {
            id: String(options.length),
            label: '其他（自定义输入）',
            separatorBefore: options.length > 0,
          },
        ]
      : []),
  ];

  // 汇总页：所有问题已答完 / Review page: all answered
  if (done) {
    return (
      <OverlayFrame title="回答已提交">
        <Box marginTop={1} flexDirection="column">
          <Text bold color={t.success}>
            ✓ 回答已提交
          </Text>
          {Object.entries(answers).map(([id, val], i) => (
            <Text key={`${id}-${i}`} color={t.muted}>
              {id}: {val}
            </Text>
          ))}
        </Box>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      title={`需要你的回答 · ${step + 1}/${total}`}
      footer={
        <OverlayShortcutBar
          shortcuts={
            mode === 'select'
              ? [
                  { keys: '↑↓', label: '选择' },
                  { keys: 'Enter', label: step < total - 1 ? '下一题' : '提交' },
                  ...(hasCustom ? [{ keys: 'Tab', label: '自定义输入' }] : []),
                  { keys: 'Esc', label: step > 0 ? '上一题' : '取消' },
                ]
              : [
                  { keys: 'Enter', label: step < total - 1 ? '下一题' : '提交' },
                  ...(options.length > 0 ? [{ keys: 'Tab', label: '返回选项' }] : []),
                  { keys: 'Esc', label: step > 0 ? '上一题' : '取消' },
                ]
          }
        />
      }
    >
      {/* 主问题 + 上下文 / Main question + context */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={t.primary}>
          ? {question.question}
        </Text>
        {question.context && <Text color={t.dim}>{question.context}</Text>}
      </Box>

      {/* 步骤条 / Step progress bar */}
      <Box marginTop={1}>
        <StepBar items={items} current={step} t={t} width={termWidth} />
      </Box>

      {/* 当前问题 / Current question */}
      <Box marginTop={1} flexDirection="column">
        <Text color={t.primary}>{cur.question}</Text>
        <Text color={t.dim}>{'─'.repeat(40)}</Text>

        {mode === 'select' && options.length > 0 ? (
          <OverlayChoiceList options={choiceOptions} selectedId={String(selected)} />
        ) : (
          <Box flexDirection="column">
            <Box>
              <Text color={t.primary}>{'> '}</Text>
              <TextInput
                value={freeText}
                onChange={setFreeText}
                onSubmit={handleFreeSubmit}
                placeholder="type your answer..."
              />
            </Box>
          </Box>
        )}
      </Box>
    </OverlayFrame>
  );
}
