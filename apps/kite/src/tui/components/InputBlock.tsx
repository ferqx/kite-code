import type { UserInputPayload } from '@kite-ai/runtime-contract';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type MutableRefObject, useEffect, useState } from 'react';
import type { TuiUserInputProvider } from '#app/tui/provider';
import { useTheme } from '#app/tui/theme';
import { useI18n } from '../i18n';
import OverlayChoiceList from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';

interface InputBlockProps {
  interactionId?: string;
  question: UserInputPayload;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
  /** MultiQuestionWizard 设置此 ref（step>0），Esc 回退上一步而不取消 */
  wizardEscBackRef?: MutableRefObject<boolean>;
}

/** Add the display marker once even when a legacy option label already includes it. */
function recommendedOptionLabel(label: string, recommended: boolean, marker: string): string {
  return recommended && !label.endsWith(marker) ? `${label}${marker}` : label;
}

export default function InputBlock({
  interactionId,
  question,
  provider,
  onResolved,
  wizardEscBackRef,
}: InputBlockProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const items = question.questions && question.questions.length > 0 ? question.questions : null;

  if (items) {
    return (
      <MultiQuestionWizard
        question={question}
        items={items}
        interactionId={interactionId}
        provider={provider}
        onResolved={onResolved}
        t={t}
        translate={translate}
        wizardEscBackRef={wizardEscBackRef}
      />
    );
  }

  return (
    <SingleQuestion
      question={question}
      interactionId={interactionId}
      provider={provider}
      onResolved={onResolved}
      t={t}
      translate={translate}
    />
  );
}

// ── 单问题模式：选项 + ⭐ 推荐 + ✎ 自定义 / Single-question mode ──

