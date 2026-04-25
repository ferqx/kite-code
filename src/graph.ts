import { isAbsolute, relative } from "node:path";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  messagesStateReducer,
} from "@langchain/langgraph";
import type { AgentConfig } from "./config";
import { prepareModelContext } from "./context";
import { BunSqliteSaver } from "./checkpoint";
import { createDeepSeekModel } from "./model";
import {
  createCodeAgentTools,
  createPlanAgentTools,
  isPlanReadOnlyShellCommand,
} from "./tool-definitions";
import {
  applyPatchTool,
  buildApplyPatchCommand,
  shellTool,
  type ShellExecutor,
} from "./tools";
import type { AgentMode, AgentPlan, PlanStatus } from "./types";
import type {
  AgentEvidence,
  AgentProgressLedger,
  ContextBudget,
  ShellResult,
} from "./types";

/** 计划批准后切换到 builder 模式的消息 / Message when switching to builder mode after plan approval */
const CONTINUE_IN_BUILDER_MESSAGE =
  "Plan approved. Continue in builder mode and complete the original user request using tools as needed.";
/** 死循环重复限制 / Doom loop repeat limit (3 identical calls in a row triggers blocking) */
const DOOM_LOOP_REPEAT_LIMIT = 3;
/** 看门狗停滞步数限制 / Watchdog stagnant step limit (5 steps without progress triggers alert) */
const WATCHDOG_STAGNANT_LIMIT = 5;

