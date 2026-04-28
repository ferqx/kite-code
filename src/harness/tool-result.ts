import type { AgentPlan, ShellResult, WorkspaceAccess } from "../shared/types";

/** 工具失败时提供给模型的结构化原因和用法提示 / Structured tool failure guidance for the model */
export interface ToolFailure {
  /** 固定说明工具执行失败 / Stable failure message */
  message: "Tool execution failed.";
  /** 失败的工具名称 / Failed tool name */
  tool: string;
  /** 具体失败原因 / Concrete failure reason */
  reason: string;
  /** 正确使用该工具的提示 / Guidance for using the tool correctly */
  guidance: string;
}

/** 工具执行结果类型 / Tool execution result type */
export type ToolExecutionResult = ShellResult & {
  /** 失败时交给模型的结构化指导 / Structured guidance returned on failure */
  failure?: ToolFailure;
  /** 文件工具返回的相对路径 / Relative path returned by file tools */
  path?: string;
  /** update_plan 返回的持久化计划 / Plan state returned by update_plan */
  plan?: AgentPlan;
  /** 保留给未来显式访问权限切换工具的更新 / Reserved for future explicit access-switch tool updates */
  workspaceAccess?: WorkspaceAccess;
};
