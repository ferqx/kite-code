import { defineExtension, type Extension, type Json, type ToolDefinition } from '../../extensions';
import { canonicalJson } from '../../json';
import { AgentError } from '../../storage/types';

const nonempty = { type: 'string', minLength: 1, pattern: '\\S' };
const inputSchema = {
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
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
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
        required: ['question', 'options'],
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
    const question = object(value, ['question', 'options']);
    const options = question.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 3)
      throw new AgentError('invalid_ask_user_arguments');
    const choices = options.map((value, choiceIndex) => {
      const option = object(value, ['label', 'description'], ['recommended']);
      if (Object.hasOwn(option, 'recommended') && typeof option.recommended !== 'boolean')
        throw new AgentError('invalid_ask_user_arguments');
      return {
        id: `q${index + 1}-o${choiceIndex + 1}`,
        label: text(option.label!).trim(),
        description: text(option.description!).trim(),
        recommended: option.recommended === true,
      };
    });
    if (choices.filter((choice) => choice.recommended).length > 1)
      throw new AgentError('invalid_ask_user_arguments');
    return { id: `q${index + 1}`, question: text(question.question!).trim(), choices };
  });
}

/** Pure registration; the ordinary Tool context owns the original interaction and cancellation. */
export function createAskUserExtension(): Extension {
  const tool: ToolDefinition = {
    id: 'ask_user',
    version: '1',
    description:
      'Ask only when a material choice blocks progress. Submit all one to three focused questions in one call using the canonical questions array, each with two to three label/description options. Put the preferred option first; at most one option per question may be recommended=true. Every question also permits free input. User cancellation is terminal for this interaction; do not automatically retry.',
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
      for (const question of parsed) {
        const recommended =
          question.choices.find((choice) => choice.recommended) ?? question.choices[0]!;
        properties[question.id] = {
          title: question.question,
          anyOf: [
            ...question.choices.map((choice) => ({
              const: choice.id,
              title: choice.label + (choice === recommended ? ' (Recommended)' : ''),
              description: choice.description,
            })),
            {
              type: 'object',
              properties: { text: { type: 'string', minLength: 1, pattern: '\\S' } },
              required: ['text'],
              additionalProperties: false,
            },
          ],
        };
      }
      let accepted: Json;
      try {
        accepted = await context.requestInput({
          schema: {
            type: 'object',
            properties,
            required: parsed.map((question) => question.id),
            additionalProperties: false,
          },
        });
      } catch (error) {
        // This leaf only requests information. Preserve the exact original cancellation,
        // while leaving unrelated errors to Core's ordinary attempted-Tool classification.
        if (
          error instanceof AgentError &&
          error.code === 'cancel_requested' &&
          context.signal.aborted &&
          error === context.signal.reason
        )
          return { outcome: 'cancelled', content: 'cancel_requested' };
        throw error;
      }
      const raw = object(
        accepted,
        parsed.map((question) => question.id),
      );
      const answers: Record<string, string> = {};
      for (const question of parsed) {
        const value = raw[question.id]!;
        if (typeof value === 'string') {
          const choice = question.choices.find((choice) => choice.id === value);
          if (!choice) throw new AgentError('invalid_ask_user_answer');
          answers[question.id] = choice.label;
        } else {
          answers[question.id] = text(object(value, ['text']).text!);
        }
      }
      const answer =
        parsed.length === 1
          ? answers[parsed[0]!.id]!
          : parsed.map((question) => `${question.question}: ${answers[question.id]}`).join('\n');
      const details = { answer, answers };
      return { outcome: 'succeeded', content: canonicalJson(details), details };
    },
  };
  return defineExtension({ id: 'builtin.ask-user', version: '1', apiMajor: 1, tools: [tool] });
}
