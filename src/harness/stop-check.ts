import { HumanMessage } from "@langchain/core/messages";
import { emptyProgressLedger } from "./progress";
import type { CodeAgentState } from "./state";
import { uniqueTail } from "./utils";

/**
 * 收口守卫：判断模型生成的 final 答案是否真正准备好离开图 / Guardrail that decides whether a model-produced `final` answer is ready.
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

/** 停止检查未通过时，重置 final 并注入继续指令 / Clear final and inject continue instruction */
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
