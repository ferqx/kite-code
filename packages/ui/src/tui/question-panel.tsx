import { Box, useStdout } from 'ink';
import stringWidth from 'string-width';
import { type ComposerBuffer, composerDisplay } from './composer';
import { type TuiIntent, terminalText } from './controller';
import OverlayChoiceList from './ink/OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';
import {
  type QuestionDraft,
  type QuestionForm,
  questionLengthError,
  questionValue,
} from './question';

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
export function TuiAnswerInput({
  buffer,
  label = 'Answer',
}: {
  buffer: ComposerBuffer;
  label?: string;
}) {
  const { t } = useTuiPresentation();
  const { stdout } = useStdout();
  const prefix = `${t(label)} > `;
  const width = questionInputWidth(stdout.columns, t(label));
  const display = (part: ComposerBuffer['parts'][number]) => composerDisplay(part, t);
  const { lines, index } = buffer.row(width, display),
    start = Math.max(0, index - 2),
    visible = lines.slice(start, start + 5);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{t('↑ Earlier input')}</Text>}
      {visible.map((line, n) => (
        <Box key={start + n}>
          <Box width={stringWidth(prefix)} flexShrink={0}>
            {n === 0 && <Text>{prefix}</Text>}
          </Box>
          <Text wrap="truncate-end">
            {buffer.parts.slice(line.start, line.end).map((part, i) => (
              <Text
                key={line.start + i}
                inverse={start + n === index && buffer.cursor === line.start + i}
              >
                {display(part)}
              </Text>
            ))}
            {start + n === index && buffer.cursor === line.end && <Text inverse> </Text>}
          </Text>
        </Box>
      ))}
      {start + visible.length < lines.length && <Text dimColor>{t('↓ Later input')}</Text>}
    </Box>
  );
}

/** The Root owns the original interaction draft and a single keyboard listener. */
export function QuestionPanel({
  form,
  draft,
  compactMaterial = false,
  providerAction = false,
  submission,
}: {
  form: QuestionForm;
  draft: QuestionDraft;
  compactMaterial?: boolean;
  /** Root supplies this only for a qualified original MCP provider-action Question. */
  providerAction?: boolean;
  submission?: TuiIntent['phase'];
}) {
  const { t } = useTuiPresentation();
  const { t: translate } = useInkI18n();
  const field = form.fields[draft.step]!,
    current = draft.fields[draft.step]!;
  const editing =
    field.text && (!field.choices.length || current.selected === field.choices.length);
  const lengthError = questionLengthError(field, current.buffer.text);
  const frozen = submission !== undefined && submission !== 'rejected';
  const options = [
    ...field.choices.map((choice, index) => ({
      id: String(index),
      label: providerAction
        ? terminalText(choice.title)
        : `${index + 1}. ${terminalText(choice.title)}`,
      description:
        !compactMaterial && choice.description ? terminalText(choice.description) : undefined,
    })),
    ...(field.text && field.choices.length
      ? [
          {
            id: String(field.choices.length),
            label: translate('input.other'),
            separatorBefore: true,
            selectedContent: <TuiAnswerInput buffer={current.buffer} />,
          },
        ]
      : []),
  ];
  return (
    <OverlayFrame
      contentPaddingX={0}
      title={
        providerAction && form.title
          ? terminalText(form.title)
          : translate('input.answerNeeded', {
              question: field.title === undefined ? t('Answer') : terminalText(field.title),
            })
      }
      meta={form.fields.length > 1 ? `${draft.step + 1} / ${form.fields.length}` : undefined}
      footer={
        frozen ? undefined : (
          <OverlayShortcutBar
            shortcuts={[
              ...(!editing && field.choices.length
                ? [{ keys: '↑↓', label: translate('common.navigate') }]
                : []),
              {
                keys: 'Enter',
                label: translate(
                  draft.step < form.fields.length - 1 ? 'input.next' : 'input.submitAnswer',
                ),
              },
              ...(field.text && field.choices.length
                ? [
                    {
                      keys: 'Tab',
                      label: translate(editing ? 'input.backOptions' : 'input.customInput'),
                    },
                  ]
                : []),
              {
                keys: 'Esc',
                label: translate(draft.step > 0 ? 'input.previous' : 'common.cancel'),
              },
            ]}
          />
        )
      }
    >
      {!compactMaterial && form.description && (
        <Text dimColor>{terminalText(form.description)}</Text>
      )}
      {!compactMaterial && field.description && (
        <Text dimColor>{terminalText(field.description)}</Text>
      )}
      {options.length ? (
        <Box marginTop={1}>
          <OverlayChoiceList
            options={options}
            selectedId={current.selected === undefined ? undefined : String(current.selected)}
          />
        </Box>
      ) : (
        <TuiAnswerInput buffer={current.buffer} />
      )}
      {!frozen && current.selected === undefined && field.choices.length > 0 && (
        <Text dimColor>{t('No selection (Enter has no answer)')}</Text>
      )}
      {!frozen && form.alternative && <Text>Alt+A: {terminalText(form.alternative.title)}</Text>}
      {!frozen && !field.required && (
        <Text dimColor>
          {current.skipped ? '› ' : '  '}
          {t(
            field.text && field.choices.length
              ? 'Alt+S: skip optional answer'
              : 'Tab: skip optional answer',
          )}
        </Text>
      )}
      {!frozen &&
        editing &&
        lengthError &&
        (current.attempted || current.buffer.text.length > 0) && (
          <Text color="yellow">
            {t(lengthError.kind === 'minimum' ? 'Answer needs at least' : 'Answer allows at most')}{' '}
            {lengthError.bound} {t('characters')} ({lengthError.length} {t('entered')}).
          </Text>
        )}
      {submission && (
        <Text color={submission === 'unknown' || submission === 'rejected' ? 'yellow' : undefined}>
          {translate(
            submission === 'unknown'
              ? 'input.answerUnknown'
              : submission === 'rejected'
                ? 'input.answerRejected'
                : submission === 'applied'
                  ? 'input.submitted'
                  : 'input.submitting',
          )}
        </Text>
      )}
    </OverlayFrame>
  );
}

/** Read-only summary of the exact schema-valid drafts; Root owns back/submit. */
export function QuestionReviewPanel({
  form,
  draft,
  submitted = false,
}: {
  form: QuestionForm;
  draft: QuestionDraft;
  submitted?: boolean;
}) {
  const { t: translate } = useInkI18n();
  const { t } = useTuiPresentation();
  return (
    <OverlayFrame
      title={submitted ? translate('input.submitted') : t('Review answers')}
      footer={
        submitted ? undefined : (
          <OverlayShortcutBar
            shortcuts={[
              { keys: 'Enter', label: translate('input.submitAnswer') },
              { keys: 'Esc', label: translate('input.previous') },
            ]}
          />
        )
      }
    >
      {form.fields.map((field, index) => {
        const current = draft.fields[index]!;
        const answer = questionValue(field, current);
        const choice = current.selected === undefined ? undefined : field.choices[current.selected];
        return (
          <Box key={field.key ?? index} flexDirection="column" marginTop={index ? 1 : 0}>
            <Text bold>{field.title === undefined ? t('Answer') : terminalText(field.title)}</Text>
            <Text>
              {answer === undefined
                ? t('Answer unavailable')
                : choice
                  ? terminalText(choice.title)
                  : current.skipped
                    ? t('Skipped')
                    : terminalText(current.buffer.text)}
            </Text>
          </Box>
        );
      })}
    </OverlayFrame>
  );
}
