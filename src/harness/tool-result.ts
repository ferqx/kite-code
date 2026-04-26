import type { AgentMode, AgentPlan, ShellResult } from "../shared/types";

/** 工具执行结果类型 / Tool execution result type */
export type ToolExecutionResult = ShellResult & {
  /** 文件工具返回的相对路径 / Relative path returned by file tools */
  path?: string;
  /** update_plan 返回的持久化计划 / Plan state returned by update_plan */
  plan?: AgentPlan;
  /** update_plan 可能触发的模式切换 / Optional mode switch returned by update_plan */
  mode?: AgentMode;
};
