import { z } from 'zod';
import { ASK_USER_CONTRACT } from '@/core/tools/tool-contracts';
import type { UserInputRequest } from '@/protocol/events';
import { defineInterruptTool } from '../spec';

const optionSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  description: z.string().optional(),
});
const questionSchema = z.object({
  id: z.string().optional(),
  question: z.string().min(1),
  options: z.array(optionSchema).max(3).optional(),
  recommended: z.string().optional(),
  allow_free_text: z.boolean().optional(),
});

export const askUserInputSchema = z
  .object({
    question: z.string().min(1).optional(),
    options: z.array(optionSchema).max(3).optional(),
    recommended: z.string().optional(),
    allow_free_text: z.boolean().optional(),
    context: z.string().optional(),
    questions: z.array(questionSchema).min(1).optional(),
  })
  .superRefine((value, context) => {
    if (!value.question && !value.questions) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['question'],
        message: 'Provide question or a non-empty questions array',
      });
    }
  })
  .transform(
    (value): UserInputRequest => ({
      question: value.question ?? value.questions?.[0]?.question ?? '',
      options: value.options ?? [],
      allow_free_text: value.allow_free_text !== false,
      ...(value.context ? { context: value.context } : {}),
      ...(value.recommended ? { recommended: value.recommended } : {}),
      ...(value.questions
        ? {
            questions: value.questions.map((question) => ({
              ...question,
              options: question.options ?? [],
              allow_free_text: question.allow_free_text !== false,
            })),
          }
        : {}),
    }),
  );

export const askUserSpec = defineInterruptTool({
  name: 'ask_user',
  kind: 'interrupt',
  contract: ASK_USER_CONTRACT.sections,
  inputSchema: askUserInputSchema,
  declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'Pauses execution for explicit user input.',
  }),
  createInterrupt: (input) => input,
});
