import { type BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type {
  AgentEvidence,
  AgentMode,
  AgentPlan,
  AgentProgressLedger,
  ContextBudget,
} from "../shared/types";
import { emptyProgressLedger } from "./progress";

export const AgentState = Annotation.Root({
  /** 用户 ID / User ID */
  userId: Annotation<string>,
  /** 工作目录路径 / Workspace path */
  workspace: Annotation<string>,
  /** 当前运行模式 plan/builder / Current run mode (plan or builder) */
  mode: Annotation<AgentMode>({
    reducer: (_left, right) => right,
    default: () => "builder",
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
  /** 执行证据记录 / Execution evidence records */
  evidence: Annotation<AgentEvidence>({
    reducer: (_left, right) => right,
    default: () => ({ commands: [], files: [], verification: [] }),
  }),
  /** 上下文预算配置 / Context budget configuration */
  contextBudget: Annotation<ContextBudget | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  /** Agent 进度账本 / Agent progress ledger */
  progress: Annotation<AgentProgressLedger>({
    reducer: (_left, right) => right,
    default: () => emptyProgressLedger(),
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

/** 检查当前是否为 plan 模式 / Check if current mode is plan mode */
export function isPlanMode(state: Pick<CodeAgentState, "mode">): boolean {
  return state.mode === "plan";
}
