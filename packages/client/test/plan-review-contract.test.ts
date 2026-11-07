import { expect, test } from 'bun:test';
import {
  request_AnswerInteractionRequest,
  response_Interaction,
} from '../src/generated/validators';

const request = {
  expectedStoreId: 'store',
  commandId: 'answer-original',
  expectedRevision: '1',
};

test('new plan answers contain business decisions, never execution modes', () => {
  for (const decision of ['approve', 'revise', 'deny']) {
    const answer = { kind: 'plan_review', decision, feedback: 'original feedback' };
    expect(request_AnswerInteractionRequest({ ...request, answer })).toBe(true);
    for (const mode of ['auto', 'accept_edits', 'full'])
      expect(request_AnswerInteractionRequest({ ...request, answer: { ...answer, mode } })).toBe(
        false,
      );
  }
});

test('recorded plan answers use the same mode-free business contract', () => {
  const interaction = {
    id: 'original-plan-review',
    originStoreId: 'store',
    sessionId: 'session',
    presentationSessionId: 'session',
    ancestry: ['session'],
    runId: 'run',
    executionId: 'execution',
    attempt: 1,
    kind: 'plan_review',
    definitionId: 'planning.review',
    definitionVersion: '1',
    inputDigest: 'original-input',
    policyRevision: 'information-1',
    requiredRefs: [],
    request: {
      planId: 'plan',
      version: '1',
      digest: 'original-plan',
      content: 'Original plan',
    },
    answer: { kind: 'plan_review', decision: 'approve', feedback: 'original' },
    revision: '2',
    acceptedDecisionRevision: '2',
    state: 'answered',
  };
  const original = JSON.stringify(interaction);
  expect(response_Interaction(interaction)).toBe(true);
  expect(JSON.stringify(interaction)).toBe(original);
  expect(request_AnswerInteractionRequest({ ...request, answer: interaction.answer })).toBe(true);
});
