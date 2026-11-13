/** Shared with the Shell collector so its retained prefix and suffix fit the Store. */
export const executionOutputBudget = 1024 * 1024;

export function executionOutputCost(content: string): number {
  return Buffer.byteLength(JSON.stringify(content)) + 128;
}
