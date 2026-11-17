import { expect, test } from 'bun:test';
import { modelReference } from '../../../packages/agent/src/model-reference';
import { currentPlanWorkResponses } from './current-plan';
import type { MockChatRequest, MockResponse } from './fixtures';
import { projectOriginalModelToolCall } from './model-tool-contract';

const identity = { planId: 'fixture-plan', version: 2, digest: 'exact-plan-digest' };
const readReceipt = {
  current: identity,
  runId: 'original-run',
  progress: null,
  plan_ref: modelReference('plan', 'original-read'),
  progress_ref: null,
};
const request = (id: string, content: unknown): MockChatRequest => ({
  body: {},
  messages: [{ role: 'tool', tool_call_id: id, content: JSON.stringify(content) }],
});
const resolve = (response: MockResponse, input: MockChatRequest) => response.response!(input);

test('current plan helper copies exact read/update refs and preserves each work receipt through the real model codec', async () => {
  const responses = currentPlanWorkResponses('review', ['first', 'second']);
  await resolve(responses[1]!, request('review-current', readReceipt));
  const first = await resolve(
    responses[2]!,
    request('review-work-0', { runId: 'original-run', executionId: 'first-work' }),
  );
  const firstCall = first.message!.tool_calls![0]!;
  expect(firstCall.args).toEqual({
    planRef: readReceipt.plan_ref,
    progressRef: null,
    stepId: 'first',
    status: 'completed',
    executionId: 'first-work',
    completePlan: false,
  });
  expect(projectOriginalModelToolCall(firstCall, { body: {}, messages: [] })).toEqual({
    id: 'review-progress-0',
    name: 'update_plan_progress',
    args: {
      plan_ref: readReceipt.plan_ref,
      progress_ref: null,
      step_id: 'first',
      status: 'completed',
      execution_id: 'first-work',
      complete_plan: false,
    },
  });
  const updated = {
    ...identity,
    runId: 'original-run',
    revision: '7',
    plan_ref: modelReference('plan', 'original-update', undefined, '3'),
    progress_ref: modelReference('progress', 'original-update', undefined, '3'),
  };
  await resolve(responses[3]!, request('review-progress-0', updated));
  const second = await resolve(
    responses[4]!,
    request('review-work-1', { runId: 'original-run', executionId: 'second-work' }),
  );
  const secondCall = second.message!.tool_calls![0]!;
  expect(secondCall.args).toEqual({
    planRef: updated.plan_ref,
    progressRef: updated.progress_ref,
    stepId: 'second',
    status: 'completed',
    executionId: 'second-work',
    completePlan: true,
  });
  expect(projectOriginalModelToolCall(secondCall, { body: {}, messages: [] }).args).toEqual({
    plan_ref: updated.plan_ref,
    progress_ref: updated.progress_ref,
    step_id: 'second',
    status: 'completed',
    execution_id: 'second-work',
    complete_plan: true,
  });
});

test('current plan helper rejects missing or duplicate original read and invalid initial refs', async () => {
  for (const input of [
    { body: {}, messages: [] },
    {
      body: {},
      messages: [
        ...request('review-current', readReceipt).messages,
        ...request('review-current', readReceipt).messages,
      ],
    },
    request('review-current', { ...readReceipt, plan_ref: undefined }),
    request('review-current', { ...readReceipt, progress_ref: 'progress.not-initial' }),
  ]) {
    const responses = currentPlanWorkResponses('review', ['first']);
    await expect(Promise.resolve().then(() => resolve(responses[1]!, input))).rejects.toThrow();
  }
});

test('current plan helper rejects changed progress identity or wrong work Run without inventing refs', async () => {
  for (const patch of [
    { runId: 'foreign-run' },
    { planId: 'foreign-plan' },
    { version: 3 },
    { digest: 'changed-plan' },
    { progress_ref: undefined },
    { plan_ref: undefined },
  ]) {
    const responses = currentPlanWorkResponses('review', ['first', 'second']);
    await resolve(responses[1]!, request('review-current', readReceipt));
    await expect(
      Promise.resolve().then(() =>
        resolve(
          responses[3]!,
          request('review-progress-0', {
            ...identity,
            runId: 'original-run',
            revision: '7',
            plan_ref: modelReference('plan', 'original-update'),
            progress_ref: modelReference('progress', 'original-update'),
            ...patch,
          }),
        ),
      ),
    ).rejects.toThrow();
  }
  const responses = currentPlanWorkResponses('review', ['first']);
  await resolve(responses[1]!, request('review-current', readReceipt));
  for (const content of [{ runId: 'foreign-run', executionId: 'work' }, { runId: 'original-run' }])
    await expect(
      Promise.resolve().then(() => resolve(responses[2]!, request('review-work-0', content))),
    ).rejects.toThrow('current_plan_work_receipt_unavailable');
});
