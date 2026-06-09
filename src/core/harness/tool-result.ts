import type {
  AgentPlan,
  ShellGrantUsed,
  WorkspaceAccess,
} from "@/protocol/events";
import type {
  ShellResult,
  ShellIntent,
  ThreadAuthorizationState,
} from "@/core/types";

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
  /** 执行该结果对应的工具名称 / Tool name that produced this result */
  tool?: string;
  /** 失败时交给模型的结构化指导 / Structured guidance returned on failure */
  failure?: ToolFailure;
  /** 文件工具返回的相对路径 / Relative path returned by file tools */
  path?: string;
  /** update_plan 返回的持久化计划 / Plan state returned by update_plan */
  plan?: AgentPlan;
  /** shell_execute 返回的 action envelope 元数据 / Action envelope metadata returned by shell_execute */
  action?: {
    /** 模型表达的命令意图 / Model-declared command intent */
    intent?: ShellIntent;
    /** 当前命令要达成的目标 / Objective for this command */
    objective?: string;
    /** 预期观察结果 / Expected observation */
    expectedObservation?: string;
    /** 失败后的处理策略 / Strategy if the command fails */
    failureStrategy?: string;
    /** 模型建议的 prefix 授权规则 / Suggested prefix grant rule */
    prefixRule?: string[];
    /** 实际使用的授权来源 / Actual grant source used */
    grantUsed: ShellGrantUsed;
  };
  /** 保留给未来显式访问权限切换工具的更新 / Reserved for future explicit access-switch tool updates */
  workspaceAccess?: WorkspaceAccess;
  /** 更新后的授权状态 / Updated authorization state */
  authorization?: ThreadAuthorizationState;
  /** Skill 工具激活的关键指令（从 <EXTREMELY-IMPORTANT> 提取）/ Skill-activated critical instructions extracted from <EXTREMELY-IMPORTANT> */
  activeSkillInstructions?: string;
  /** read_file 返回的文件总行数，用于 TUI 展示行号范围 / Total lines in file returned by read_file for TUI line range display */
  totalLines?: number;
};
