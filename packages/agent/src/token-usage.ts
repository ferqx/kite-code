/** Sums only reported facts; coverage makes missing attempts visible without invented zeros. */
export interface RecordedTokenUsage {
  executionCount: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  missingInputCount: number;
  missingOutputCount: number;
}
export function recordedTokenUsage(values: readonly unknown[]): RecordedTokenUsage {
  const valid = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  let input = 0,
    output = 0,
    cache = 0,
    knownInput = 0,
    knownOutput = 0,
    knownCache = 0;
  let inputSafe = true,
    outputSafe = true,
    cacheSafe = true;
  for (const value of values) {
    const usage = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    if (valid(usage.inputTokens)) {
      input += usage.inputTokens;
      knownInput++;
      inputSafe &&= Number.isSafeInteger(input);
    }
    if (valid(usage.outputTokens)) {
      output += usage.outputTokens;
      knownOutput++;
      outputSafe &&= Number.isSafeInteger(output);
    }
    if (
      valid(usage.cachedInputTokens) &&
      (!valid(usage.inputTokens) || usage.cachedInputTokens <= usage.inputTokens)
    ) {
      cache += usage.cachedInputTokens;
      knownCache++;
      cacheSafe &&= Number.isSafeInteger(cache);
    }
  }
  return {
    executionCount: values.length,
    missingInputCount: values.length - knownInput,
    missingOutputCount: values.length - knownOutput,
    ...(knownInput && inputSafe ? { inputTokens: input } : {}),
    ...(knownOutput && outputSafe ? { outputTokens: output } : {}),
    ...(knownInput === values.length && knownCache === values.length && knownCache && cacheSafe
      ? { cachedInputTokens: cache }
      : {}),
  };
}
