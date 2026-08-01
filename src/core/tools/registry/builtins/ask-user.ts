import { z } from 'zod';
import { ASK_USER_CONTRACT } from '@/core/tools/tool-contracts';
import type { UserInputRequest } from '@/protocol/events';
import { defineInterruptTool } from '../spec';

const optionSchema = z
  .object({
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();
const questionSchema = z
  .object({
    question: z.string().trim().min(1),
    options: z.array(optionSchema).min(2).max(3),
  })
  .strict();

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
      ...option,
    }));
    return {
      id,
      question: question.question,
      options,
      recommended: options[0]!.id,
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