const AgentState = Annotation.Root({
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

/** 构建代码 Agent 图的输入 / Build code agent graph input */
export interface BuildCodeAgentGraphInput {
  /** Agent 配置 / Agent configuration */
  config: AgentConfig;
  /** Checkpoint 数据库路径 / Checkpoint database path */
  checkpointPath: string;
  /** 可选的自定义 Shell 执行器 / Optional custom shell executor */
  shellExecutor?: ShellExecutor;
}

/** 构建 LangGraph 状态图 / Build LangGraph state graph */
export function buildCodeAgentGraph(input: BuildCodeAgentGraphInput) {
  const model = createDeepSeekModel(input.config);
  const checkpointer = new BunSqliteSaver(input.checkpointPath);

  /** Agent 节点：调用模型生成下一步动作 / Agent node: invoke model to generate next action */
  const agent = async (state: CodeAgentState) => {
    const tools =
      state.mode === "plan"
        ? createPlanAgentTools({
            workspace: state.workspace,
            shellExecutor: input.shellExecutor,
          })
        : createCodeAgentTools({
            workspace: state.workspace,
            shellExecutor: input.shellExecutor,
          });

    const prepared = prepareModelContext("agent", {
      ...state,
      modelName: input.config.modelName,
    });

    const response = await model
      .bindTools(tools, { tool_choice: "auto" })
      .invoke(prepared.messages);

    const request = toolRequestFromMessage(response, state.workspace);
    if (request) {
      // 模型请求了工具调用，只保留被选中的那一个 / Model requested a tool call, keep only the selected one
      const toolCallMessage = messageWithSingleToolCall(response, request.id);
      return {
        mode: state.mode,
        contextSummary: prepared.contextSummary,
        messages: [toolCallMessage],
      };
    }

    // 模型没有请求工具调用，视为最终回答 / Model did not request a tool call, treat as final answer
    return {
      mode: state.mode,
      contextSummary: prepared.contextSummary,
      final: messageText(response),
      messages: [response],
    };
  };

  /** 审批节点：中断等待人工批准 / Approval node: interrupt for human approval */
  const approval = async (state: CodeAgentState) => {
    const request = getPendingToolRequest(state.messages, state.workspace);

    // plan 模式有最终回答但无工具请求 -> 模式确认 / Plan mode has final answer but no tool request -> mode confirmation
    if (state.mode === "plan" && state.final && !request) {
      const resume = interrupt({
        kind: "mode_confirmation",
        targetMode: "builder",
        plan: state.plan,
        summary: state.final,
      }) as boolean | { approved?: boolean; reason?: string };
      const approved =
        resume === true ||
        (typeof resume === "object" && resume !== null && resume.approved === true);

      return approved
        ? {
            final: "",
            mode: "builder" as AgentMode,
            messages: [new HumanMessage(CONTINUE_IN_BUILDER_MESSAGE)],
          }
        : {};
    }

    if (!request) {
      return {};
    }

    // 有工具请求 -> 工具审批 / Has tool request -> tool approval
    const approved = interrupt({
      kind: "tool_approval",
      request,
    }) as boolean | { approved?: boolean; reason?: string };
    const allowed =
      approved === true ||
      (typeof approved === "object" && approved !== null && approved.approved === true);

    if (!allowed) {
      return {
        messages: [
          new ToolMessage({
            content: JSON.stringify({
              ok: false,
              rejected: true,
              reason:
                typeof approved === "object" && approved !== null
                  ? approved.reason ?? "not approved"
                  : "not approved",
            }),
            tool_call_id: request.id ?? "missing-tool-call-id",
            status: "error",
          }),
        ],
      };
    }

    return {};
  };

  /** 工具节点：执行已批准的工具调用 / Tools node: execute approved tool call */
  const tools = async (state: CodeAgentState) => {
    const request = getPendingToolRequest(state.messages, state.workspace);
    if (!request) {
      return {};
    }

    const result = await runApprovedTool(
      state.workspace,
      request,
      input.shellExecutor,
      state.mode,
      state.plan,
      state.progress,
    );
    // 更新执行证据 / Update execution evidence
    const evidence = updateEvidence(state.evidence, request, result);
    const nextPlan = "plan" in result ? result.plan : state.plan;
    // 记录工具进度（死循环和看门狗检测） / Record tool progress (doom-loop and watchdog detection)
    const progress = recordToolProgress({
      previous: state.progress,
      requestName: request.name,
      requestArgs: request.args,
      result,
      previousEvidence: state.evidence,
      nextEvidence: evidence,
      previousPlan: state.plan,
      nextPlan,
    });
    // 加入看门狗信号 / Add watchdog signal to result
    const toolResult = addWatchdogResult(result, progress);

    // update_plan 返回：更新计划并可能切换模式 / update_plan result: update plan and possibly switch mode
    if ("plan" in result) {
      const nextMode = "mode" in result ? result.mode : state.mode;
      const final =
        nextMode === "plan" ? planConfirmationSummary(result.plan) : state.final;
      return {
        plan: result.plan,
        ...("mode" in result ? { mode: result.mode } : {}),
        ...(final ? { final } : {}),
        evidence,
        progress,
        messages: [
          new ToolMessage({
            content: JSON.stringify(toolResult),
            tool_call_id: request.id ?? "missing-tool-call-id",
            status: result.ok === false ? "error" : "success",
          }),
        ],
      };
    }

    return {
      evidence,
      progress,
      messages: [
        new ToolMessage({
          content: JSON.stringify(toolResult),
          tool_call_id: request.id ?? "missing-tool-call-id",
          status: result.ok === false ? "error" : "success",
        }),
      ],
    };
  };

  /** 停止检查节点：收口守卫，验证最终回答是否真正可以结束 / Stop check node: guardrail that verifies final answer is ready */
  const stopCheck = async (state: CodeAgentState) => evaluateStopCheck(state);

  // 图拓扑 / Graph topology:
  // START -> agent <-> approval <-> tools -> stop_check -> (agent | approval | END)
  const graph = new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("tools", tools)
    .addNode("stop_check", stopCheck)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent)
    .addConditionalEdges("approval", routeAfterApproval)
    .addConditionalEdges("tools", routeAfterTools)
    .addConditionalEdges("stop_check", routeAfterStopCheck)
    .compile({ checkpointer });

  return { graph, checkpointer };
}

/** agent 节点后的路由逻辑 / Routing after agent node:
 *  - 无工具请求 + 有 final -> stop_check / No tool request + has final -> stop_check
 *  - 无工具请求 + 无 final -> END / No tool request + no final -> END
 *  - plan 模式或 update_plan -> 直接 tools（跳过审批） / Plan mode or update_plan -> tools directly (skip approval)
 *  - 否则 -> approval / Otherwise -> approval
 */
export function routeAfterAgent(
  state: CodeAgentState,
): "stop_check" | "approval" | "tools" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return state.final ? "stop_check" : END;
  }
  return state.mode === "plan" || request.name === "update_plan"
    ? "tools"
    : "approval";
}

