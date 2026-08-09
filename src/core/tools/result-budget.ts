/**
 * Provider-neutral identity for the existing model-facing tool-result limits.
 *
 * This foundation policy deliberately records the current byte/character
 * boundaries without changing any projection text or truncation behavior.
 */
export interface ToolResultBudgetPolicyV1 {
  version: 1;
  policyId: 'tool-result-budget:v1';
  shellSearchStreamMaxChars: number;
  mcpModelResultMaxChars: number;
}

export const TOOL_RESULT_BUDGET_POLICY_V1: Readonly<ToolResultBudgetPolicyV1> = Object.freeze({
  version: 1,
  policyId: 'tool-result-budget:v1',
  shellSearchStreamMaxChars: 4_000,
  mcpModelResultMaxChars: 128 * 1_024,
});
