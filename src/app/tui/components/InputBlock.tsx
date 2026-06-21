import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { UserInputPayload } from '@/protocol/events';

interface InputBlockProps {
  question: UserInputPayload;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
}

export default function InputBlock({ question, provider, onResolved }: InputBlockProps) {
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
      />
    );
  }

  return <SingleQuestion question={question} provider={provider} onResolved={onResolved} t={t} />;
}

// ── 单问题模式：保持现有行为 / Single-question mode: existing behavior ──

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
  const [selected, setSelected] = useState(0);
  const [freeText, setFreeText] = useState('');
  const [showEmptyHint, setShowEmptyHint] = useState(false);
  const [mode, setMode] = useState<'select' | 'type'>(
    question.options.length > 0 ? 'select' : 'type',
  );
  const options = question.options;

  useInput(
    (
      input: string,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
    ) => {
      if (input === '\t') {
        setMode((m) => (m === 'select' ? 'type' : 'select'));
        return;
      }
      if (mode === 'select') {
        if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
        if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
        if (key.return && options.length > 0) {
          const opt = options[selected];
          if (opt) {
            provider.submitAction({ type: 'input', text: opt.label });
            onResolved(opt.label);
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        ? {question.question}
      </Text>
      {question.context && <Text color={t.dim}>{question.context}</Text>}

      {mode === 'select' && options.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={t.dim}>{'─'.repeat(40)}</Text>
          {options.map((opt, i) => {
            const isSelected = i === selected;
            return (
              <Text key={opt.id ?? i} color={isSelected ? t.primary : t.muted}>
                {isSelected ? '▶' : ' '} {i + 1}. {opt.label}
                {opt.description ? ` — ${opt.description}` : ''}
              </Text>
            );
          })}
          <Text color={t.dim}>{'─'.repeat(40)}</Text>
          <Text color={t.dim}>↑↓ select Enter confirm Tab type freely Esc cancel</Text>
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
          {showEmptyHint && <Text color={t.dim}> Please type an answer before submitting</Text>}
          {question.options.length > 0 && <Text color={t.dim}>Tab back to select Esc cancel</Text>}
        </Box>
      )}
    </Box>
  );
}

// ── 多问题 Wizard 模式 / Multi-question wizard mode ──

function MultiQuestionWizard({
  question,
  items,
  provider,
  onResolved,
  t,
}: {
  question: UserInputPayload;
  items: NonNullable<UserInputPayload['questions']>;
  provider: TuiUserInputProvider;
  onResolved: (answer: string, answers?: Record<string, string>) => void;
  t: ReturnType<typeof useTheme>;
}) {
  const total = items.length;
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState('');
  const [mode, setMode] = useState<'select' | 'type'>('select');
  const [done, setDone] = useState(false);

  const cur = items[step]!;
  const curId = cur.id ?? String(step);
  const options = cur.options ?? [];

  useInput(
    (
      input: string,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
    ) => {
      if (done) return;
      if (mode === 'type') return; // TextInput handles input when typing

      if (input === '\t') {
        setMode((m) => (m === 'select' ? 'type' : 'select'));
        return;
      }
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
      if (key.return) {
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

  // 汇总页：所有问题已答完 / Review page: all answered
  if (done) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={t.success}
        paddingX={1}
        marginY={1}
      >
        <Text bold color={t.success}>
          ✓ Answers submitted
        </Text>
        {Object.entries(answers).map(([id, val]) => (
          <Text key={id} color={t.muted}>
            {id}: {val}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      {/* 上下文 + 进度 / Context + progress */}
      <Text bold color={t.primary}>
        ? {question.question}
      </Text>
      {question.context && <Text color={t.dim}>{question.context}</Text>}
      <Box marginTop={1}>
        <Text color={t.muted}>
          Question {step + 1}/{total}
        </Text>
      </Box>

      {/* 当前问题 / Current question */}
      <Box marginTop={1} flexDirection="column">
        <Text color={t.primary}>{cur.question}</Text>
        <Text color={t.dim}>{'─'.repeat(40)}</Text>

        {mode === 'select' && options.length > 0 ? (
          <>
            {options.map((opt, i) => {
              const isSelected = i === selected;
              return (
                <Text key={opt.id ?? i} color={isSelected ? t.primary : t.muted}>
                  {isSelected ? '▶' : ' '} {i + 1}. {opt.label}
                  {opt.description ? ` — ${opt.description}` : ''}
                </Text>
              );
            })}
            <Text color={t.dim}>{'─'.repeat(40)}</Text>
            <Text color={t.dim}>
              ↑↓ select Enter {step < total - 1 ? 'next' : 'submit'} Tab type freely Esc cancel
            </Text>
          </>
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
            {options.length > 0 && (
              <Text color={t.dim}>
                Tab back to select Enter {step < total - 1 ? 'next' : 'submit'} Esc cancel
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* 已回答摘要 / Answered summary */}
      {Object.keys(answers).length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={t.dim}>Answered:</Text>
          {Object.entries(answers).map(([id, val]) => (
            <Text key={id} color={t.muted}>
              ✓ {id}: {val}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
