import { QuestionCancelledError } from '../../execution/interactions';
import { defineExtension, type Extension, type Json, type ToolDefinition } from '../../extensions';
import { canonicalJson } from '../../json';
import { AgentError } from '../../storage/types';

const nonempty = { type: 'string', minLength: 1, pattern: '\\S' };
const minOptions = 3;
const maxOptions = 4;
const inputSchema: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          question: nonempty,
          multiple: { type: 'boolean' },
          options: {
            type: 'array',
            maxItems: maxOptions,
            anyOf: [{ maxItems: 0 }, { minItems: minOptions }],
            items: {
              type: 'object',
              properties: {
                label: nonempty,
                description: nonempty,
                recommended: { type: 'boolean' },
              },
              required: ['label', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

function object(value: Json, required: string[], optional: string[] = []): Record<string, Json> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || ![...required, ...optional].includes(key),
    )
  )
    throw new AgentError('invalid_ask_user_arguments');
  return value;
}
function text(value: Json): string {
  if (typeof value !== 'string' || !value.trim())
    throw new AgentError('invalid_ask_user_arguments');
  return value;
}
function questions(input: Json) {
  const values = object(input, ['questions']).questions;
  if (!Array.isArray(values) || values.length < 1 || values.length > 3)
    throw new AgentError('invalid_ask_user_arguments');
  return values.map((value, index) => {
    const question = object(value, ['question'], ['options', 'multiple']);
    const multiple = Object.hasOwn(question, 'multiple') ? question.multiple : false;
    if (typeof multiple !== 'boolean') throw new AgentError('invalid_ask_user_arguments');
    const options = Object.hasOwn(question, 'options') ? question.options : [];
    if (
      !Array.isArray(options) ||
      (options.length > 0 && options.length < minOptions) ||
      options.length > maxOptions
    )
      throw new AgentError('invalid_ask_user_arguments');
    const choices = options.map((value, choiceIndex) => {
      const option = object(value, ['label', 'description'], ['recommended']);
      const recommended = Object.hasOwn(option, 'recommended') ? option.recommended : undefined;
      if (recommended !== undefined && typeof recommended !== 'boolean')
        throw new AgentError('invalid_ask_user_arguments');
      return {
        id: `q${index + 1}-o${choiceIndex + 1}`,
        label: text(option.label!).trim(),
        description: text(option.description!).trim(),
        recommended: recommended === true,
      };
    });
    if (choices.filter((choice) => choice.recommended).length > 1)
      throw new AgentError('invalid_ask_user_arguments');
    return {
      id: `q${index + 1}`,
      question: text(question.question!).trim(),
      choices,
      multiple: choices.length > 0 && multiple,
    };
  });
}

