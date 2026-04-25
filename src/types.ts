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

/** Agent 运行模式 / Agent operation mode */
export type AgentMode = "plan" | "builder";

/** CLI 层面 Agent 运行模式（含 auto）/ CLI-facing agent run mode including auto */
export type AgentRunMode = "auto" | AgentMode;

/** 上下文预算 / Context budget */
export interface ContextBudget {
  /** 保留的最大消息数量 / Maximum number of messages to keep */
  maxMessages: number;
  /** 工具输出最大字符数 / Maximum characters for tool output before truncation */
  maxToolOutputChars: number;
}

/** Agent 执行证据 / Agent execution evidence */
export interface AgentEvidence {
  /** 已执行的命令列表 / List of executed commands */
  commands: string[];
  /** 已修改的文件列表 / List of modified files */
  files: string[];
  /** 验证记录列表 / List of verification records */
  verification: string[];
}

/** Agent 进度心跳 / Agent progress heartbeat */
export interface AgentHeartbeat {
  /** 当前目标 / Current goal */
  goal: string;
  /** 发现记录 / Findings */
  findings: string[];
  /** 下一步动作 / Next planned action */
  nextAction: string;
  /** 阻塞项 / Blockers */
  blockers: string[];
  /** 验证状态 / Verification status */
  verification: string[];
}

/** Agent 进度账本 / Agent progress ledger */
export interface AgentProgressLedger {
  /** 工具调用计数 / Tool call count */
  toolCallCount: number;
  /** 停滞步数计数 / Stagnant step count */
  stagnantStepCount: number;
  /** 重复调用计数 / Repeated call count */
  repeatedCallCount: number;
  /** 上次工具调用签名 / Last tool call signature */
  lastToolSignature: string;
  /** 最近输出签名列表 / Recent output signatures */
  recentOutputSignatures: string[];
  /** 心跳状态 / Heartbeat state */
  heartbeat: AgentHeartbeat;
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
