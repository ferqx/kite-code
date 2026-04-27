import { type BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type {
  AgentPlan,
  ContextBudget,
  WorkspaceAccess,
} from "../shared/types";

export const AgentState = Annotation.Root({
  /** 用户 ID / User ID */
  userId: Annotation<string>,
  /** 工作目录路径 / Workspace path */
  workspace: Annotation<string>,
  /** 工作区访问权限 read-only/write / Workspace access level (read-only/write) */
  workspaceAccess: Annotation<WorkspaceAccess>({
    reducer: (_left, right) => right,
    default: () => "write",
  }),
  /** 持久化的执行计划 / Persisted execution plan */
  plan: Annotation<AgentPlan | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  /** 上下文摘要 / Context summary from compaction */
  contextSummary: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  /** 上下文预算配置 / Context budget configuration */
  contextBudget: Annotation<ContextBudget | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  /** 对话消息列表 / Conversation message list */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /** 最终回答文本 / Final answer text */
  final: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

export type CodeAgentState = typeof AgentState.State;

/** 检查当前是否为只读工作区访问 / Check if current workspace access is read-only */
export function isReadOnlyWorkspaceAccess(
  state: Pick<CodeAgentState, "workspaceAccess">,
): boolean {
  return state.workspaceAccess === "read-only";
}
