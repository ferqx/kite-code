import { Box } from 'ink';
import { composerDisplay } from './composer';
import { terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';
import { type QuestionDraft, type QuestionForm, questionLengthError } from './question';

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
      {form.title && <Text bold>{terminalText(form.title)}</Text>}
      {form.description && <Text>{terminalText(form.description)}</Text>}
      <Text bold>
        {t('Question')} {draft.step + 1}/{form.fields.length}:{' '}
        {field.title === undefined ? t('Answer') : terminalText(field.title)}
      </Text>
      {field.description && <Text>{terminalText(field.description)}</Text>}
      {field.choices.map((choice, i) => (
        <Box key={i} flexDirection="column">
          <Text>
            {current.selected === i ? '› ' : '  '}
            {terminalText(choice.title)}
          </Text>
          {choice.description && <Text>{terminalText(choice.description)}</Text>}
        </Box>
      ))}
      {field.text && field.choices.length > 0 && (
        <Text>
          {current.selected === field.choices.length ? '› ' : '  '}
          {t('Custom answer')}
        </Text>
      )}
      {!field.required && (
        <Text>
          {current.skipped ? '› ' : '  '}
          {t('Tab: skip optional answer')}
        </Text>
      )}
      {editing && (
        <Text>
          {t('Answer')} &gt;{' '}
          {current.buffer.parts.map((part, i) => (
            <Text key={i} inverse={current.buffer.cursor === i}>
              {composerDisplay(part)}
            </Text>
          ))}
          {current.buffer.cursor === current.buffer.parts.length && <Text inverse> </Text>}
        </Text>
      )}
      {editing && lengthError && (
        <Text color="yellow">
          {t(lengthError.kind === 'minimum' ? 'Answer needs at least' : 'Answer allows at most')}{' '}
          {lengthError.bound} {t('characters')} ({lengthError.length} {t('entered')}).
        </Text>
      )}
      <Text>
        {t('Up/Down: choose · Enter: next/submit · Shift+Enter: newline · Esc: previous question')}
      </Text>
      {field.choices.length > 0 && current.selected === undefined && !current.skipped && (
        <Text>{t('No selection (Enter has no answer)')}</Text>
      )}
    </Box>
  );
}