/** approval 节点后的路由逻辑 / Routing after approval node:
 *  - 仍有待处理工具请求 -> tools / Still has pending tool request -> tools
 *  - 否则 -> agent / Otherwise -> agent
 */
export function routeAfterApproval(state: CodeAgentState): "tools" | "agent" | typeof END {
  return getPendingToolRequest(state.messages, state.workspace) ? "tools" : "agent";
}

/** tools 节点后的路由逻辑 / Routing after tools node:
 *  - 有 final -> stop_check / Has final -> stop_check
 *  - 否则 -> agent / Otherwise -> agent
 */
export function routeAfterTools(state: CodeAgentState): "stop_check" | "agent" {
  return state.final ? "stop_check" : "agent";
}

/** stop_check 节点后的路由逻辑 / Routing after stop check node:
 *  - 无 final -> agent（继续工作） / No final -> agent (continue working)
 *  - plan 模式 -> approval（确认切换模式） / Plan mode -> approval (confirm mode switch)
 *  - 否则 -> END / Otherwise -> END
 */
export function routeAfterStopCheck(
  state: CodeAgentState,
): "approval" | "agent" | typeof END {
  if (!state.final) {
    return "agent";
  }
  return state.mode === "plan" ? "approval" : END;
}

/** 执行经过审批的工具调用 / Execute an approved tool call
 *  - update_plan：直接修改状态 plan，builder 模式下可能切换到 plan / Directly update state.plan, may switch to plan mode in builder
 *  - shell_read：plan 模式下仅允许只读命令 / In plan mode only read-only shell commands are allowed
 *  - plan 模式且非 shell_read/update_plan：拒绝 / Plan mode with non-read-only tool: rejected
 *  - apply_patch：校验参数后执行补丁 / Validate params then apply patch
 *  - 死循环检测：连续 3 次相同工具调用会被拦截 / Doom-loop detection: 3 consecutive identical calls are blocked
 */
export async function runApprovedTool(
  workspace: string,
  request: PendingToolRequest,
  shellExecutor?: ShellExecutor,
  mode: AgentMode = "builder",
  existingPlan: AgentPlan | null = null,
  progress?: AgentProgressLedger,
) {
  // 死循环拦截 / Doom-loop check: block repeated identical tool calls
  const repeatedToolBlock = repeatedToolBlockResult(request, progress);
  if (repeatedToolBlock) {
    return repeatedToolBlock;
  }

  // update_plan 工具：直接更新状态计划 / update_plan tool: directly update state plan
  if (request.name === "update_plan") {
    return {
      ok: true,
      command: "update_plan",
      exitCode: 0,
      stdout: "",
      stderr: "",
      plan: request.args,
      ...(mode === "builder" && !existingPlan ? { mode: "plan" as AgentMode } : {}),
    };
  }

  // shell_read 工具：只读 shell 命令 / shell_read tool: read-only shell commands
  if (request.name === "shell_read") {
    // plan 模式下仅允许只读命令 / In plan mode, only read-only commands pass
    if (!isPlanReadOnlyShellCommand(request.args.command)) {
      return {
        ok: false,
        command: request.args.command,
        exitCode: -1,
        stdout: "",
        stderr: "Rejected: plan mode allows read-only shell commands only.",
      };
    }
  // shell_execute 默认路径 / Fallback: shell_execute
  return (shellExecutor ?? shellTool)({
      workspace,
      command: request.args.command,
    });
  }

  // plan 模式下拒绝非只读写入操作 / In plan mode, reject non-read-only write operations
  if (mode === "plan") {
    return {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: "",
      stderr: "Rejected: Plan mode allows read-only shell commands only.",
    };
  }

  // apply_patch 工具：校验路径和内容参数后执行 / apply_patch tool: validate path and content then execute
  if (request.name === "apply_patch") {
    if (!request.args.path || !request.args.content) {
      return {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: "",
        stderr: "apply_patch requires explicit path and content arguments from the model.",
      };
    }
    return applyPatchTool({
      workspace,
      path: request.args.path,
      content: request.args.content,
      shellExecutor,
    });
  }

  return (shellExecutor ?? shellTool)({
    workspace,
    command: request.args.command,
  });
}

