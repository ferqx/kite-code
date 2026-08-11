/**
 * Registry dispatch — 注册工具的唯一执行入口（ADR-0043 §1）。
 * Registry dispatch — the only execution entrypoint for registered tools (ADR-0043 §1).
 *
 * 阶段 1.1 只提供 spec 执行序列（preExecute → execute → projectResult）。
 * Policy 预检（evaluateToolApproval + mode policy + permit 认领）仍在现有
 * runApprovedTool 管线中；阶段 1.2 逐工具迁移时上提为管线公共段。
 */

import { classifyFailure } from '@/core/runtime/failures';
import {
  CORE_TOOL_FAILURE_BUDGET_V2,
  coreToolFailureContentV2,
  finalizeProjectedToolResultV2,
  resolveBuiltinToolResultBudgetV2,
} from '@/core/tools/result-budget-v2';
import type {
  BaseToolSpec,
  ExecutableToolSpec,
  PreExecuteOutcome,
  ProjectedToolResult,
  ToolExecutionContext,
} from './spec';

export function evaluateRegisteredToolProtectedPaths<Input>(
  spec: BaseToolSpec<string, Input>,
  input: Input,
  context: ToolExecutionContext,
): { ok: true } | { ok: false; error: string } {
  const evaluator = context.protectedPathEvaluator;
  if (!evaluator || !spec.protectedPathAccesses) return { ok: true };
  for (const access of spec.protectedPathAccesses(input, context)) {
    const decision = evaluator.evaluate(access);
    if (decision.outcome !== 'allow') {
      return {
        ok: false,
        error: `Rejected by protected-path policy: ${decision.operation} '${access.path}' (${decision.reason}${decision.matchedRule ? `: ${decision.matchedRule}` : ''}).`,
      };
    }
  }
  return { ok: true };
}

export type DispatchOutcome<Output> =
  | { dispatched: true; output: Output; projected: ProjectedToolResult }
  | { dispatched: false; rejection: { ok: false; error: string; guidance?: string } };

export async function dispatchRegisteredTool<Input, Output>(
  spec: ExecutableToolSpec<string, Input, Output>,
  input: Input,
  context: ToolExecutionContext,
): Promise<DispatchOutcome<Output>> {
  const pathDecision = evaluateRegisteredToolProtectedPaths(spec, input, context);
  if (!pathDecision.ok) {
    return { dispatched: false, rejection: { ok: false, error: pathDecision.error } };
  }
  const pre: PreExecuteOutcome = (await spec.preExecute?.(input, context)) ?? { proceed: true };
  if (!pre.proceed) {
    return { dispatched: false, rejection: pre.rejection };
  }
  const output = await spec.execute(input, context);
  const projectionContext = { ...context, invocationInput: input };
  try {
    const projected = spec.projectResult(output, projectionContext);
    const finalized = finalizeProjectedToolResultV2({
      rawResult: output,
      projected,
      resolvedBudget: resolveBuiltinToolResultBudgetV2({
        toolName: spec.name,
        budget: spec.modelResultBudgetV2,
        governanceRevision: spec.governanceRevision,
      }),
      projectionMode: context.featureFlags?.toolResultBudgetV2 ? 'budget_v2' : 'compat_v1',
      continuation: projected.resultMeta.continuation,
    });
    return {
      dispatched: true,
      output,
      projected: {
        ...projected,
        modelContent: finalized.modelContent,
        ...(finalized.streams ? { streams: finalized.streams } : {}),
        resultMeta: finalized.resultMeta,
      },
    };
  } catch {
    const effectValues = Object.values(spec.declaredEffects);
    const knownExternalEffects = effectValues.every(
      (effect) => effect === 'none' || effect === 'read',
    )
      ? ('none' as const)
      : ('unknown' as const);
    const failure = {
      ...classifyFailure(
        'projection_failed_after_execution',
        'Tool execution completed, but its model result could not be projected safely.',
      ),
      executionCertainty: 'executed' as const,
      knownExternalEffects,
    };
    const content = coreToolFailureContentV2('projection_failed_after_execution');
    const finalized = finalizeProjectedToolResultV2({
      rawResult: {
        code: 'projection_failed_after_execution',
        executionCertainty: failure.executionCertainty,
        knownExternalEffects: failure.knownExternalEffects,
      },
      projected: {
        ok: false,
        modelContent: content,
        resultMeta: { projectionFailure: failure },
      },
      resolvedBudget: resolveBuiltinToolResultBudgetV2({
        toolName: 'core-tool-failure:v1',
        budget: CORE_TOOL_FAILURE_BUDGET_V2,
      }),
      projectionMode: context.featureFlags?.toolResultBudgetV2 ? 'budget_v2' : 'compat_v1',
    });
    return {
      dispatched: true,
      output,
      projected: {
        ok: finalized.ok,
        modelContent: finalized.modelContent,
        resultMeta: finalized.resultMeta,
        display: { verb: 'Finish' },
      },
    };
  }
}
