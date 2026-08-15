/**
 * ToolSpec — 静态模型工具的单一事实源契约（ADR-0043）。
 * ToolSpec — single source of truth contract for static model tools (ADR-0043).
 *
 * 每个静态工具的模型表面、请求解析、副作用分类、执行器、结果投影与
 * descriptor 投影都从同一份 spec 派生，消除"一个工具定义在六处手工同步"
 * 造成的漂移。见 `docs/design/2026-07-26-tool-spec-registry-rfc.md`。
 */
import type { z } from 'zod';
import type { FeatureFlags } from '@/core/config/features';
import type { McpRuntimeProvider } from '@/core/mcp';
import type {
  ProtectedPathAccessV1,
  ProtectedPathEvaluatorV1,
} from '@/core/policies/protected-path';
import type { ToolEffectClass } from '@/core/policies/tool-capabilities';
import type { PlanRuntimeContext } from '@/core/runtime/plan-facade';
import type { RuntimeState, ToolResultMeta } from '@/core/runtime/state';
import type { NetworkDecisionRecorderV1 } from '@/core/sandbox/network-enforcer';
import type { NetworkBoundaryPolicyV1 } from '@/core/sandbox/network-policy';
import type { SkillCatalogSnapshot } from '@/core/skills';
import type { SubAgentResult } from '@/core/subagent/types';
import type { ReadStateCheck } from '@/core/tools/read-state';
import type { ShellExecutor } from '@/core/tools/shell';
import type { ToolContractSource } from '@/core/tools/tool-contracts';
import type { ShellFilesystemMode, ShellNetworkMode } from '@/core/types';
import type { CapabilityApproval, EffectProfile } from '@/protocol/capabilities';

/**
 * 工具分层（RFC §4.6）。
 * - computer：稳定的计算原语（read/edit/write/search/shell/web_fetch）
 * - coordination：Agent 协作（task/tool_search/skill 三件/mcp 资源三件）
 * - interrupt：用户交互协议（ask_user，harness 拦截，不进入 execute）
 * - runtime_action：Runtime 状态变更（plan 三件，语义不变仅接入）
 */
export type ToolKind = 'computer' | 'coordination' | 'interrupt' | 'runtime_action';

/** 单次模型轮次的不可变工具可用性快照。模型投影与调用解析必须消费同一份快照。 */
export interface ToolAvailabilityContext {
  workspace: string;
  threadId?: string;
  phase?: import('@/protocol/events').AgentPhase;
  interactionMode?: import('@/protocol/events').InteractionMode;
  featureFlags?: Readonly<FeatureFlags>;
  brokeredGitFeatureRevision?:
    | typeof import('@/protocol/git').BROKERED_GIT_FEATURE_REVISION_V1
    | null;
  hasTaskAdapter?: boolean;
  hasGitBroker?: boolean;
  toolSearchEnabled?: boolean;
  activeSkillFrameIds?: readonly string[];
  availableSkillIds?: readonly string[];
}

export type ToolContext = ToolAvailabilityContext;

/** 执行上下文。迁移阶段按需扩展；Policy 预检暂留现有管线，阶段 1.2 上提为公共段。 */
export interface ToolExecutionContext extends ToolContext {
  toolCallId?: string;
  signal?: AbortSignal;
  shellExecutor?: ShellExecutor;
  shellNetworkMode?: ShellNetworkMode;
  shellFilesystemMode?: ShellFilesystemMode;
  /** Per-invocation network ceiling derived from the sealed execution boundary. */
  networkBoundaryPolicy?: NetworkBoundaryPolicyV1;
  /** Durable pre-dispatch sink. A governed socket cannot open until it resolves. */
  recordNetworkDecision?: NetworkDecisionRecorderV1;
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
  /** 写工具目标路径的读取状态检查结果（调用方注入，ADR-0042 §1 先读后改校验输入）。 */
  writeTarget?: {
    path: string;
    readState?: ReadStateCheck;
    previousContent?: string;
    existed?: boolean;
  };
  /** Registry dispatch 注入的已解析参数，仅供 projectResult 生成规范结果。 */
  invocationInput?: unknown;
  /** Runs after preExecute succeeds and immediately before the tool-owned execute call. */
  beforeExecute?: () => void | Promise<void>;
  /** Release-owned canonical protected-path evaluator for this run. */
  protectedPathEvaluator?: ProtectedPathEvaluatorV1;
  /** App-composed typed Git broker; raw process authority never enters ToolSpec args. */
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
}

/**
 * 每次调用的动态副作用分类。消费现有 ToolEffectClass（与
 * classifyToolCapability 一致），必须是 (input, context) 的纯函数，
 * 不得信任模型自我声明的副作用字段（ADR-0043 §2）。
 */
export interface ToolEffects {
  effectClass: ToolEffectClass;
  sideEffect: boolean;
  classificationReason: string;
}

