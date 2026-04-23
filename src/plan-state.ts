import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentPlan } from "./types";

export const SWITCH_TO_BUILDER_MESSAGE =
  "Plan confirmed. Switch to builder mode and complete the original user request using tools as needed.";

export function derivePlanFromMessages(messages: BaseMessage[]): AgentPlan | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (
      message instanceof HumanMessage &&
      typeof message.content === "string" &&
      message.content === SWITCH_TO_BUILDER_MESSAGE
    ) {
      return null;
    }

    if (!(message instanceof ToolMessage) || typeof message.content !== "string") {
      continue;
    }

    const parsed = tryParseJson(message.content) as { plan?: unknown } | null;
    const plan = parsed?.plan;
    if (isAgentPlan(plan)) {
      return plan;
    }
  }

  return null;
}

export function deriveModeFromMessages(messages: BaseMessage[]): "plan" | "builder" {
  return derivePlanFromMessages(messages) ? "plan" : "builder";
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAgentPlan(value: unknown): value is AgentPlan {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as { explanation?: unknown; items?: unknown };
  if (!Array.isArray(record.items)) {
    return false;
  }

  return record.items.every((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const step = (item as { step?: unknown }).step;
    const status = (item as { status?: unknown }).status;
    return (
      typeof step === "string" &&
      (status === "pending" || status === "in_progress" || status === "completed")
    );
  });
}