/** 检查当前是否为 plan 模式 / Check if current mode is plan mode */
export function isPlanMode(state: Pick<CodeAgentState, "mode">): boolean {
  return state.mode === "plan";
}

/** 记录工具进度的输入 / Input for recording tool progress */
export interface RecordToolProgressInput {
  /** 之前的进度账本 / Previous progress ledger */
  previous?: AgentProgressLedger;
  /** 工具名称 / Tool name */
  requestName: PendingToolRequest["name"];
  /** 工具参数 / Tool arguments */
  requestArgs: PendingToolRequest["args"];
  /** 工具执行结果 / Tool execution result */
  result: ToolExecutionResult;
  /** 之前的执行证据 / Previous execution evidence */
  previousEvidence?: AgentEvidence;
  /** 更新后的执行证据 / Updated execution evidence */
  nextEvidence: AgentEvidence;
  /** 之前的计划 / Previous plan */
  previousPlan: AgentPlan | null;
  /** 更新后的计划 / Updated plan */
  nextPlan: AgentPlan | null;
}

/** 记录工具调用进度（死循环和看门狗检测） / Record tool call progress (doom-loop and watchdog detection) */
export function recordToolProgress(input: RecordToolProgressInput): AgentProgressLedger {
  const previous = input.previous ?? emptyProgressLedger();
  // 为工具调用和输出构建签名 / Build signatures for tool call and output
  const toolSignature = buildToolSignature(input.requestName, input.requestArgs);
  const outputSignature = buildOutputSignature(input.result);
  // 检测连续相同调用（死循环） / Detect consecutive identical calls (doom-loop)
  const repeatedCallCount =
    previous.lastToolSignature === toolSignature ? previous.repeatedCallCount + 1 : 1;
  // 检测是否有实际进展（新文件/新命令/新验证/输出变化/计划变化） / Check for actual progress (new files/commands/verification/output/plan changes)
  const madeProgress = hasProgressSignal(input, outputSignature);
  const stagnantStepCount = madeProgress ? 0 : previous.stagnantStepCount + 1;
  const watchdogTriggered = stagnantStepCount >= WATCHDOG_STAGNANT_LIMIT;

  return {
    toolCallCount: previous.toolCallCount + 1,
    stagnantStepCount,
    repeatedCallCount,
    lastToolSignature: toolSignature,
    recentOutputSignatures: uniqueTail(
      [...previous.recentOutputSignatures, outputSignature],
      10,
    ),
    heartbeat: {
      goal: input.nextPlan?.name ?? previous.heartbeat.goal,
      findings: uniqueTail(
        [
          ...previous.heartbeat.findings,
          ...newItems(input.previousEvidence?.files ?? [], input.nextEvidence.files).map(
            (file) => `Changed file: ${file}`,
          ),
        ],
        10,
      ),
      nextAction: watchdogTriggered
        ? "No progress detected; change strategy, inspect a different signal, update the plan, or explain the blocker."
        : nextActionForResult(input.result),
      blockers: watchdogTriggered
        ? uniqueTail(
            [
              ...previous.heartbeat.blockers,
              `No progress detected after ${stagnantStepCount} consecutive tool step(s).`,
            ],
            10,
          )
        : previous.heartbeat.blockers,
      verification: input.nextEvidence.verification,
    },
  };
}

