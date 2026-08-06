import { z } from 'zod';
import { featureFlagOverridesSchema } from './features';
import { mcpServerSchema } from './mcp-server-config';

const modelEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      default: z.boolean().optional(),
      contextWindow: z.number().int().positive().optional(),
      /** @deprecated Use contextWindow. */
      tokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      tokenizerFamily: z.string().min(1).optional(),
      supportsUsageMetadata: z.boolean().optional(),
      supportsPromptCache: z.boolean().optional(),
      streaming: z.boolean().optional(),
    })
    .strict(),
]);

const providerSchema = z.object({
  type: z.enum(['deepseek', 'openai', 'openai-compatible', 'ollama']).optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  reasoning: z.boolean().optional(),
  modelKwargs: z.record(z.string(), z.any()).optional(),
  models: z.array(modelEntrySchema).optional(),
});

const legacyModelEntrySchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  default: z.boolean().optional(),
});

const interactionModeSchema = z.enum(['accept_edits', 'auto', 'full']);
const modelRouteObjectSchema = z
  .object({
    provider: z.string().trim().min(1),
    name: z.string().trim().min(1),
  })
  .strict();
const compactModelRouteSchema = z
  .string()
  .trim()
  .regex(/^[^:]+:[\s\S]+$/, 'Expected model route in provider:model format');
const modelRouteInputSchema = z.union([compactModelRouteSchema, modelRouteObjectSchema]);
const modelSelectionInputSchema = z.union([
  compactModelRouteSchema,
  z.object({ default: modelRouteInputSchema }).strict(),
]);
const modelSelectionOutputSchema = z.object({ default: modelRouteObjectSchema }).strict();

function decodeModelRoute(
  value: z.input<typeof modelRouteInputSchema>,
): z.output<typeof modelRouteObjectSchema> {
  if (typeof value !== 'string') return value;
  const separator = value.indexOf(':');
  return {
    provider: value.slice(0, separator).trim(),
    name: value.slice(separator + 1).trim(),
  };
}

/**
 * One source-owned codec covers the on-disk `provider:model` shorthand and
 * legacy object form while exposing the canonical route to runtime callers.
 * Qualification snapshots its JSON-Schema input side, never a hand-maintained
 * parallel config surface.
 */
const modelSelectionSchema = z
  .codec(modelSelectionInputSchema, modelSelectionOutputSchema, {
    decode: (value) =>
      typeof value === 'string'
        ? { default: decodeModelRoute(value) }
        : { default: decodeModelRoute(value.default) },
    encode: (value) => value,
  })
  .optional();
const sandboxSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .optional();
const sessionLoggingTighteningSchema = z
  .object({
    mode: z.enum(['off', 'metadata', 'content']).optional(),
    retentionDays: z.number().int().positive().optional(),
    maxTotalBytes: z.number().int().positive().optional(),
    maxSessionBytes: z.number().int().positive().optional(),
  })
  .strict()
  .optional();
const telemetryConsentGrantSchema = z
  .object({
    state: z.enum(['granted', 'withdrawn']),
    metricCategories: z.array(
      z.enum(['run_turn', 'model_usage', 'tool_mcp_skill', 'runtime_resource', 'release_rollout']),
    ),
    receiver: z.string().trim().min(1).max(128),
    retentionDays: z.number().int().nonnegative(),
    withdrawalMethod: z.string().trim().min(1).max(256),
    canaryOptIn: z.boolean(),
  })
  .strict();
const telemetryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpointPolicy: z.enum(['disabled', 'vendor_managed', 'admin_managed']).optional(),
    endpointSecret: z.string().min(1).optional(),
    consent: telemetryConsentGrantSchema.optional(),
    contentLoggingConsent: z.boolean().optional(),
    modelProviderConsent: z.boolean().optional(),
  })
  .strict()
  .optional();

/** Narrow config schema module: safe for diagnostic inventory imports. */
export const configSchema = z.object({
  provider: z.record(z.string(), providerSchema).optional().default({}),
  /** Last model route explicitly selected by the user. */
  model: modelSelectionSchema,
  /** @deprecated Use provider[name].models instead */
  models: z.array(legacyModelEntrySchema).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  colorPreset: z.string().optional(),
  interactionMode: interactionModeSchema.optional(),
  features: featureFlagOverridesSchema,
  sessionLogging: sessionLoggingTighteningSchema,
  telemetry: telemetryConfigSchema,
  sandbox: sandboxSchema,
  autoReview: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      failOpen: z.boolean().optional(),
      doomLoopRepeatThreshold: z.number().int().positive().optional(),
      circuitBreakerMaxRejections: z.number().int().positive().optional(),
      circuitBreakerWindowMs: z.number().int().positive().optional(),
    })
    .optional(),
  compaction: z
    .object({
      autoMode: z.enum(['off', 'shadow', 'live']).optional(),
      cohortSalt: z.string().min(1).optional(),
      livePercentage: z.number().min(0).max(100).optional(),
      localDebug: z
        .object({ enabled: z.boolean(), directory: z.string().min(1) })
        .strict()
        .optional(),
      triggerRatio: z.number().positive().max(1).optional(),
      compactAfterEstimatedTokens: z.number().int().positive().optional(),
      maxSummaryTokens: z.number().int().positive().optional(),
      maxSummaryInputTokens: z.number().int().positive().optional(),
      maxNarrativeTokens: z.number().int().positive().optional(),
      compactRatio: z.number().positive().max(1).optional(),
      hardRatio: z.number().positive().max(1).optional(),
      warningRatio: z.number().positive().max(1).optional(),
      minimumReductionRatio: z.number().nonnegative().max(1).optional(),
      cooldownTurns: z.number().int().nonnegative().optional(),
      providerSafetyRatio: z.number().positive().max(0.2).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      if (
        val.maxSummaryTokens != null &&
        val.maxNarrativeTokens != null &&
        val.maxSummaryTokens > val.maxNarrativeTokens
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'maxSummaryTokens must not exceed maxNarrativeTokens',
          path: ['maxSummaryTokens'],
        });
      }
      const warning = val.warningRatio ?? 0.8;
      const compact = val.compactRatio ?? 0.9;
      const hard = val.hardRatio ?? 0.94;
      if (warning >= compact) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `warningRatio (${warning}) must be less than compactRatio (${compact})`,
          path: ['warningRatio'],
        });
      }
      if (compact >= hard) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `compactRatio (${compact}) must be less than hardRatio (${hard})`,
          path: ['compactRatio'],
        });
      }
    })
    .optional(),
  mcpServers: z.record(z.string(), mcpServerSchema).optional().default({}),
});

export type KiteCodeConfig = z.infer<typeof configSchema>;
