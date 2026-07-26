/**
 * ToolSpec — 静态模型工具的单一事实源契约（ADR-0026）。
 * ToolSpec — single source of truth contract for static model tools (ADR-0026).
 *
 * 每个静态工具的模型表面、请求解析、副作用分类、执行器、结果投影与
 * descriptor 投影都从同一份 spec 派生，消除"一个工具定义在六处手工同步"
 * 造成的漂移。见 `docs/design/2026-07-26-tool-spec-registry-rfc.md`。
 */
import type { ZodType } from 'zod';
import type { FeatureFlags } from '@/core/config/features';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { ToolEffectClass } from '@/core/policies/tool-capabilities';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { PlanRuntimeContext } from '@/core/runtime/plan-facade';
import type { RuntimeState } from '@/core/runtime/state';
import type { SkillCatalogSnapshot } from '@/core/skills';
import type { SubAgentResult } from '@/core/subagent/types';
import type { ReadStateCheck } from '@/core/tools/read-state';
import type { ShellExecutor } from '@/core/tools/shell';
import type { ToolContractSection } from '@/core/tools/tool-contracts';
import type { ShellNetworkMode } from '@/core/types';
import type { CapabilityApproval, EffectProfile } from '@/protocol/capabilities';

/**
 * 工具分层（RFC §4.6）。
 * - computer：稳定的计算原语（read/edit/write/search/shell/web_fetch）
 * - coordination：Agent 协作（task/tool_search/skill 三件/mcp 资源三件）
 * - interrupt：用户交互协议（ask_user，harness 拦截，不进入 execute）
 * - runtime_action：Runtime 状态变更（plan 三件，语义不变仅接入）
 */
export type ToolKind = 'computer' | 'coordination' | 'interrupt' | 'runtime_action';

/** 可用性与静态投影所需上下文。迁移阶段按需扩展（phase、interactionMode、skill frame 等）。 */
export interface ToolContext {
  workspace: string;
  threadId?: string;
}

/** 执行上下文。迁移阶段按需扩展；Policy 预检暂留现有管线，阶段 1.2 上提为公共段。 */
export interface ToolExecutionContext extends ToolContext {
  toolCallId?: string;
  signal?: AbortSignal;
  shellExecutor?: ShellExecutor;
  shellNetworkMode?: ShellNetworkMode;
  onShellProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** MCP inventory/resource specs consume the already-governed Runtime provider. */
  mcpManager?: McpRuntimeProvider;
  /** Governed sub-agent adapter injected by the harness to avoid Registry→runner cycles. */
  runTask?: (input: {
    subagent_type: 'explore' | 'plan' | 'code' | 'review';
    task: string;
  }) => Promise<SubAgentResult>;
  /** Runtime search inputs captured at the current turn. */
  toolSearch?: {
    enabled: boolean;
    mcpManager?: McpRuntimeProvider;
    skillCatalog?: SkillCatalogSnapshot;
    turnId: string;
    toolCallId: string;
  };
  skillRuntime?: {
    state: RuntimeState;
    catalog?: SkillCatalogSnapshot;
    verificationEnabled: boolean;
    flags?: Readonly<FeatureFlags>;
    runFork?: (input: {
      agent: string;
      capabilityCeiling: string[];
      instructions: string;
      workflowInput: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
    }) => Promise<SubAgentResult | null>;
  };
  planRuntime?: PlanRuntimeContext;
  /** 调用方已持有执行授权且路径在工作区外（read_file 等外部路径门禁输入）。 */
  allowExternalPaths?: boolean;
  /** 写工具目标路径的读取状态检查结果（调用方注入，ADR-0025 §1 先读后改校验输入）。 */
  writeTarget?: { path: string; readState?: ReadStateCheck };
}

/**
 * 每次调用的动态副作用分类。消费现有 ToolEffectClass（与
 * classifyToolCapability 一致），必须是 (input, context) 的纯函数，
 * 不得信任模型自我声明的副作用字段（ADR-0026 §2）。
 */
export interface ToolEffects {
  effectClass: ToolEffectClass;
  sideEffect: boolean;
  classificationReason: string;
}

/** 展示提示 — 只允许纯字符串，App 层决定渲染（Core→App 边界不变量）。 */
export interface ToolDisplayHint {
  verb: string;
  preview?: string;
  detail?: string;
}

/** projectResult 的归一输出：模型可见内容 + 结果元数据 + 展示提示。 */
export interface ProjectedToolResult {
  ok: boolean;
  /** 模型可见内容（统一截断与失败引导后的文本）。 */
  modelContent: string;
  resultMeta: {
    /** 写工具必须声明受影响的工作区路径（一致性不变量 i5）。 */
    workspaceMutationScope?: string[];
    truncated?: boolean;
  };
  display: ToolDisplayHint;
  /**
   * Coordination/runtime-action specs may emit governed Core events alongside
   * the model result. The controller persists these events; specs never depend
   * on App/TUI types.
   */
  runtimeEvents?: RuntimeEvent[];
}

/** preExecute 钩子结果：放行，或 fail-fast 拒绝（ADR-0025 §1 先读后改/过期拒绝的落点）。 */
export type PreExecuteOutcome =
  | { proceed: true }
  | { proceed: false; rejection: { ok: false; error: string; guidance?: string } };

export interface ToolSpec<Input = unknown, Output = unknown> {
  /** 模型可见名；稳定 snake_case（ADR-0026 §4 决定不改名）。 */
  readonly name: string;
  readonly kind: ToolKind;
  /** 契约文本唯一来源；description 由 buildDescription(sections) 派生，不存在第二份手写描述。 */
  readonly contract: ToolContractSection;
  /**
   * 模型参数 Schema。execute 接收的对象恒等于该 Schema 的解析结果
   * （一致性不变量 i1），请求解析层不得逐字段重映射。
   */
  readonly inputSchema: ZodType<Input>;
  /** 静态声明效果 — CapabilityDescriptor 投影输入。 */
  readonly declaredEffects: EffectProfile;
  /** 静态最低审批 — CapabilityDescriptor 投影输入。 */
  readonly minimumApproval: CapabilityApproval;
  /** 可用性谓词；省略表示始终可用。替代 createAgentTools 的条件 spread。 */
  availability?(context: ToolContext): boolean;
  /** 每次调用的动态分类；shell 工具复用命令形态分析，不读取治理参数。 */
  effects(input: Input, context: ToolContext): ToolEffects;
  /** 审批展示命令（可选）。默认使用工具名，替代逐分支的 protectedCommand。 */
  approvalSummary?(input: Input, context: ToolContext): string;
  /** 执行前置钩子（fail-fast）：ADR-0025 §1/§4 与读取登记的统一落点。 */
  preExecute?(
    input: Input,
    context: ToolExecutionContext,
  ): PreExecuteOutcome | Promise<PreExecuteOutcome>;
  /** 唯一执行器。只有 Registry dispatch 可以调用它。 */
  execute(input: Input, context: ToolExecutionContext): Promise<Output>;
  /** 结果投影：模型内容 + resultMeta + display 提示。 */
  projectResult(output: Output, context: ToolExecutionContext): ProjectedToolResult;
}
