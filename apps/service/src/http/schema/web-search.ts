import { z } from 'zod';

const providerId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const credentialRef = z
  .string()
  .regex(/^credential:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const providerConnection = z.strictObject({
  kind: z.literal('provider'),
  providerAlias: providerId,
});
const dedicatedConnection = z.strictObject({
  kind: z.literal('dedicated'),
  baseURL: z.string().min(1).max(4096),
  credentialRef,
});
const settings = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('auto'), providerId: providerId.optional() }),
  z.strictObject({ mode: z.literal('provider'), providerId }),
]);

function providers<C extends z.ZodType>(connection: C) {
  const common = { id: providerId, name: z.string().min(1).max(120), connection };
  return z
    .array(
      z.union([
        z.strictObject({
          ...common,
          adapter: z.enum(['perplexity-search', 'deepseek-search']),
          maxResults: z.number().int().min(1).max(10).optional(),
        }),
        z.strictObject({
          ...common,
          adapter: z.literal('openai-search'),
          modelId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
        }),
      ]),
    )
    .max(128);
}

const text = z.string().min(1).max(256);
// HTTP(S) links only. A link is display data and never network input to this API.
const url = z
  .string()
  .max(4096)
  .regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/);
const title = z.string().max(512).optional();
const source = z.strictObject({ url, title, snippet: z.string().max(2048).optional() });
const anchor = z.strictObject({
  executionId: text,
  blockIndex: safeInteger,
  textSha256: z.string().regex(/^[a-f0-9]{64}$/),
  blockLengthUtf16: safeInteger,
  blockStartUtf16: safeInteger.optional(),
  startUtf16: safeInteger,
  endUtf16: safeInteger,
});
const citation = z.strictObject({ url, title, anchor: anchor.optional() });
const usage = z.strictObject({
  providerRequests: safeInteger.optional(),
  searchModelInputTokens: safeInteger.optional(),
  searchModelOutputTokens: safeInteger.optional(),
  providerSearchCalls: safeInteger.optional(),
});
export const webSearchEvidenceSchema = z.strictObject({
  schema: z.literal('kite.web-search'),
  schemaVersion: z.literal(1),
  storeId: text,
  sessionId: text,
  executionId: text,
  revision: safeInteger,
  blocks: z.array(
    z.strictObject({
      route: z.enum(['native', 'provider']),
      provider: text,
      callId: text,
      status: z.enum(['searching', 'completed', 'incomplete', 'failed', 'outcome_unknown']),
      query: z.string().max(2048).optional(),
      sources: z.array(source).max(64),
      citations: z.array(citation).max(128),
      truncated: z.boolean(),
      sourceScope: z.literal('response').optional(),
      errorCode: z
        .string()
        .regex(/^[a-z0-9_]{1,128}$/)
        .optional(),
      usage: usage.optional(),
    }),
  ),
});

export function webSearchSchemas<I extends z.ZodType, R extends z.ZodType>(id: I, readSet: R) {
  return {
    WebSearchEvidence: webSearchEvidenceSchema,
    WebSearchSettingsView: z.strictObject({
      storeId: id,
      readSet: readSet.nullable(),
      webSearch: settings,
      searchProviders: providers(z.union([providerConnection, dedicatedConnection])),
      derivedDeepSeek: z
        .strictObject({
          status: z.enum(['configured', 'unavailable', 'ambiguous']),
          label: z.string().min(1).max(120).optional(),
        })
        .optional(),
      eligibleConnections: z
        .array(
          z.strictObject({
            providerAlias: providerId,
            name: z.string().min(1).max(120),
            adapter: z.enum(['deepseek-search', 'perplexity-search', 'openai-search']),
          }),
        )
        .max(128)
        .optional(),
      errors: z.array(z.string().regex(/^[a-z0-9_]{1,128}$/)),
    }),
    WebSearchSettingsRequest: z.strictObject({
      expectedStoreId: id,
      commandId: id,
      expectedReadSet: readSet,
      webSearch: settings,
      searchProviders: providers(
        z.union([
          providerConnection,
          dedicatedConnection,
          dedicatedConnection.omit({ credentialRef: true }),
        ]),
      ),
      credential: z
        .strictObject({
          providerId,
          secret: z
            .string()
            .min(1)
            .max(8000)
            .regex(/^[!-~]+$/),
        })
        .optional(),
    }),
    WebSearchTestRequest: z.strictObject({
      expectedStoreId: id,
      sessionId: id,
      commandId: id,
      expectedReadSet: readSet,
    }),
  };
}