/**
 * 收口守卫：判断模型生成的 final 答案是否真正准备好离开图 / Guardrail that decides whether a model-produced `final` answer is actually ready to leave the graph.
 *
 * Agent 可能过早发出 state.final：例如在创建 plan 之前、在完成所有计划步骤之前、
 * 或在修改文件但没有验证证据之后。在这些情况下，我们清空 final 并注入一条 HumanMessage，
 * 使图路由回 agent 节点继续工作。
 * The agent can emit `state.final` too early: for example before creating a plan,
 * before finishing every planned step, or after changing files without any
 * verification evidence. In those cases we clear `final` and inject a human
 * message so the graph routes back to `agent` and the model continues working.
 *
 * 返回 {} 表示最终答案可接受，路由可以继续。 / Returning `{}` means the final answer is acceptable and routing may continue.
 */
export function evaluateStopCheck(
  state: CodeAgentState,
): Partial<Pick<CodeAgentState, "final" | "messages" | "progress">> {
  if (!state.final) {
    return {};
  }

  const finalText = state.final;
  const reportsBlocker = mentionsBlocker(finalText);
  const reportsVerificationGap = mentionsVerificationGap(finalText);
  const reportsFailure = mentionsFailure(finalText);

  // Plan 模式：纯自然语言声称"完成"是不够的。Agent 必须通过 update_plan 持久化真实计划，或明确声明计划被阻塞。
  // In plan mode, a plain natural-language "done" is not enough. The agent must
  // either persist a real plan via `update_plan` or explicitly say planning is blocked.
  if (state.mode === "plan" && !state.plan && !reportsBlocker) {
    return continueFromStopCheck(
      state,
      "Plan mode final is premature: create or update graph.state.plan with update_plan, or clearly report the blocker that prevents planning.",
    );
  }

  // Builder 模式：有未完成的计划步骤时，不应过早结束，除非最终答案明确报告了阻塞。
  // In builder mode, an unfinished plan means the implementation is still in
  // progress unless the final answer clearly reports a blocker.
  if (
    state.mode === "builder" &&
    state.plan?.steps.some((step) => step.status !== "completed") &&
    !reportsBlocker
  ) {
    return continueFromStopCheck(
      state,
      "Builder final is premature: complete or update the remaining plan steps, or clearly report the blocker.",
    );
  }

  // 文件已修改但无验证证据，且 Agent 未明确声明验证无法运行。
  // If the agent modified files, it must also record verification evidence or
  // explicitly admit verification did not run / could not run.
  if (
    state.mode === "builder" &&
    (state.evidence?.files.length ?? 0) > 0 &&
    (state.evidence?.verification.length ?? 0) === 0 &&
    !reportsVerificationGap &&
    !reportsBlocker
  ) {
    return continueFromStopCheck(
      state,
      "Files changed but no verification evidence is recorded. Run useful verification, or explicitly explain why verification cannot run.",
    );
  }

  // 验证证据中包含失败记录，最终答案必须提及该失败，不能静默声称完成。
  // If verification already recorded a failure, the final answer must surface
  // that failure instead of silently claiming completion.
  if (
    state.mode === "builder" &&
    (state.evidence?.verification.some((item) => /failed/i.test(item)) ?? false) &&
    !reportsFailure &&
    !reportsBlocker
  ) {
    return continueFromStopCheck(
      state,
      "Verification evidence includes a failure. Fix it or clearly report the failing verification in the final answer.",
    );
  }

  return {};
}

/** 待处理的工具请求（可辨识联合类型） / Pending tool request (discriminated union) */
export type PendingToolRequest =
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "apply_patch";
      args: {
        /** 目标文件路径 / Target file path */
        path: string;
        /** 补丁内容 / Patch content */
        content: string;
      };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "shell_execute" | "shell_read";
      args: {
        /** shell 命令 / Shell command */
        command: string;
      };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    }
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "update_plan";
      /** 计划数据 / Plan data */
      args: AgentPlan;
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    };

