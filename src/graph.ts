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

const CONTINUE_IN_BUILDER_MESSAGE =
  "Plan approved. Continue in builder mode and complete the original user request using tools as needed.";
const DOOM_LOOP_REPEAT_LIMIT = 3;
const WATCHDOG_STAGNANT_LIMIT = 5;

const AgentState = Annotation.Root({
  userId: Annotation<string>,
  workspace: Annotation<string>,
  mode: Annotation<AgentMode>({
    reducer: (_left, right) => right,
    default: () => "builder",
  }),
  plan: Annotation<AgentPlan | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  contextSummary: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  evidence: Annotation<AgentEvidence>({
    reducer: (_left, right) => right,
    default: () => ({ commands: [], files: [], verification: [] }),
  }),
  contextBudget: Annotation<ContextBudget | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  progress: Annotation<AgentProgressLedger>({
    reducer: (_left, right) => right,
    default: () => emptyProgressLedger(),
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  final: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

export type CodeAgentState = typeof AgentState.State;

export interface BuildCodeAgentGraphInput {
  config: AgentConfig;
  checkpointPath: string;
  shellExecutor?: ShellExecutor;
}

export function buildCodeAgentGraph(input: BuildCodeAgentGraphInput) {
  const model = createDeepSeekModel(input.config);
  const checkpointer = new BunSqliteSaver(input.checkpointPath);

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
      const toolCallMessage = messageWithSingleToolCall(response, request.id);
      return {
        mode: state.mode,
        contextSummary: prepared.contextSummary,
        messages: [toolCallMessage],
      };
    }

    return {
      mode: state.mode,
      contextSummary: prepared.contextSummary,
      final: messageText(response),
      messages: [response],
    };
  };

  const approval = async (state: CodeAgentState) => {
    const request = getPendingToolRequest(state.messages, state.workspace);

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
    const evidence = updateEvidence(state.evidence, request, result);
    const nextPlan = "plan" in result ? result.plan : state.plan;
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
    const toolResult = addWatchdogResult(result, progress);

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

  const stopCheck = async (state: CodeAgentState) => evaluateStopCheck(state);

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

export function routeAfterApproval(state: CodeAgentState): "tools" | "agent" | typeof END {
  return getPendingToolRequest(state.messages, state.workspace) ? "tools" : "agent";
}

export function routeAfterTools(state: CodeAgentState): "stop_check" | "agent" {
  return state.final ? "stop_check" : "agent";
}

export function routeAfterStopCheck(
  state: CodeAgentState,
): "approval" | "agent" | typeof END {
  if (!state.final) {
    return "agent";
  }
  return state.mode === "plan" ? "approval" : END;
}

export async function runApprovedTool(
  workspace: string,
  request: PendingToolRequest,
  shellExecutor?: ShellExecutor,
  mode: AgentMode = "builder",
  existingPlan: AgentPlan | null = null,
  progress?: AgentProgressLedger,
) {
  const repeatedToolBlock = repeatedToolBlockResult(request, progress);
  if (repeatedToolBlock) {
    return repeatedToolBlock;
  }

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

  if (request.name === "shell_read") {
    if (!isPlanReadOnlyShellCommand(request.args.command)) {
      return {
        ok: false,
        command: request.args.command,
        exitCode: -1,
        stdout: "",
        stderr: "Rejected: plan mode allows read-only shell commands only.",
      };
    }
    return (shellExecutor ?? shellTool)({
      workspace,
      command: request.args.command,
    });
  }

  if (mode === "plan") {
    return {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: "",
      stderr: "Rejected: Plan mode allows read-only shell commands only.",
    };
  }

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

export function isPlanMode(state: Pick<CodeAgentState, "mode">): boolean {
  return state.mode === "plan";
}

export interface RecordToolProgressInput {
  previous?: AgentProgressLedger;
  requestName: PendingToolRequest["name"];
  requestArgs: PendingToolRequest["args"];
  result: ToolExecutionResult;
  previousEvidence?: AgentEvidence;
  nextEvidence: AgentEvidence;
  previousPlan: AgentPlan | null;
  nextPlan: AgentPlan | null;
}

export function recordToolProgress(input: RecordToolProgressInput): AgentProgressLedger {
  const previous = input.previous ?? emptyProgressLedger();
  const toolSignature = buildToolSignature(input.requestName, input.requestArgs);
  const outputSignature = buildOutputSignature(input.result);
  const repeatedCallCount =
    previous.lastToolSignature === toolSignature ? previous.repeatedCallCount + 1 : 1;
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

  if (state.mode === "plan" && !state.plan && !reportsBlocker) {
    return continueFromStopCheck(
      state,
      "Plan mode final is premature: create or update graph.state.plan with update_plan, or clearly report the blocker that prevents planning.",
    );
  }

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

export type PendingToolRequest =
  | {
      id?: string;
      name: "apply_patch";
      args: {
        path: string;
        content: string;
      };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: "shell_execute" | "shell_read";
      args: {
        command: string;
      };
      reason: string;
      protectedCommand: string;
    }
  | {
      id?: string;
      name: "update_plan";
      args: AgentPlan;
      reason: string;
      protectedCommand: string;
    };

type ToolExecutionResult = Awaited<ReturnType<typeof runApprovedTool>>;

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

function normalizePlanStatus(status: unknown): PlanStatus {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

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

function assertPreviewPath(workspace: string, path: string): string {
  return `${workspace.replace(/[\\/]+$/, "")}\\${path}`;
}

function messageText(message: AIMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

function planConfirmationSummary(plan: AgentPlan): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.step}`).join("\n");
  return [`Plan ready: ${plan.name}`, plan.description, steps].filter(Boolean).join("\n");
}

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

function commandForRequest(request: PendingToolRequest): string {
  if ("command" in request.args) {
    return request.args.command;
  }
  if (request.name === "update_plan") {
    return "update_plan";
  }
  return request.protectedCommand;
}

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

function mentionsBlocker(value: string): boolean {
  return /\b(blocker|blocked|unable|cannot|can't)\b|阻塞|无法|不能/i.test(value);
}

function mentionsVerificationGap(value: string): boolean {
  return (
    /\b(not verified|unverified|verification cannot|could not verify|cannot verify|unable to verify)\b/i.test(
      value,
    ) || /未验证|无法验证|不能验证/.test(value)
  );
}

function mentionsFailure(value: string): boolean {
  return /\b(fail|failed|failing|failure)\b|失败|未通过/i.test(value);
}

function buildToolSignature(
  requestName: PendingToolRequest["name"],
  requestArgs: PendingToolRequest["args"],
): string {
  return `${requestName}:${stableStringify(requestArgs)}`;
}

function buildOutputSignature(result: ToolExecutionResult): string {
  const record = { ...(result as Record<string, unknown>) };
  delete record.command;
  return stableStringify(record);
}

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

function newItems(previous: string[], next: string[]): string[] {
  const previousSet = new Set(previous);
  return next.filter((item) => item && !previousSet.has(item));
}

function uniqueTail(values: string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(-max);
}

export { Command };
