/**
 * Registry dispatch — 注册工具的唯一执行入口（ADR-0043 §1）。
 * Registry dispatch — the only execution entrypoint for registered tools (ADR-0043 §1).
 *
 * 阶段 1.1 只提供 spec 执行序列（preExecute → execute → projectResult）。
 * Policy 预检（evaluateToolApproval + mode policy + permit 认领）仍在现有
 * invokeGovernedTool 管线中；阶段 1.2 逐工具迁移时上提为管线公共段。
 */
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
  await context.beforeExecute?.();
  const output = await spec.execute(input, context);
  const projectionContext = { ...context, invocationInput: input };
  const projected = spec.projectResult(output, projectionContext);
  let outcomeAdviceV1:
    | import('@/core/runtime/tool-outcome').ToolOutcomeClassifierAdviceV1
    | undefined;
  let classifierDiagnostic: 'classifier_threw' | undefined;
  if (spec.classifyOutcomeV1) {
    try {
      outcomeAdviceV1 = spec.classifyOutcomeV1(output, projectionContext);
    } catch {
      classifierDiagnostic = 'classifier_threw';
    }
  }
  return {
    dispatched: true,
    output,
    projected: {
      ...projected,
      ...(outcomeAdviceV1 ? { outcomeAdviceV1 } : {}),
      ...(classifierDiagnostic ? { classifierDiagnostic } : {}),
    },
  };
}