/** 工具执行结果类型 / Tool execution result type */
type ToolExecutionResult = Awaited<ReturnType<typeof runApprovedTool>>;

/** 从消息列表中获取待处理的工具请求 / Get pending tool request from message list */
function getPendingToolRequest(
  messages: BaseMessage[],
  workspace: string,
): PendingToolRequest | null {
  const lastMessage = messages.at(-1);
  if (!(lastMessage instanceof AIMessage)) {
    return null;
  }
  return toolRequestFromMessage(lastMessage, workspace);
}

/** 解析 AIMessage 中的工具调用请求 / Parse tool call request from an AIMessage */
function toolRequestFromMessage(
  message: AIMessage,
  workspace: string,
): PendingToolRequest | null {
  const call = message.tool_calls?.[0];
  if (!call) {
    return null;
  }

  if (call.name === "apply_patch") {
    const args = call.args as { path?: string; content?: string };
    const path = normalizePatchPath(workspace, args.path || "");
    const content = args.content || "";
    return {
      id: call.id,
      name: "apply_patch",
      args: { path, content },
      reason: "Model requested apply_patch tool call",
      protectedCommand: buildApplyPatchCommand(assertPreviewPath(workspace, path), content),
    };
  }

  if (call.name === "shell_execute") {
    const args = call.args as { command?: string };
    return {
      id: call.id,
      name: "shell_execute",
      args: { command: args.command || "pwd" },
      reason: "Model requested shell_execute tool call",
      protectedCommand: args.command || "pwd",
    };
  }

  if (call.name === "shell_read") {
    const args = call.args as { command?: string };
    return {
      id: call.id,
      name: "shell_read",
      args: { command: args.command || "pwd" },
      reason: "Model requested read-only shell command",
      protectedCommand: args.command || "pwd",
    };
  }

  if (call.name === "update_plan") {
    const args = call.args as Partial<AgentPlan>;
    return {
      id: call.id,
      name: "update_plan",
      args: normalizeAgentPlan(args),
      reason: "Model requested plan state update",
      protectedCommand: "update_plan",
    };
  }

  return null;
}

/** 规范化 Agent 计划结构，填充默认值 / Normalize Agent plan structure, filling in default values */
function normalizeAgentPlan(value: Partial<AgentPlan>): AgentPlan {
  const rawSteps: unknown[] = Array.isArray(value.steps) ? (value.steps as unknown[]) : [];
  return {
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    status: normalizePlanStatus(value.status),
    steps: rawSteps
      .filter((step): step is Record<string, unknown> => !!step && typeof step === "object")
      .map((step) => ({
        step: typeof step.step === "string" ? step.step : "",
        status: normalizePlanStatus(step.status),
      })),
  };
}

/** 规范化计划状态值 / Normalize plan status value */
function normalizePlanStatus(status: unknown): PlanStatus {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

/** 从 AIMessage 中提取并保留单个工具调用 / Extract and keep a single tool call from AIMessage */
function messageWithSingleToolCall(message: AIMessage, toolCallId?: string): AIMessage {
  const selectedCall =
    message.tool_calls?.find((call) => call.id === toolCallId) ?? message.tool_calls?.[0];
  if (!selectedCall) {
    return message;
  }

  const rawToolCalls = Array.isArray(message.additional_kwargs.tool_calls)
    ? message.additional_kwargs.tool_calls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "id" in call &&
          call.id === selectedCall.id,
      )
    : message.additional_kwargs.tool_calls;

  return new AIMessage({
    id: message.id,
    content: message.content,
    additional_kwargs: {
      ...message.additional_kwargs,
      tool_calls: rawToolCalls,
    },
    response_metadata: message.response_metadata,
    tool_calls: [selectedCall],
    usage_metadata: message.usage_metadata,
  });
}

