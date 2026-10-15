import { expect } from 'bun:test';
import type { MockChatRequest, MockModelServer, MockResponse } from './fixtures';
import { parseDraftSavedPlan } from './fixtures';
import { waitForCondition } from './terminal-screen';
import {
  observePersistedTurnEvents,
  requirePersistedRuntimeReady,
  type TestWorkspace,
} from './test-workspace';

function toolResult(request: MockChatRequest, id: string): Record<string, unknown> {
  const values = request.messages.filter(
    (message) => message.role === 'tool' && message.tool_call_id === id,
  );
  if (values.length !== 1) throw Error(`current_plan_original_result_missing:${id}`);
  return JSON.parse(String(values[0]!.content));
}

/** Each completed step has a real current-Run File receipt and exact progress CAS. */
export function currentPlanWorkResponses(
  reviewCallId: string,
  steps: readonly string[],
  work?: { kind: 'read'; path: string },
): MockResponse[] {
  let identity: ReturnType<typeof parseDraftSavedPlan>,
    runId: string,
    revision: string | null = null;
  const readId = `${reviewCallId}-current`;
  return [
    {
      expectedRequest: {
        toolResults: [{ toolCallId: reviewCallId, contentIncludes: ['"status":"approved"'] }],
      },
      message: { tool_calls: [{ id: readId, name: 'planning.read', args: {} }] },
    },
    ...steps.flatMap((stepId, index): MockResponse[] => {
      const previousId = index === 0 ? readId : `${reviewCallId}-progress-${index - 1}`;
      const writeId = `${reviewCallId}-work-${index}`,
        updateId = `${reviewCallId}-progress-${index}`;
      const path = work?.path ?? `plan-evidence-${stepId}.txt`;
      return [
        {
          response(request) {
            const value = toolResult(request, previousId);
            if (index === 0) {
              identity = parseDraftSavedPlan(JSON.stringify(value.current));
              if (typeof value.runId !== 'string' || value.progress !== null)
                throw Error('current_plan_run_or_initial_progress_unavailable');
              runId = value.runId;
            } else {
              if (value.runId !== runId || typeof value.revision !== 'string')
                throw Error('current_plan_progress_receipt_unavailable');
              revision = value.revision;
            }
            return {
              expectedRequest: {
                toolResults: [
                  {
                    toolCallId: previousId,
                    contentIncludes: index === 0 ? ['"runId"', '"current"'] : ['"revision"'],
                  },
                ],
              },
              message: {
                tool_calls: [
                  {
                    id: writeId,
                    name: work?.kind === 'read' ? 'read_file' : 'write_file',
                    args:
                      work?.kind === 'read'
                        ? { path }
                        : { path, content: `Completed ${stepId} in the approved plan.\n` },
                  },
                ],
              },
            };
          },
        },
        {
          response(request) {
            const actual = toolResult(request, writeId);
            if (typeof actual.executionId !== 'string' || actual.runId !== runId)
              throw Error('current_plan_work_receipt_unavailable');
            return {
              expectedRequest: {
                toolResults: [{ toolCallId: writeId, contentIncludes: [path, '"executionId"'] }],
              },
              message: {
                tool_calls: [
                  {
                    id: updateId,
                    name: 'planning.update',
                    args: {
                      runId,
                      planId: identity.plan_id,
                      version: identity.version,
                      digest: identity.structural_digest,
                      expectedProgressRevision: revision,
                      stepId,
                      status: 'completed',
                      executionId: actual.executionId,
                      completePlan: index === steps.length - 1,
                    },
                  },
                ],
              },
            };
          },
        },
      ];
    }),
  ];
}

/** The new Core has one Run boundary; it does not fabricate separate legacy run/turn events. */
export async function assertCurrentPlanCompletion(
  workspace: TestWorkspace,
  task: string,
  server: MockModelServer,
) {
  await waitForCondition(
    () => {
      const value = observePersistedTurnEvents(workspace, task);
      return (
        value.status === 'ready' &&
        value.value?.events.some(
          (event) => event.type === 'run.finished' && event.status === 'completed',
        ) === true
      );
    },
    `actual completed Run for ${task}`,
    10_000,
  );
  const actual = requirePersistedRuntimeReady(observePersistedTurnEvents(workspace, task));
  expect(actual).toBeDefined();
  const terminal = actual!.events.filter((event) => event.type === 'run.finished');
  expect(terminal).toHaveLength(1);
  expect(terminal[0]!.status).toBe('completed');
  expect(actual!.events.some((event) => event.status === 'outcome_unknown')).toBe(false);
  const diagnostics = new Set(
    server
      .getRequests()
      .flatMap((request) => request.messages)
      .filter(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('completion_diagnostic') &&
          message.content.includes('plan_draft_pending'),
      )
      .map((message) => String(message.content)),
  );
  expect(diagnostics.size).toBe(1);
}