function SingleQuestion({
  interactionId,
  question,
  provider,
  onResolved,
  t,
  translate,
}: {
  interactionId?: string;
  question: UserInputPayload;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
  t: ReturnType<typeof useTheme>;
  translate: ReturnType<typeof useI18n>['t'];
}) {
  const options = question.options;
  const hasCustom = question.allow_free_text !== false;
  // 选项总数 = 实际选项 + 自定义入口 / Total = options + custom input slot
  const totalSlots = options.length + (hasCustom ? 1 : 0);
  const [selected, setSelected] = useState(0);
  const [freeText, setFreeText] = useState('');
  const [showEmptyHint, setShowEmptyHint] = useState(false);
  const moveSelection = (next: number) => {
    setSelected(next);
    if (hasCustom && next === totalSlots - 1) {
      // 上下键进入「其他」后，输入框直接出现在该选项行内。
      // Moving onto "Other" renders its inline input immediately.
      setFreeText('');
    }
  };

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
        const next = hasCustom && selected !== totalSlots - 1 ? totalSlots - 1 : 0;
        moveSelection(next);
        return;
      }
      if (options.length === 0) return;

      if (key.upArrow) moveSelection(Math.max(0, selected - 1));
      if (key.downArrow) moveSelection(Math.min(totalSlots - 1, selected + 1));
      if (key.return || input === '\r' || input === '\n') {
        if (hasCustom && selected === totalSlots - 1) return;
        const opt = options[selected];
        if (opt) {
          provider.submitAction({ type: 'input', interactionId, text: opt.label });
          onResolved(opt.label);
        }
      }
    },
  );

  const handleSubmit = (value: string) => {
    if (value.trim()) {
      provider.submitAction({ type: 'input', interactionId, text: value });
      onResolved(value);
    } else {
      setShowEmptyHint(true);
      setTimeout(() => setShowEmptyHint(false), 2000);
    }
  };
  const customInput = (
    <TextInput
      value={freeText}
      onChange={setFreeText}
      onSubmit={handleSubmit}
      placeholder={translate('input.other')}
    />
  );
  const choiceOptions = [
    ...options.map((option, index) => ({
      id: String(index),
      label: `${index + 1}. ${recommendedOptionLabel(
        option.label,
        question.recommended != null && option.id === question.recommended,
        translate('common.recommended'),
      )}`,
      description: option.description,
    })),
    ...(hasCustom
      ? [
          {
            id: String(options.length),
            label: translate('input.other'),
            separatorBefore: options.length > 0,
            selectedContent: customInput,
          },
        ]
      : []),
  ];
  const customSelected = hasCustom && selected === totalSlots - 1;

  return (
    <OverlayFrame
      title={translate('input.answerNeeded', { question: question.question })}
      footer={
        <OverlayShortcutBar
          shortcuts={
            options.length > 0
              ? customSelected
                ? [
                    { keys: 'Enter', label: translate('help.submit') },
                    { keys: 'Tab', label: translate('input.backOptions') },
                    { keys: 'Esc', label: translate('common.cancel') },
                  ]
                : [
                    { keys: '↑↓', label: translate('common.navigate') },
                    { keys: 'Enter', label: translate('common.confirm') },
                    ...(hasCustom ? [{ keys: 'Tab', label: translate('input.customInput') }] : []),
                    { keys: 'Esc', label: translate('common.cancel') },
                  ]
              : [
                  { keys: 'Enter', label: translate('help.submit') },
                  { keys: 'Esc', label: translate('common.cancel') },
                ]
          }
        />
      }
    >
      {question.context && <Text color={t.dim}>{question.context}</Text>}

      {options.length > 0 ? (
        <Box flexDirection="column" marginTop={question.context ? 1 : 0}>
          <OverlayChoiceList options={choiceOptions} selectedId={String(selected)} />
          {customSelected && showEmptyHint && (
            <Text color={t.dim}>{translate('input.emptyAnswer')}</Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={question.context ? 1 : 0}>
          <Box>
            <Text color={t.primary}>{'> '}</Text>
            <TextInput
              value={freeText}
              onChange={setFreeText}
              onSubmit={handleSubmit}
              placeholder={translate('input.typeAnswer')}
            />
          </Box>
          {showEmptyHint && <Text color={t.dim}>{translate('input.emptyAnswer')}</Text>}
        </Box>
      )}
    </OverlayFrame>
  );
}

// ── 多问题 Wizard 模式 / Multi-question wizard mode ──

/** 隐藏测试用的步骤前缀，只在标题中展示实际问题正文。 */
function formatMultiQuestionTitle(title: string): string {
  return title.replace(/^多问题测试\s*\d*\s*[：:]\s*/, '');
}

function MultiQuestionWizard({
  interactionId,
  question,
  items,
  provider,
  onResolved,
  t,
  translate,
  wizardEscBackRef,
}: {
  interactionId?: string;
  question: UserInputPayload;
  items: NonNullable<UserInputPayload['questions']>;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
  t: ReturnType<typeof useTheme>;
  translate: ReturnType<typeof useI18n>['t'];
  wizardEscBackRef?: MutableRefObject<boolean>;
}) {
  const total = items.length;
  const isSingle = total === 1;
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState('');
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
  const moveSelection = (next: number) => {
    setSelected(next);
    if (hasCustom && next === totalSlots - 1) {
      // 上下键进入「其他」后，输入框直接出现在该选项行内。
      // Moving onto "Other" renders its inline input immediately.
      setFreeText('');
    }
  };

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
        }
        return;
      }

      if ((key.tab || input === '\t') && options.length > 0) {
        const next = hasCustom && selected !== totalSlots - 1 ? totalSlots - 1 : 0;
        moveSelection(next);
        return;
      }
      if (options.length === 0) return;
      if (key.upArrow) moveSelection(Math.max(0, selected - 1));
      if (key.downArrow) moveSelection(Math.min(totalSlots - 1, selected + 1));
      if (key.return || input === '\r' || input === '\n') {
        if (hasCustom && selected === totalSlots - 1) return;
        const opt = options[selected];
        if (opt) {
          const next = { ...answers, [curId]: opt.label };
          setAnswers(next);
          advanceStep(next);
        }
      }
    },
  );

  function advanceStep(currentAnswers: Record<string, string>) {
    if (step < total - 1) {
      setStep(step + 1);
      setSelected(0);
      setFreeText('');
    } else {
      // 最后一步 → 提交 / Final step → submit
      setDone(true);
      const summary = Object.entries(currentAnswers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      provider.submitAction({
        type: 'input',
        interactionId,
        text: summary,
        answers: currentAnswers,
      });
      onResolved(summary, currentAnswers);
    }
  }

  const handleFreeSubmit = (value: string) => {
    if (!value.trim()) return;
    const next = { ...answers, [curId]: value };
    setAnswers(next);
    advanceStep(next);
  };
  const customInput = (
    <TextInput
      value={freeText}
      onChange={setFreeText}
      onSubmit={handleFreeSubmit}
      placeholder={translate('input.other')}
    />
  );
  const choiceOptions = [
    ...options.map((option, index) => ({
      id: String(index),
      label: `${index + 1}. ${recommendedOptionLabel(
        option.label,
        cur.recommended != null && option.id === cur.recommended,
        translate('common.recommended'),
      )}`,
      description: option.description,
    })),
    ...(hasCustom
      ? [
          {
            id: String(options.length),
            label: translate('input.other'),
            separatorBefore: options.length > 0,
            selectedContent: customInput,
          },
        ]
      : []),
  ];
  const customSelected = hasCustom && selected === totalSlots - 1;

  // 汇总页：所有问题已答完 / Review page: all answered
  if (done) {
    return (
      <OverlayFrame title={translate('input.submitted')}>
        <Box marginTop={1} flexDirection="column">
          <Text bold color={t.success}>
            ✓ {translate('input.submitted')}
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
      title={translate('input.answerNeeded', { question: formatMultiQuestionTitle(cur.question) })}
      meta={
        !isSingle ? (
          <Text color={t.dim}>
            {step + 1} / {total}
          </Text>
        ) : undefined
      }
      footer={
        <OverlayShortcutBar
          shortcuts={
            options.length > 0
              ? customSelected
                ? [
                    {
                      keys: 'Enter',
                      label: step < total - 1 ? translate('input.next') : translate('help.submit'),
                    },
                    { keys: 'Tab', label: translate('input.backOptions') },
                    {
                      keys: 'Esc',
                      label: step > 0 ? translate('input.previous') : translate('common.cancel'),
                    },
                  ]
                : [
                    { keys: '↑↓', label: translate('common.navigate') },
                    {
                      keys: 'Enter',
                      label: step < total - 1 ? translate('input.next') : translate('help.submit'),
                    },
                    ...(hasCustom ? [{ keys: 'Tab', label: translate('input.customInput') }] : []),
                    {
                      keys: 'Esc',
                      label: step > 0 ? translate('input.previous') : translate('common.cancel'),
                    },
                  ]
              : [
                  {
                    keys: 'Enter',
                    label: step < total - 1 ? translate('input.next') : translate('help.submit'),
                  },
                  {
                    keys: 'Esc',
                    label: step > 0 ? translate('input.previous') : translate('common.cancel'),
                  },
                ]
          }
        />
      }
    >
      {/* 上下文 / Context */}
      {isSingle && question.context && <Text color={t.dim}>{question.context}</Text>}

      {/* 当前问题内容 / Current question content */}
      <Box marginTop={isSingle ? 0 : 1} flexDirection="column">
        {!isSingle && question.context && <Text color={t.dim}>{question.context}</Text>}

        <Box marginTop={isSingle ? 0 : question.context ? 1 : 0} flexDirection="column">
          {options.length > 0 ? (
            <OverlayChoiceList options={choiceOptions} selectedId={String(selected)} />
          ) : (
            <Box flexDirection="column">
              <Box>
                <Text color={t.primary}>{'> '}</Text>
                <TextInput
                  value={freeText}
                  onChange={setFreeText}
                  onSubmit={handleFreeSubmit}
                  placeholder={translate('input.typeAnswer')}
                />
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </OverlayFrame>
  );
}