/** 规范化补丁路径：绝对路径转为相对路径 / Normalize patch path: convert absolute path to relative */
function normalizePatchPath(workspace: string, requestedPath: string): string {
  if (!isAbsolute(requestedPath)) {
    return requestedPath;
  }

  const relativePath = relative(workspace, requestedPath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }

  return "";
}

/** 构建审批预览用的路径 / Build preview path for approval display */
function assertPreviewPath(workspace: string, path: string): string {
  return `${workspace.replace(/[\\/]+$/, "")}\\${path}`;
}

/** 提取 AIMessage 的文本内容 / Extract text content from AIMessage */
function messageText(message: AIMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

/** 生成计划确认摘要文本 / Generate plan confirmation summary text */
function planConfirmationSummary(plan: AgentPlan): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.step}`).join("\n");
  return [`Plan ready: ${plan.name}`, plan.description, steps].filter(Boolean).join("\n");
}

/** 更新执行证据记录 / Update execution evidence records */
function updateEvidence(
  current: AgentEvidence | undefined,
  request: PendingToolRequest,
  result: Awaited<ReturnType<typeof runApprovedTool>>,
): AgentEvidence {
  const next: AgentEvidence = {
    commands: [...(current?.commands ?? [])],
    files: [...(current?.files ?? [])],
    verification: [...(current?.verification ?? [])],
  };

  if ("command" in result && result.command) {
    next.commands.push(result.command);
    if (/\b(test|typecheck|lint|build)\b/i.test(result.command)) {
      next.verification.push(
        `${result.command}: ${result.ok ? "ok" : "failed"} (${result.exitCode})`,
      );
    }
  }

  if (request.name === "apply_patch" && "path" in result && result.ok) {
    next.files.push(result.path);
  }

  return {
    commands: uniqueTail(next.commands, 20),
    files: uniqueTail(next.files, 20),
    verification: uniqueTail(next.verification, 20),
  };
}

/** 创建空的 Agent 进度账本 / Create empty Agent progress ledger */
function emptyProgressLedger(): AgentProgressLedger {
  return {
    toolCallCount: 0,
    stagnantStepCount: 0,
    repeatedCallCount: 0,
    lastToolSignature: "",
    recentOutputSignatures: [],
    heartbeat: {
      goal: "",
      findings: [],
      nextAction: "",
      blockers: [],
      verification: [],
    },
  };
}

/** 检测死循环并返回拦截结果 / Detect doom-loop and return blocking result */
function repeatedToolBlockResult(
  request: PendingToolRequest,
  progress?: AgentProgressLedger,
): ShellResult | null {
  if (!progress) {
    return null;
  }

  const signature = buildToolSignature(request.name, request.args);
  const repeatedCallCount =
    progress.lastToolSignature === signature ? progress.repeatedCallCount + 1 : 1;
  if (repeatedCallCount < DOOM_LOOP_REPEAT_LIMIT) {
    return null;
  }

  return {
    ok: false,
    command: commandForRequest(request),
    exitCode: -1,
    stdout: "",
    stderr:
      "Repeated tool request blocked: same tool and input were requested 3 consecutive times. Change strategy before retrying.",
  };
}

/** 从工具请求中提取命令字符串 / Extract command string from tool request */
function commandForRequest(request: PendingToolRequest): string {
  if ("command" in request.args) {
    return request.args.command;
  }
  if (request.name === "update_plan") {
    return "update_plan";
  }
  return request.protectedCommand;
}

/** 检测是否有实际进展（新命令/新文件/新验证/新输出/计划变化） / Check for actual progress (new commands/files/verification/output/plan changes) */
function hasProgressSignal(
  input: RecordToolProgressInput,
  outputSignature: string,
): boolean {
  const previousEvidence = input.previousEvidence ?? {
    commands: [],
    files: [],
    verification: [],
  };
  return (
    newItems(previousEvidence.commands, input.nextEvidence.commands).length > 0 ||
    newItems(previousEvidence.files, input.nextEvidence.files).length > 0 ||
    newItems(previousEvidence.verification, input.nextEvidence.verification).length > 0 ||
    !input.previous?.recentOutputSignatures.includes(outputSignature) ||
    stableStringify(input.previousPlan) !== stableStringify(input.nextPlan)
  );
}

/** 根据工具执行结果返回下一步建议 / Return next action suggestion based on tool execution result */
function nextActionForResult(result: ToolExecutionResult): string {
  if (result.ok === false) {
    return "Inspect the failed tool result and choose a different next action.";
  }
  if ("plan" in result) {
    return "Use the updated plan state to continue or summarize the plan.";
  }
  if ("command" in result && /\b(test|typecheck|lint|build)\b/i.test(result.command)) {
    return "Use verification evidence to decide whether more work is needed.";
  }
  return "Continue with the next concrete step toward the user goal.";
}

/** 在看门狗触发时将警告信号注入工具结果 / Inject watchdog warning into tool result when triggered */
function addWatchdogResult<T extends ToolExecutionResult>(
  result: T,
  progress: AgentProgressLedger,
): T & { watchdog?: { kind: string; message: string; stagnantStepCount: number } } {
  if (progress.stagnantStepCount < WATCHDOG_STAGNANT_LIMIT) {
    return result;
  }

  return {
    ...result,
    watchdog: {
      kind: "no_progress",
      message:
        "No progress detected across the recent tool window. Change strategy, update the plan, inspect a different signal, or report a blocker.",
      stagnantStepCount: progress.stagnantStepCount,
    },
  };
}

/** 停止检查未通过时，重置 final 并注入继续指令 / When stop check fails, clear final and inject continue instruction */
function continueFromStopCheck(
  state: CodeAgentState,
  reason: string,
): Partial<Pick<CodeAgentState, "final" | "messages" | "progress">> {
  const progress = state.progress ?? emptyProgressLedger();
  return {
    final: "",
    progress: {
      ...progress,
      heartbeat: {
        ...progress.heartbeat,
        blockers: uniqueTail([...progress.heartbeat.blockers, reason], 10),
        nextAction: reason,
      },
    },
    messages: [new HumanMessage(`Stop check blocked final answer: ${reason}`)],
  };
}

/** 检测文字是否提到阻塞 / Check if text mentions a blocker */
function mentionsBlocker(value: string): boolean {
  return /\b(blocker|blocked|unable|cannot|can't)\b|阻塞|无法|不能/i.test(value);
}

/** 检测文字是否提到验证缺失 / Check if text mentions a verification gap */
function mentionsVerificationGap(value: string): boolean {
  return (
    /\b(not verified|unverified|verification cannot|could not verify|cannot verify|unable to verify)\b/i.test(
      value,
    ) || /未验证|无法验证|不能验证/.test(value)
  );
}

/** 检测文字是否提到失败 / Check if text mentions a failure */
function mentionsFailure(value: string): boolean {
  return /\b(fail|failed|failing|failure)\b|失败|未通过/i.test(value);
}

/** 构建工具调用签名，用于重复检测 / Build tool call signature for repeat detection */
function buildToolSignature(
  requestName: PendingToolRequest["name"],
  requestArgs: PendingToolRequest["args"],
): string {
  return `${requestName}:${stableStringify(requestArgs)}`;
}

/** 构建工具输出签名，用于进度检测 / Build tool output signature for progress detection */
function buildOutputSignature(result: ToolExecutionResult): string {
  const record = { ...(result as Record<string, unknown>) };
  delete record.command;
  return stableStringify(record);
}

/** 稳定序列化（key 排序）确保相同结构对象生成一致字符串 / Stable stringify (key-sorted) for consistent hashing of equivalent objects */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 提取 next 中不在 previous 中的新项目 / Extract new items in next that are not in previous */
function newItems(previous: string[], next: string[]): string[] {
  const previousSet = new Set(previous);
  return next.filter((item) => item && !previousSet.has(item));
}

/** 去重并截取末尾最多 max 个元素 / Deduplicate and keep at most last `max` elements */
function uniqueTail(values: string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(-max);
}

export { Command };