/** Pure registration; the ordinary Tool context owns the original interaction and cancellation. */
export function createAskUserExtension(): Extension {
  const tool: ToolDefinition = {
    id: 'ask_user',
    model: { name: 'ask_user', snakeCase: true },
    version: '1',
    description:
      'Ask only when a material answer blocks progress. Submit all one to three focused questions in one call. Omit options or pass an empty array for a free-text question. For a choice question, provide three to four label/description options. Choice questions are single-choice by default; set multiple: true to let users combine selected options with each other and with free text. Set recommended: true on at most one option per question. Every question permits a free-text answer. Cancelling the answers returns cancelled information and leaves the task running; do not automatically repeat these questions.',
    inputSchema,
    async execute(input, context) {
      let parsed: ReturnType<typeof questions>;
      try {
        parsed = questions(input);
      } catch (error) {
        if (error instanceof AgentError && error.code === 'invalid_ask_user_arguments')
          return { outcome: 'failed', content: 'invalid_ask_user_arguments' };
        throw error;
      }
      const properties: Record<string, Json> = {};
      const recommendedOptions: Record<string, string> = {};
      for (const question of parsed) {
        const recommended = question.choices.find((choice) => choice.recommended);
        if (recommended) recommendedOptions[question.id] = recommended.id;
        const choices = question.choices.map((choice) => ({
          const: choice.id,
          title: choice.label,
          description: choice.description,
        }));
        const multiple = question.multiple
          ? {
              type: 'array',
              items: { type: 'string', oneOf: choices },
              minItems: 1,
              maxItems: choices.length,
              uniqueItems: true,
            }
          : undefined;
        const freeText = {
          type: 'object',
          properties: { text: nonempty, ...(multiple ? { choices: multiple } : {}) },
          required: ['text'],
          additionalProperties: false,
        };
        properties[question.id] = choices.length
          ? { title: question.question, anyOf: [...(multiple ? [multiple] : choices), freeText] }
          : { title: question.question, ...freeText };
      }
      let accepted: Json;
      try {
        accepted = await context.requestInput({
          recommendedOptions,
          schema: {
            oneOf: [
              {
                type: 'object',
                properties,
                required: parsed.map((question) => question.id),
                additionalProperties: false,
              },
              {
                const: null,
                title: 'Cancel answering',
                description: 'Leave these questions unanswered and continue the current task.',
              },
            ],
          },
        });
      } catch (error) {
        // This leaf only requests information. Preserve the exact original cancellation,
        // while leaving unrelated errors to Core's ordinary attempted-Tool classification.
        if (
          error instanceof QuestionCancelledError &&
          error.interaction.kind === 'question' &&
          error.interaction.state === 'cancelled' &&
          error.interaction.sessionId === context.sessionId &&
          error.interaction.executionId === context.executionId &&
          error.interaction.runId === context.runId
        )
          return { outcome: 'cancelled', content: 'execution_cancel_requested' };
        if (
          error instanceof AgentError &&
          ['cancel_requested', 'execution_cancel_requested'].includes(error.code) &&
          context.signal.aborted &&
          error === context.signal.reason
        )
          return { outcome: 'cancelled', content: error.code };
        if (
          error instanceof AgentError &&
          !context.signal.aborted &&
          [
            'question_schema_invalid',
            'interaction_answer_invalid',
            'interaction_not_found',
          ].includes(error.code)
        )
          return { outcome: 'failed', content: error.code };
        throw error;
      }
      if (accepted === null) {
        const details = { cancelled: true };
        return { outcome: 'succeeded', content: canonicalJson(details), details };
      }
      const raw = object(
        accepted,
        parsed.map((question) => question.id),
      );
      const answers: Record<string, string | string[]> = {};
      const lines: string[] = [];
      for (const question of parsed) {
        const value = raw[question.id]!;
        const label = (id: Json) => {
          const choice = question.choices.find((choice) => choice.id === id);
          if (!choice) throw new AgentError('invalid_ask_user_answer');
          return choice.label;
        };
        const selectedLabels = (ids: Json) => {
          if (
            !question.multiple ||
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > question.choices.length ||
            new Set(ids).size !== ids.length
          )
            throw new AgentError('invalid_ask_user_answer');
          return ids.map(label);
        };
        let answer: string | string[];
        if (Array.isArray(value)) {
          answer = selectedLabels(value);
        } else if (typeof value === 'string') {
          if (question.multiple) throw new AgentError('invalid_ask_user_answer');
          answer = label(value);
        } else {
          const custom = object(value, ['text'], question.multiple ? ['choices'] : []);
          const content = text(custom.text!);
          answer = Object.hasOwn(custom, 'choices')
            ? [...selectedLabels(custom.choices!), content]
            : content;
        }
        answers[question.id] = answer;
        const summary = Array.isArray(answer) ? answer.join(', ') : answer;
        const title = question.question.replace(/(?:[：:]\s*)+$/u, '');
        lines.push(parsed.length === 1 ? summary : `${title}: ${summary}`);
      }
      const details = { answer: lines.join('\n'), answers };
      return { outcome: 'succeeded', content: canonicalJson(details), details };
    },
  };
  return defineExtension({ id: 'builtin.ask-user', version: '1', apiMajor: 1, tools: [tool] });
}
