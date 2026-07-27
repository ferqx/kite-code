/**
 * Registry dispatch — 注册工具的唯一执行入口（ADR-0043 §1）。
 * Registry dispatch — the only execution entrypoint for registered tools (ADR-0043 §1).
 *
 * 阶段 1.1 只提供 spec 执行序列（preExecute → execute → projectResult）。
 * Policy 预检（evaluateToolApproval + mode policy + permit 认领）仍在现有
 * runApprovedTool 管线中；阶段 1.2 逐工具迁移时上提为管线公共段。
 */
import type {
  ExecutableToolSpec,
  PreExecuteOutcome,
  ProjectedToolResult,
  ToolExecutionContext,
} from './spec';

export type DispatchOutcome<Output> =
  | { dispatched: true; output: Output; projected: ProjectedToolResult }
  | { dispatched: false; rejection: { ok: false; error: string; guidance?: string } };

export async function dispatchRegisteredTool<Input, Output>(
  spec: ExecutableToolSpec<Input, Output>,
  input: Input,
  context: ToolExecutionContext,
): Promise<DispatchOutcome<Output>> {
  const pre: PreExecuteOutcome = (await spec.preExecute?.(input, context)) ?? { proceed: true };
  if (!pre.proceed) {
    return { dispatched: false, rejection: pre.rejection };
  }
  const output = await spec.execute(input, context);
  const projectionContext = { ...context, invocationInput: input };
  return {
    dispatched: true,
    output,
    projected: spec.projectResult(output, projectionContext),
  };
}
