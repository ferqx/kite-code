import {
  type QuestionField,
  type QuestionForm,
  questionFieldValue,
  questionValues,
} from '../question';
import { ComposerBuffer } from './composer';

export {
  type QuestionField,
  type QuestionForm,
  questionForm,
  questionLengthError,
} from '../question';

export type QuestionDraft = {
  step: number;
  fields: { selected?: number; buffer: ComposerBuffer; skipped?: boolean }[];
};

export function questionDraft(form: QuestionForm): QuestionDraft {
  return { step: 0, fields: form.fields.map(() => ({ buffer: new ComposerBuffer() })) };
}
export function questionValue(
  field: QuestionField,
  draft: QuestionDraft['fields'][number],
): { value: unknown } | undefined {
  return questionFieldValue(field, {
    selected: draft.selected,
    text: draft.buffer.text,
    skipped: draft.skipped,
  });
}
export function questionAnswer(form: QuestionForm, draft: QuestionDraft): string | undefined {
  const values = questionValues(
    form,
    draft.fields.map((field) => ({
      selected: field.selected,
      text: field.buffer.text,
      skipped: field.skipped,
    })),
  );
  return values ? JSON.stringify(values.value) : undefined;
}
