import type { AcceptedInformation, Json, ToolContext, ToolResult } from '../../extensions';
import { canonicalJson } from '../../json';
import type { AgentRuntime } from '../../runtime';
import { AgentError } from '../../storage/types';
import { type BrowserController, type BrowserTarget, browserExtensionId } from './types';

/** Informational answer only. The resulting Action still authorizes independently. */
export function browserHumanQuestion(target: BrowserTarget, reason: string): Json {
  return {
    browser: { ...target },
    schema: {
      type: 'object',
      title: '浏览器等待人工',
      description: reason,
      properties: {
        control: {
          title: '处理完成后',
          anyOf: [
            { const: 'continue', title: '继续交给 Agent' },
            { const: 'stop', title: '停止浏览器任务' },
          ],
        },
      },
      required: ['control'],
      additionalProperties: false,
    },
  };
}
type Host = Pick<
  AgentRuntime,
  | 'getExecution'
  | 'getRun'
  | 'getCommand'
  | 'getInteraction'
  | 'invokeActionFromTool'
  | 'cancelExecution'
>;
const failed = (code: string): ToolResult => ({
  outcome: 'failed',
  content: code,
  details: { code },
});

/** Trusted host binding. Never takes a caller-supplied Action, subject, or parent. */
export function createBrowserHumanRequest(options: {
  controller: BrowserController;
  runtime(): Host;
}) {
  return async (
    context: ToolContext,
    target: BrowserTarget,
    reason: string,
  ): Promise<ToolResult> => {
    if (!context.requestInteractionWithReceipt)
      return failed('browser_human_continuation_unavailable');
    const host = options.runtime();
    const own = await host.getExecution(context.executionId);
    const run = own?.runId ? await host.getRun(own.runId) : null;
    const origin = run ? await host.getCommand(run.originCommandId) : null;
    if (
      !own ||
      !run?.isActive ||
      !origin ||
      own.kind !== 'tool' ||
      own.definitionId !== 'browser.request_human' ||
      own.definitionVersion !== '1' ||
      own.sessionId !== context.sessionId ||
      run.sessionId !== context.sessionId ||
      own.runId !== context.runId ||
      own.originStoreId !== origin.originStoreId ||
      !['dispatching', 'running'].includes(own.status) ||
      own.cancelRequestedAt !== null
    )
      throw new AgentError('browser_human_scope_invalid');
    context.signal.throwIfAborted();
    const yielded = await options.controller.handoff(
      context.sessionId,
      target,
      context.signal,
      reason,
    );
    if (yielded.outcome !== 'succeeded') return yielded;
    // Handoff invalidates the old generation. Bind the question to the actual
    // confirmed human generation, never the model's pre-handoff target.
    const human = options.controller.view(context.sessionId);
    if (
      human?.state !== 'human' ||
      human.browserId !== target.browserId ||
      human.humanRequest !== reason
    )
      return failed('browser_human_target_changed');
    const handedTarget = { browserId: human.browserId, generation: human.generation };
    const request = browserHumanQuestion(handedTarget, reason);
    let cancellation: Promise<unknown> | undefined;
    const unwatch = options.controller.watchControl(context.sessionId, handedTarget, (state) => {
      if (state === 'human' || context.signal.aborted || cancellation) return;
      // A stopped/lost page ends only this original waiting Tool. This is host
      // cleanup of its live execution, never a fabricated human answer or resume.
      cancellation = host.cancelExecution({
        expectedStoreId: own.originStoreId,
        sessionId: own.sessionId,
        subjectId: origin.subjectId,
        commandId: `browser-human-ended-${own.id}`,
        executionId: own.id,
      });
      void cancellation.catch(() => {});
    });
    try {
      const accepted = await context.requestInteractionWithReceipt({ kind: 'question', request });
      context.signal.throwIfAborted();
      const interaction = await host.getInteraction({
        expectedStoreId: own.originStoreId,
        sessionId: own.sessionId,
        interactionId: accepted.interactionId,
      });
      if (
        !validReceipt(accepted, own, request) ||
        !interaction ||
        interaction.state !== 'answered' ||
        interaction.acceptedDecisionRevision !== accepted.decisionRevision ||
        interaction.executionId !== own.id ||
        interaction.attempt !== own.attempt ||
        canonicalJson(interaction.answer as Json) !==
          canonicalJson(accepted.answer as unknown as Json) ||
        canonicalJson(interaction.request) !== canonicalJson(request)
      )
        throw new AgentError('browser_human_receipt_invalid');
      const choice =
        accepted.answer.kind === 'question' &&
        accepted.answer.answers &&
        typeof accepted.answer.answers === 'object' &&
        !Array.isArray(accepted.answer.answers)
          ? accepted.answer.answers.control
          : null;
      if (choice !== 'continue' && choice !== 'stop')
        throw new AgentError('browser_human_receipt_invalid');
      const view = options.controller.view(context.sessionId);
      if (
        view?.state !== 'human' ||
        view.browserId !== handedTarget.browserId ||
        view.generation !== handedTarget.generation ||
        view.humanRequest !== reason ||
        cancellation
      )
        return failed('browser_human_target_changed');
      unwatch();
      const actionId = choice === 'continue' ? 'browser.resume' : 'browser.close';
      const receipt = await host.invokeActionFromTool({
        expectedStoreId: own.originStoreId,
        sessionId: own.sessionId,
        subjectId: origin.subjectId,
        parentExecutionId: own.id,
        commandId: `browser-human-${accepted.interactionId}-${choice}`,
        request: {
          kind: 'extension.invoke',
          extensionId: browserExtensionId,
          actionId,
          definitionVersion: '1',
          input: { ...handedTarget },
        },
      });
      const id =
        receipt.receipt && typeof receipt.receipt === 'object' && !Array.isArray(receipt.receipt)
          ? receipt.receipt.executionId
          : null;
      const result = typeof id === 'string' ? await host.getExecution(id) : null;
      if (
        !result ||
        result.kind !== 'job' ||
        result.runId !== null ||
        result.originCommandId !== receipt.id ||
        result.sessionId !== own.sessionId ||
        result.originStoreId !== own.originStoreId ||
        !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(result.status) ||
        !result.result ||
        result.parentExecutionId !== own.id ||
        result.definitionId !== `${browserExtensionId}/${actionId}` ||
        result.definitionVersion !== '1'
      )
        return { outcome: 'outcome_unknown', content: 'browser_human_action_unconfirmed' };
      return result.result as unknown as ToolResult;
    } finally {
      unwatch();
      if (cancellation) await cancellation;
    }
  };
}
function validReceipt(
  accepted: AcceptedInformation,
  own: Awaited<ReturnType<Host['getExecution']>> & {},
  request: Json,
) {
  return (
    accepted.executionId === own.id &&
    accepted.sessionId === own.sessionId &&
    accepted.originStoreId === own.originStoreId &&
    accepted.runId === own.runId &&
    accepted.attempt === own.attempt &&
    accepted.decisionRevision.length > 0 &&
    canonicalJson(accepted.request) === canonicalJson(request)
  );
}
