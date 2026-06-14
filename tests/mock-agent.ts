/**
 * Mock Agent — pre-programmed chat model for E2E testing.
 *
 * Used by the TUI when OPENPX_MOCK=true is set in the environment. Responses
 * are configured via OPENPX_MOCK_RESPONSES (JSON array of strings, one per
 * expected model call).
 *
 * Not imported in production builds — only loaded dynamically when the
 * env var is set.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";

export type { SupportedChatModel } from "@/core/model/factory";

/** Create a mock model from OPENPX_MOCK_RESPONSES env var. */
export async function createMockModelFromEnv(): Promise<import("@/core/model/factory").SupportedChatModel> {
  const raw = process.env.OPENPX_MOCK_RESPONSES ?? "[]";
  const texts: string[] = JSON.parse(raw);

  // Re-create the array so shift() doesn't mutate the original
  const queue = [...texts];

  class SubprocessMockModel extends BaseChatModel {
    lc_namespace = ["test", "subprocess-mock"];
    _llmType() { return "subprocess-mock" as const; }
    async _generate(_messages: any, _options?: any, _runManager?: any): Promise<any> {
      const text = queue.shift() ?? "";
      return { generations: [[{ text, message: new AIMessage({ content: text }) }]] };
    }
  }

  return new SubprocessMockModel({}) as any;
}
