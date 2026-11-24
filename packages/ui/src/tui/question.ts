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
  toggleQuestionChoice,
} from '../question';

export type QuestionDraft = {
  step: number;
  fields: {
    selected?: number;
    cursor?: number;
    editingText?: boolean;
    selectedChoices?: readonly number[];
    buffer: ComposerBuffer;
    skipped?: boolean;
    attempted?: boolean;
  }[];
};

export function questionDraft(form: QuestionForm): QuestionDraft {
  return { step: 0, fields: form.fields.map(() => ({ buffer: new ComposerBuffer() })) };
}
export function questionEditingText(field: QuestionField, draft: QuestionDraft['fields'][number]) {
  return field.textWithChoices
    ? draft.editingText === true
    : field.text && (!field.choices.length || draft.selected === field.choices.length);
}
export function questionValue(
  field: QuestionField,
  draft: QuestionDraft['fields'][number],
): { value: unknown } | undefined {
  return questionFieldValue(field, {
    selected: draft.selected,
    selectedChoices: draft.selectedChoices,
    text: draft.buffer.text,
    skipped: draft.skipped,
  });
}
export function questionAnswer(form: QuestionForm, draft: QuestionDraft): string | undefined {
  const values = questionValues(
    form,
    draft.fields.map((field) => ({
      selected: field.selected,
      selectedChoices: field.selectedChoices,
      text: field.buffer.text,
      skipped: field.skipped,
    })),
  );
  return values ? JSON.stringify(values.value) : undefined;
}
