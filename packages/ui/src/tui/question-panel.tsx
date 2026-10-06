import { Box, useStdout } from 'ink';
import stringWidth from 'string-width';
import { type ComposerBuffer, composerDisplay } from './composer';
import { terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';
import { type QuestionDraft, type QuestionForm, questionLengthError } from './question';

export const questionInputWidth = (columns: number | undefined, answerLabel: string) =>
  Math.max(24, (columns ?? 80) - stringWidth(`${answerLabel} > `) - 1);

/** Original question material is fixed for one displayed step. */
export function QuestionMaterial({ form, step }: { form: QuestionForm; step: number }) {
  const { t } = useTuiPresentation();
  const field = form.fields[step]!;
  return (
    <Box flexDirection="column">
      {form.title && <Text bold>{terminalText(form.title)}</Text>}
      {form.description && <Text>{terminalText(form.description)}</Text>}
      <Text bold>
        {t('Question')} {step + 1}/{form.fields.length}:{' '}
        {field.title === undefined ? t('Answer') : terminalText(field.title)}
      </Text>
      {field.description && <Text>{terminalText(field.description)}</Text>}
      {field.choices.map((choice, i) => (
        <Box key={i} flexDirection="column">
          <Text>
            {i + 1}. {terminalText(choice.title)}
          </Text>
          {choice.description && <Text>{terminalText(choice.description)}</Text>}
        </Box>
      ))}
      {field.text && field.choices.length > 0 && (
        <Text>
          {field.choices.length + 1}. {t('Custom answer')}
        </Text>
      )}
      {form.alternative && (
        <Box flexDirection="column">
          <Text>Alt+A: {terminalText(form.alternative.title)}</Text>
          {form.alternative.description && (
            <Text>{terminalText(form.alternative.description)}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

/** The session owns input and the original draft; this renders its finite window. */
export function TuiAnswerInput({ buffer }: { buffer: ComposerBuffer }) {
  const { t } = useTuiPresentation();
  const { stdout } = useStdout();
  const prefix = `${t('Answer')} > `;
  const width = questionInputWidth(stdout.columns, t('Answer'));
  const { lines, index } = buffer.row(width),
    start = Math.max(0, index - 2),
    visible = lines.slice(start, start + 5);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{t('↑ Earlier input')}</Text>}
      {visible.map((line, n) => (
        <Text key={start + n}>
          {n === 0 ? prefix : ' '.repeat(stringWidth(prefix))}
          {buffer.parts.slice(line.start, line.end).map((part, i) => (
            <Text
              key={line.start + i}
              inverse={start + n === index && buffer.cursor === line.start + i}
            >
              {composerDisplay(part)}
            </Text>
          ))}
          {start + n === index && buffer.cursor === line.end && <Text inverse> </Text>}
        </Text>
      ))}
      {start + visible.length < lines.length && <Text dimColor>{t('↓ Later input')}</Text>}
    </Box>
  );
}

/** Input is handled by the session's single card listener. */
export function QuestionPanel({ form, draft }: { form: QuestionForm; draft: QuestionDraft }) {
  const { t } = useTuiPresentation();
  const field = form.fields[draft.step]!,
    current = draft.fields[draft.step]!;
  const editing =
    field.text && (!field.choices.length || current.selected === field.choices.length);
  const lengthError = questionLengthError(field, current.buffer.text);
  return (
    <Box flexDirection="column">
      <Text>
        {t('Question')} {draft.step + 1}/{form.fields.length}
        {field.choices.length > 0 &&
          ` · ${t('Selection')}: ${current.selected === undefined ? t('No selection (Enter has no answer)') : `${current.selected + 1}${current.selected === field.choices.length ? ` · ${t('Custom answer')}` : ''}`}`}
      </Text>
      {form.alternative && <Text>Alt+A: {terminalText(form.alternative.title)}</Text>}
      {!field.required && (
        <Text>
          {current.skipped ? '› ' : '  '}
          {t('Tab: skip optional answer')}
        </Text>
      )}
      {editing && <TuiAnswerInput buffer={current.buffer} />}
      {editing && lengthError && (
        <Text color="yellow">
          {t(lengthError.kind === 'minimum' ? 'Answer needs at least' : 'Answer allows at most')}{' '}
          {lengthError.bound} {t('characters')} ({lengthError.length} {t('entered')}).
        </Text>
      )}
      <Text>
        {t('Up/Down: choose · Enter: next/submit · Shift+Enter: newline · Esc: previous question')}
      </Text>
    </Box>
  );
}
