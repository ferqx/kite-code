import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useRef, useState } from 'react';
import type { TuiUserInputProvider } from '@/app/tui/provider';
import { useTheme } from '@/app/tui/theme';
import type { UserInputPayload } from '@/protocol/events';

interface InputBlockProps {
  question: UserInputPayload;
  provider: TuiUserInputProvider;
  onResolved: (answer: string) => void;
}

export default function InputBlock({ question, provider, onResolved }: InputBlockProps) {
  const t = useTheme();
  const [selected, setSelected] = useState(0);
  const [freeText, setFreeText] = useState('');
  const [showEmptyHint, setShowEmptyHint] = useState(false);
  const [mode, setMode] = useState<'select' | 'type'>(
    question.options.length > 0 ? 'select' : 'type',
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const options = question.options;

  useInput(
    (
      input: string,
      key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
    ) => {
      if (key.escape) {
        provider.submitAction({ type: 'cancel' });
        onResolved('cancelled');
        return;
      }

      if (input === '\t' && question.allow_free_text) {
        setMode((m) => (m === 'select' ? 'type' : 'select'));
        return;
      }
      if (mode === 'select') {
        if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
        if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
        if (key.return && options.length > 0) {
          const opt = options[selectedRef.current];
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
        <Box flexDirection="column" marginY={1}>
          {options.map((opt, i) => (
            <Text key={opt.id} color={i === selected ? t.primary : t.muted}>
              {i === selected ? '>' : ' '} {opt.label}
              {opt.description ? ` — ${opt.description}` : ''}
            </Text>
          ))}
          {question.allow_free_text && <Box height={1} />}
          {question.allow_free_text && <Text color={t.dim}>[Tab] type freely [Enter] confirm</Text>}
        </Box>
      ) : (
        <Box flexDirection="column">
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
        </Box>
      )}
    </Box>
  );
}
