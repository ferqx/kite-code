import type { BaseMessage } from '@/core/messages';
import { countTokens } from '@/core/token-counter';
import type { ResolvedModelCapabilities } from './model-capabilities';
import { usableInputBudget } from './model-capabilities';

export interface ContextTokenEstimate {
  systemTokens: number;
  toolSchemaTokens: number;
  transcriptTokens: number;
  summaryTokens: number;
  dynamicRuntimeTokens: number;
  framingTokens: number;
  totalInputTokens: number;
}

export interface ContextPreflight {
  estimate: ContextTokenEstimate;
  usableInputTokens?: number;
  reservedOutputTokens: number;
  providerSafetyMarginTokens: number;
  utilization?: number;
  status: 'unknown' | 'within_budget' | 'soft' | 'hard';
  targetTokens?: number;
}

function messageContentTokens(message: BaseMessage): number {
  if (typeof message.content === 'string') return countTokens(message.content);
  return countTokens(JSON.stringify(message.content));
}

function toolSchemaTokens(tools: Record<string, unknown> | undefined): number {
  if (!tools) return 0;
  return Object.entries(tools).reduce((total, [name, tool]) => {
    const serializable =
      tool && typeof tool === 'object'
        ? Object.fromEntries(
            Object.entries(tool as Record<string, unknown>).filter(
              ([, value]) => typeof value !== 'function',
            ),
          )
        : tool;
    return (
      total +
      countTokens(
        JSON.stringify(
          serializable && typeof serializable === 'object'
            ? { name, ...(serializable as Record<string, unknown>) }
            : { name, value: serializable },
        ),
      )
    );
  }, 0);
}

export function estimateContextTokens(input: {
  systemMessages: BaseMessage[];
  transcriptMessages: BaseMessage[];
  summaryMessages?: BaseMessage[];
  dynamicRuntimeMessages: BaseMessage[];
  tools?: Record<string, unknown>;
}): ContextTokenEstimate {
  const systemTokens = input.systemMessages.reduce(
    (total, message) => total + messageContentTokens(message),
    0,
  );
  const transcriptTokens = input.transcriptMessages.reduce(
    (total, message) => total + messageContentTokens(message),
    0,
  );
  const summaryTokens = (input.summaryMessages ?? []).reduce(
    (total, message) => total + messageContentTokens(message),
    0,
  );
  const dynamicRuntimeTokens = input.dynamicRuntimeMessages.reduce(
    (total, message) => total + messageContentTokens(message),
    0,
  );
  const schemas = toolSchemaTokens(input.tools);
  const messageCount =
    input.systemMessages.length +
    input.transcriptMessages.length +
    (input.summaryMessages?.length ?? 0) +
    input.dynamicRuntimeMessages.length;
  const framingTokens = messageCount * 4 + Object.keys(input.tools ?? {}).length * 8;
  return {
    systemTokens,
    toolSchemaTokens: schemas,
    transcriptTokens,
    summaryTokens,
    dynamicRuntimeTokens,
    framingTokens,
    totalInputTokens:
      systemTokens +
      schemas +
      transcriptTokens +
      summaryTokens +
      dynamicRuntimeTokens +
      framingTokens,
  };
}

export function addToolSchemasToEstimate(
  estimate: ContextTokenEstimate,
  tools: Record<string, unknown>,
): ContextTokenEstimate {
  const addition = estimateContextTokens({
    systemMessages: [],
    transcriptMessages: [],
    dynamicRuntimeMessages: [],
    tools,
  });
  return {
    ...estimate,
    toolSchemaTokens: addition.toolSchemaTokens,
    framingTokens: estimate.framingTokens + addition.framingTokens,
    totalInputTokens:
      estimate.totalInputTokens + addition.toolSchemaTokens + addition.framingTokens,
  };
}

export function preflightModelContext(input: {
  estimate: ContextTokenEstimate;
  capabilities: ResolvedModelCapabilities;
  requestMaxOutputTokens?: number;
  softRatio?: number;
  hardRatio?: number;
  targetRatio?: number;
}): ContextPreflight {
  const budget = usableInputBudget(input.capabilities, input.requestMaxOutputTokens);
  if (budget.usableInputTokens == null || budget.usableInputTokens <= 0) {
    return {
      estimate: input.estimate,
      reservedOutputTokens: budget.reservedOutputTokens,
      providerSafetyMarginTokens: budget.providerSafetyMarginTokens,
      status: 'unknown',
    };
  }
  const utilization = input.estimate.totalInputTokens / budget.usableInputTokens;
  return {
    estimate: input.estimate,
    usableInputTokens: budget.usableInputTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    providerSafetyMarginTokens: budget.providerSafetyMarginTokens,
    utilization,
    status:
      utilization >= (input.hardRatio ?? 0.88)
        ? 'hard'
        : utilization >= (input.softRatio ?? 0.72)
          ? 'soft'
          : 'within_budget',
    targetTokens: Math.floor(budget.usableInputTokens * (input.targetRatio ?? 0.55)),
  };
}
