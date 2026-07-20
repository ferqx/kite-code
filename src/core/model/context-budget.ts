import type { BaseMessage } from '@/core/messages';
import { countTokens } from '@/core/token-counter';
import type { SerializedToolDescriptor } from './context-projection';
import type { ResolvedModelCapabilities } from './model-capabilities';
import { usableInputBudget } from './model-capabilities';

/** Five-level context pressure — replaces the old soft/hard binary. */
export type ContextPressure = 'unknown' | 'normal' | 'warning' | 'compact_due' | 'hard_limit';

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
  /** Five-level pressure — see `ContextPressure`. */
  status: ContextPressure;
  /** Token target after compaction. */
  targetTokens?: number;
}

function messageContentTokens(message: BaseMessage): number {
  if (typeof message.content === 'string') return countTokens(message.content);
  return countTokens(JSON.stringify(message.content));
}

function toolSchemaTokens(descriptors: SerializedToolDescriptor[] | undefined): number {
  if (!descriptors || descriptors.length === 0) return 0;
  return descriptors.reduce((total, { name, description, inputSchema }) => {
    return total + countTokens(JSON.stringify({ name, description, inputSchema }));
  }, 0);
}

export function estimateContextTokens(input: {
  systemMessages: BaseMessage[];
  transcriptMessages: BaseMessage[];
  summaryMessages?: BaseMessage[];
  dynamicRuntimeMessages: BaseMessage[];
  serializedTools?: SerializedToolDescriptor[];
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
  const schemas = toolSchemaTokens(input.serializedTools);
  const messageCount =
    input.systemMessages.length +
    input.transcriptMessages.length +
    (input.summaryMessages?.length ?? 0) +
    input.dynamicRuntimeMessages.length;
  const framingTokens = messageCount * 4 + (input.serializedTools?.length ?? 0) * 8;
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
  descriptors: SerializedToolDescriptor[],
): ContextTokenEstimate {
  const addition = estimateContextTokens({
    systemMessages: [],
    transcriptMessages: [],
    dynamicRuntimeMessages: [],
    serializedTools: descriptors,
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
  compactRatio?: number;
  hardRatio?: number;
  targetRatio?: number;
  /** Below this ratio → no action needed. Default 0.80. */
  warningRatio?: number;
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
  const warningRatio = input.warningRatio ?? 0.8;
  const compactRatio = input.compactRatio ?? 0.88;
  const hardRatio = input.hardRatio ?? 0.94;

  let status: ContextPressure;
  if (utilization >= hardRatio) {
    status = 'hard_limit';
  } else if (utilization >= compactRatio) {
    status = 'compact_due';
  } else if (utilization >= warningRatio) {
    status = 'warning';
  } else {
    status = 'normal';
  }

  return {
    estimate: input.estimate,
    usableInputTokens: budget.usableInputTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    providerSafetyMarginTokens: budget.providerSafetyMarginTokens,
    utilization,
    status,
    targetTokens: Math.floor(budget.usableInputTokens * (input.targetRatio ?? 0.62)),
  };
}
