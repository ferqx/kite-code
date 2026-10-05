// @bun
// src/index.ts
import { appendFileSync } from "fs";
import {
  defineExtension
} from "@kite-ai/agent/extensions";
function countedTool(ledgerPath) {
  return defineExtension({
    id: "fixture.counted",
    version: "1.0.0",
    apiMajor: 1,
    tools: [
      {
        id: "fixture.count",
        version: "1.0.0",
        description: "Append one harmless invocation to the external test ledger.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" }, fail: { type: "boolean" } },
          required: ["value"],
          additionalProperties: false
        },
        async execute(input, context) {
          context.signal.throwIfAborted();
          appendFileSync(ledgerPath, JSON.stringify({
            sessionId: context.sessionId,
            runId: context.runId,
            executionId: context.executionId,
            input
          }) + `
`, { mode: 384 });
          const argumentsObject = input;
          if (argumentsObject.fail)
            return {
              outcome: "failed",
              content: "Known fixture failure",
              details: { value: argumentsObject.value }
            };
          return {
            outcome: "succeeded",
            content: `counted:${argumentsObject.value}`,
            details: { value: argumentsObject.value }
          };
        }
      }
    ]
  });
}
export {
  countedTool
};
