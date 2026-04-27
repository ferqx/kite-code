import type { AgentPlan, ShellResult, WorkspaceAccess } from "../shared/types";

/** 工具执行结果类型 / Tool execution result type */
export type ToolExecutionResult = ShellResult & {
  /** 文件工具返回的相对路径 / Relative path returned by file tools */
  path?: string;
  /** update_plan 返回的持久化计划 / Plan state returned by update_plan */
  plan?: AgentPlan;
  /** 保留给未来显式访问权限切换工具的更新 / Reserved for future explicit access-switch tool updates */
  workspaceAccess?: WorkspaceAccess;
};
