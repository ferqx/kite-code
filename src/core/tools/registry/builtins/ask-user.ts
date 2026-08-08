import { z } from 'zod';
import { ASK_USER_CONTRACT } from '@/core/tools/tool-contracts';
import type { UserInputRequest } from '@/protocol/events';
import { defineInterruptTool } from '../spec';

const optionSchema = z
  .object({
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
    /** Marks this option as the single recommended choice shown by the TUI. */
    /** Every option declares its marker; exactly one option per question must be true. */
    recommended: z.boolean(),
  })
  .strict();
const questionSchema = z
  .object({
    question: z.string().trim().min(1),
    options: z.array(optionSchema).min(2).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    const recommendedCount = value.options.filter((option) => option.recommended === true).length;
    if (recommendedCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Exactly one option must set recommended to true',
      });
    }
  });

export const askUserInputSchema = z
  .object({
    questions: z.array(questionSchema).min(1).max(3),
  })
  .strict();

export type AskUserInput = z.infer<typeof askUserInputSchema>;

export function normalizeAskUserInput(input: AskUserInput): UserInputRequest {
  const questions = input.questions.map((question, questionIndex) => {
    const id = `q${questionIndex + 1}`;
    const options = question.options.map((option, optionIndex) => ({
      id: `${id}-o${optionIndex + 1}`,
      label: option.label,
      description: option.description,
    }));
    const recommendedIndex = question.options.findIndex((option) => option.recommended === true);
    const recommended = options[recommendedIndex]!.id;
    return {
      id,
      question: question.question,
      options,
      recommended,
      allow_free_text: true,
    };
  });
  const first = questions[0]!;
  return {
    question: first.question,
    options: first.options,
    recommended: first.recommended,
    allow_free_text: true,
    questions,
  };
}

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
  createInterrupt: (input) => normalizeAskUserInput(input),
});
