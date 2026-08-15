import type { ExhaustionSignal } from '@/core/execution/journal';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { ToolResultMeta } from '@/core/runtime/state';
import type { SubAgentResult } from '@/core/subagent/types';
import type { ShellIntent, ShellResult, ThreadAuthorizationState } from '@/core/types';
import type { CapabilityResult } from '@/protocol/capabilities';
import type { AgentPlan, ShellGrantUsed, WorkspaceAccess } from '@/protocol/events';

/** 工具失败时提供给模型的结构化原因和用法提示 / Structured tool failure guidance for the model */
export interface ToolFailure {
  /** 固定说明工具执行失败 / Stable failure message */
  message: 'Tool execution failed.';
  /** 失败的工具名称 / Failed tool name */
  tool: string;
  /** 具体失败原因 / Concrete failure reason */
  reason: string;
  /** 正确使用该工具的提示 / Guidance for using the tool correctly */
  guidance: string;
  /** 同指纹连续失败达上限时的耗尽信号 / Set when repeated same(error,tool,path) failures exhaust the retry limit */
  exhausted?: ExhaustionSignal;
}

/** 工具执行结果类型 / Tool execution result type */
export type ToolExecutionResult = ShellResult & {
  /** Runtime facts emitted by coordination/runtime-action tools for controller persistence. */
  runtimeEvents?: RuntimeEvent[];
  /** Registry-owned metadata-only classifier advice, preserved to the canonical terminal event. */
  classifierAdviceV1?: import('@/core/runtime/tool-outcome').ToolOutcomeClassifierAdviceV1;
  classifierDiagnostic?: 'classifier_threw';
  /** Structured result facts retained independently from stdout serialization. */
  resultMeta?: ToolResultMeta;
  /** Project-level execution status. LangChain ToolMessage still maps this to success/error only. */
  status?: 'success' | 'error' | 'rejected' | 'exhausted';
  /** Runtime interaction route required before this tool may execute. */
  approvalRoute?: 'user' | 'auto_review';
  /** 执行该结果对应的工具名称 / Tool name that produced this result */
  tool?: string;
  /** 失败时交给模型的结构化指导 / Structured guidance returned on failure */
  failure?: ToolFailure;
  /** 文件工具返回的相对路径 / Relative path returned by file tools */
  path?: string;
  /** shell_execute 返回的 action envelope 元数据 / Action envelope metadata returned by shell_execute */
  action?: {
    /** 从命令形态派生的命令分类 / Command classification derived from command shape */
    intent?: ShellIntent;
    /** 实际使用的授权来源 / Actual grant source used */
    grantUsed: ShellGrantUsed;
  };
  /** 保留给未来显式访问权限切换工具的更新 / Reserved for future explicit access-switch tool updates */
  workspaceAccess?: WorkspaceAccess;
  /** 更新后的授权状态 / Updated authorization state */
  authorization?: ThreadAuthorizationState;
  /** read_file 返回的文件总行数，用于 TUI 展示行号范围 / Total lines in file returned by read_file for TUI line range display */
  totalLines?: number;
  subagentResult?: SubAgentResult;
  /** MCP result retained for Runtime evidence recording; transcript output remains serialized JSON. */
  capabilityResult?: CapabilityResult;
};

/** executeOneTool 产出的副作用字段，与 ToolExecutionResult 中的非核心字段对应。
 *  每个字段对应一个 state channel，tools 节点必须显式传播。
 *  Side effects extracted from ToolExecutionResult that must flow into graph state.
 *  Each entry corresponds to a state channel the tools node must propagate explicitly. */
export interface ToolExecutionSideEffects {
  plan?: AgentPlan;
  workspaceAccess?: WorkspaceAccess;
  authorization?: ThreadAuthorizationState;
  /** task 工具子 agent 被阻塞时产生的审批挂起状态 / Pending sub-agent approval when task tool is blocked */
  pendingSubagentApproval?: unknown;
}
