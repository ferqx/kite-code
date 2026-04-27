/** 文件补丁输入 / File patch input */
export interface ApplyPatchInput {
  /** 工作目录路径 / Workspace directory path */
  workspace: string;
  /** 目标文件路径 / Target file path */
  path: string;
  /** 文件内容 / File content */
  content: string;
  /** 可选的 Shell 执行器 / Optional shell executor */
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

/** 补丁操作结果 / Patch operation result */
export interface ApplyPatchResult {
  /** 操作是否成功 / Whether the operation succeeded */
  ok: boolean;
  /** 目标文件路径 / Target file path */
  path: string;
  /** 结果消息 / Result message */
  message: string;
}

/** Shell 命令输入 / Shell command input */
export interface ShellInput {
  /** 工作目录路径 / Workspace directory path */
  workspace: string;
  /** 要执行的 Shell 命令 / Shell command to execute */
  command: string;
}

/** Shell 命令执行结果 / Shell command execution result */
export interface ShellResult {
  /** 命令是否成功执行 / Whether the command succeeded */
  ok: boolean;
  /** 执行的命令 / The executed command */
  command: string;
  /** 退出码 / Exit code */
  exitCode: number;
  /** 标准输出 / Standard output */
  stdout: string;
  /** 标准错误输出 / Standard error output */
  stderr: string;
}

/** 工作区访问权限 / Workspace access level */
export type WorkspaceAccess = "read-only" | "write";

/** CLI/API 层面的访问请求（含兼容 mode 值）/ CLI/API-facing workspace access request including legacy mode values */
export type WorkspaceAccessRequest =
  | "auto"
  | WorkspaceAccess
  | "plan"
  | "builder";

/** 用户澄清问题选项 / User clarification option */
export interface UserInputOption {
  /** 选项 ID / Option ID */
  id: string;
  /** 选项展示标签 / Option display label */
  label: string;
  /** 可选说明 / Optional description */
  description?: string;
}

/** 用户澄清请求 / User clarification request */
export interface UserInputRequest {
  /** 要询问用户的问题 / Question to ask the user */
  question: string;
  /** 预置选项 / Suggested options */
  options: UserInputOption[];
  /** 是否允许自由文本输入 / Whether free-text input is allowed */
  allow_free_text: boolean;
  /** 可选上下文 / Optional context */
  context?: string;
}

/** 工具审批恢复值 / Tool approval resume value */
export type ToolApprovalResumeValue =
  | boolean
  | {
      /** 是否审批通过 / Whether approved */
      approved?: boolean;
      /** 拒绝或审批原因 / Reason for approval or rejection */
      reason?: string;
    };

/** 用户输入恢复值 / User input resume value */
export type UserInputResumeValue =
  | string
  | {
      /** 用户最终回答 / Final user answer */
      answer?: string;
      /** 选择的选项 ID 或标签 / Selected option id or label */
      choice?: string;
      /** 选择的选项 ID / Selected option id */
      option_id?: string;
      /** 选择的选项 ID / Selected option id */
      optionId?: string;
      /** 用户自由文本 / User free-text input */
      free_text?: string;
      /** 用户自由文本 / User free-text input */
      freeText?: string;
      /** 用户自由文本 / User free-text input */
      text?: string;
    };

/** 恢复中断的值 / Resume value for graph interrupts */
export type AgentResumeValue = ToolApprovalResumeValue | UserInputResumeValue;

/** 上下文预算 / Context budget */
export interface ContextBudget {
  /** 保留的最大消息数量 / Maximum number of messages to keep */
  maxMessages: number;
  /** 工具输出最大字符数 / Maximum characters for tool output before truncation */
  maxToolOutputChars: number;
}

/** 计划步骤状态 / Plan step status */
export type PlanStatus = "pending" | "in_progress" | "completed";

/** 计划步骤 / Plan step item */
export interface AgentPlanStep {
  /** 步骤描述 / Step description */
  step: string;
  /** 步骤状态 / Step status */
  status: PlanStatus;
}

/** 执行计划 / Execution plan */
export interface AgentPlan {
  /** 计划名称 / Plan name */
  name: string;
  /** 计划描述 / Plan description */
  description: string;
  /** 计划整体状态 / Overall plan status */
  status: PlanStatus;
  /** 计划步骤列表 / List of plan steps */
  steps: AgentPlanStep[];
}

/** 流式事件 / Streamed event */
export interface AgentEvent {
  /** 事件类型 / Event type */
  type: string;
  /** 事件数据 / Event data */
  data: unknown;
}