/** projectResult 的归一输出：仅包含模型与 Runtime 结果归一所需的数据。 */
export interface ProjectedToolResult {
  ok: boolean;
  /** 模型可见内容（统一截断与失败引导后的文本）。 */
  modelContent: string;
  /**
   * 双输出流工具（shell_execute、search_*）的逐流投影：stdout/stderr 分别
   * 截断并在失败时两路保留。Runner 消费该字段重建双输出流；单流工具省略，
   * 此时 modelContent 是唯一模型通道。
   * Per-stream projection for dual-stream tools: stdout/stderr are truncated
   * independently and both survive failure. The runner consumes this field to
   * rebuild the two streams; single-stream tools omit it and modelContent is
   * the sole model channel.
   */
  streams?: { stdout: string; stderr: string };
  resultMeta: ToolResultMeta;
  /** Runtime-owned terminal cause; never inferred from model-visible text. */
  terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  /** Optional metadata-only tool-specific classification; Runtime authority may only tighten it. */
  outcomeAdviceV1?: import('@/core/runtime/tool-outcome').ToolOutcomeClassifierAdviceV1;
  classifierDiagnostic?: 'classifier_threw';
}

/** preExecute 钩子结果：放行，或 fail-fast 拒绝（ADR-0042 §1 先读后改/过期拒绝的落点）。 */
export type PreExecuteOutcome =
  | { proceed: true }
  | { proceed: false; rejection: { ok: false; error: string; guidance?: string } };

export interface BaseToolSpec<Name extends string = string, Input = unknown> {
  /** 模型可见名；稳定 snake_case（ADR-0043 §4 决定不改名）。 */
  readonly name: Name;
  readonly kind: ToolKind;
  /** 契约文本唯一来源；description 由 buildDescription(sections) 派生，不存在第二份手写描述。 */
  readonly contract: ToolContractSource;
  /**
   * 模型参数 Schema。execute 接收的对象恒等于该 Schema 的解析结果
   * （一致性不变量 i1），请求解析层不得逐字段重映射。
   */
  readonly inputSchema: z.ZodType<Input>;
  /** Optional phase-specific schema. Projection and parsing resolve this same schema. */
  modelInputSchema?(context: ToolContext): z.ZodType<Input>;
  /** 静态声明效果 — CapabilityDescriptor 投影输入。 */
  readonly declaredEffects: EffectProfile;
  /** 静态最低审批 — CapabilityDescriptor 投影输入。 */
  readonly minimumApproval: CapabilityApproval;
  /** 可用性谓词；省略表示始终可用。替代 createAgentTools 的条件 spread。 */
  availability?(context: ToolContext): boolean;
  /** 每次调用的动态分类；shell 工具复用命令形态分析，不读取治理参数。 */
  effects(input: Input, context: ToolContext): ToolEffects;
  /** Structured filesystem accesses evaluated before any tool pre-read or execution. */
  protectedPathAccesses?(input: Input, context: ToolContext): readonly ProtectedPathAccessV1[];
  /** 审批展示命令（可选）。默认使用工具名，替代逐分支的 protectedCommand。 */
  approvalSummary?(input: Input, context: ToolContext): string;
  /** 治理版本标签（可选），effects/分类逻辑变化时递增，纳入 descriptor revision 以保证缓存失效。 */
  readonly governanceRevision?: string;
  /** 执行前置钩子（fail-fast）：ADR-0042 §1/§4 与读取登记的统一落点。 */
  preExecute?(
    input: Input,
    context: ToolExecutionContext,
  ): PreExecuteOutcome | Promise<PreExecuteOutcome>;
}

export interface ExecutableToolSpec<Name extends string = string, Input = unknown, Output = unknown>
  extends BaseToolSpec<Name, Input> {
  readonly kind: Exclude<ToolKind, 'interrupt'>;
  /** 唯一执行器。只有 Registry dispatch 可以调用它。 */
  execute(input: Input, context: ToolExecutionContext): Promise<Output>;
  /**
   * 结果投影：模型内容与 Runtime 结果元数据。
   * 上下文携带 `invocationInput`——由 Registry dispatch 注入、恒等于
   * inputSchema 解析结果（一致性不变量 i1）；实现直接消费该类型化字段，
   * 不得再做强转或逐字段重映射。
   */
  projectResult(
    output: Output,
    context: ToolExecutionContext & { invocationInput: Input },
  ): ProjectedToolResult;
  /** Optional tool-owned classifier. It must not copy output content into its return value. */
  classifyOutcomeV1?(
    output: Output,
    context: ToolExecutionContext & { invocationInput: Input },
  ): import('@/core/runtime/tool-outcome').ToolOutcomeClassifierAdviceV1;
}

export interface InterruptToolSpec<Name extends string = string, Input = unknown, Interrupt = Input>
  extends BaseToolSpec<Name, Input> {
  readonly kind: 'interrupt';
  /** 构造中断协议；interrupt 不存在 execute/projectResult。 */
  createInterrupt(input: Input, context: ToolContext): Interrupt;
}

export type ToolSpec<Name extends string = string, Input = unknown, Output = never> = [
  Output,
] extends [never]
  ? InterruptToolSpec<Name, Input>
  : ExecutableToolSpec<Name, Input, Output>;

/** const tuple 类型推导用 — 保持 literal name 类型，同时加持 const Input/Output 推导。 */
export function defineExecutableTool<const Name extends string, const Input, const Output>(
  spec: ExecutableToolSpec<Name, Input, Output>,
): ExecutableToolSpec<Name, Input, Output> {
  return spec;
}

/** const tuple 类型推导用 — Interrupt 变体。 */
export function defineInterruptTool<const Name extends string, const Input, const Interrupt>(
  spec: InterruptToolSpec<Name, Input, Interrupt>,
): InterruptToolSpec<Name, Input, Interrupt> {
  return spec;
}
