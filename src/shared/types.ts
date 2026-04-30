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

/** shell_execute 的模型意图 / Model intent for shell_execute */
export type ShellIntent = "inspect" | "verify" | "build" | "test" | "git" | "other";

/** shell_execute 的授权请求类型 / Shell approval grant requested or selected */
export type ShellApprovalGrant = "approve_once" | "same_command" | "full_access";

/** shell_execute 工具结果中的授权来源 / Grant source recorded in shell_execute results */
export type ShellGrantUsed = "none" | ShellApprovalGrant;

/** shell_execute action envelope / shell_execute action envelope */
export interface ShellActionEnvelope {
  /** shell 命令 / Shell command */
  command: string;
  /** 模型表达的命令意图 / Model-declared command intent */
  intent?: ShellIntent;
  /** 当前命令要达成的目标 / Objective for this command */
  objective?: string;
  /** 模型给出的执行理由 / Model-provided justification */
  justification?: string;
  /** 预期观察结果 / Expected observation */
  expected_observation?: string;
  /** 失败后的处理策略 / Strategy if the command fails */
  failure_strategy?: string;
  /** 模型建议的未来 prefix 授权规则，仅用于审计展示 / Suggested future prefix grant rule for audit only */
  prefix_rule?: string[];
  /** 模型建议的授权粒度，最终以用户 resume payload 为准 / Suggested grant, user resume decides */
  grant_request?: ShellApprovalGrant;
}

/** 当前 thread 的 shell 授权状态 / Thread-scoped shell authorization state */
export interface ThreadAuthorizationState {
  /** 当前授权模式 / Current authorization mode */
  mode: "default" | "full_access";
  /** 已批准的 same_command 授权记录 / Approved exact-command grants */
  commandGrants: Record<
    string,
    {
      /** 工作目录路径 / Workspace path */
      workspace: string;
      /** LangGraph thread id / LangGraph thread id */
      threadId: string;
      /** command.trim() 后的精确命令 / Exact trimmed command */
      command: string;
    }
  >;
}

/** 工作区访问权限 / Workspace access level */
export type WorkspaceAccess = "read-only" | "write";

/** Agent 执行阶段 / Agent execution phase */
export type AgentPhase = "planning" | "building";

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
      /** 用户选择的授权粒度 / User-selected grant scope */
      grant?: ShellApprovalGrant;
      /** 当前审批请求 hash / Current approval request hash */
      approvalHash?: string;
      /** 用户替换后的命令 / User-provided replacement command */
      replacementCommand?: string;
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
