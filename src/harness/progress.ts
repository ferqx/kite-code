import type {
  AgentEvidence,
  AgentPlan,
  AgentProgressLedger,
} from "../shared/types";
import { WATCHDOG_STAGNANT_LIMIT } from "./constants";
import type { PendingToolRequest } from "./tool-requests";
import type { ToolExecutionResult } from "./tool-result";
import { newItems, stableStringify, uniqueTail } from "./utils";

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

/** 创建空的 Agent 进度账本 / Create empty Agent progress ledger */
export function emptyProgressLedger(): AgentProgressLedger {
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

/** 记录工具调用进度（死循环和看门狗检测） / Record tool call progress */
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

/** 构建工具调用签名，用于重复检测 / Build tool call signature for repeat detection */
export function buildToolSignature(
  requestName: PendingToolRequest["name"],
  requestArgs: PendingToolRequest["args"],
): string {
  return `${requestName}:${stableStringify(requestArgs)}`;
}

/** 检测是否有实际进展（新命令/新文件/新验证/新输出/计划变化） / Check progress signals */
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

/** 根据工具执行结果返回下一步建议 / Return next action suggestion based on tool result */
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

/** 构建工具输出签名，用于进度检测 / Build tool output signature for progress detection */
function buildOutputSignature(result: ToolExecutionResult): string {
  const record = { ...(result as unknown as Record<string, unknown>) };
  delete record.command;
  return stableStringify(record);
}
