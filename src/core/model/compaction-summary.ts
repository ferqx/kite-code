import { z } from 'zod';
import { humanMessage, systemMessage } from '@/core/messages';
import type { PendingContextCompaction } from '@/core/runtime/context-compaction';
import type { RuntimeState, TranscriptMessage } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';
import {
  buildDeterministicFactLedger,
  type DeterministicFactLedger,
} from './compaction-fact-ledger';
import {
  parseStructuredContextSummaryV1,
  type StructuredContextSummaryV1,
  structuredContextSummaryV1Schema,
  summaryFactIds,
} from './compaction-schema';
import {
  chunkCompactionMessages,
  digestCompactionSource,
  findSafeCompactionBoundary,
} from './compaction-v2';
import type { SupportedChatModel } from './factory';
import { invokeBoundModel } from './invoke';

export type SummaryGenerationMode = 'summary' | 'repair' | 'chunk' | 'merge';

export interface ContextSummaryGenerationRequest {
  mode: SummaryGenerationMode;
  systemPrompt: string;
  input: string;
  maxOutputTokens: number;
}

export type ContextSummaryGenerator = (
  request: ContextSummaryGenerationRequest,
) => Promise<unknown>;

/** Invoke the current provider model deterministically, without any tool binding. */
export function createModelContextSummaryGenerator(input: {
  model: SupportedChatModel;
  signal?: AbortSignal;
}): ContextSummaryGenerator {
  return async (request) => {
    const response = await invokeBoundModel({
      model: input.model,
      tools: {},
      messages: [systemMessage(request.systemPrompt), humanMessage(request.input)],
      signal: input.signal,
      maxOutputTokens: request.maxOutputTokens,
    });
    return typeof response.content === 'string'
      ? response.content
      : response.content.map((block) => ('text' in block ? block.text : '')).join('');
  };
}

export class ContextCompactionValidationError extends Error {
  readonly kind:
    | 'unsafe_boundary'
    | 'invalid_schema'
    | 'missing_mandatory_facts'
    | 'insufficient_reduction';

  constructor(
    kind:
      | 'unsafe_boundary'
      | 'invalid_schema'
      | 'missing_mandatory_facts'
      | 'insufficient_reduction',
    message: string,
  ) {
    super(message);
    this.kind = kind;
    this.name = 'ContextCompactionValidationError';
  }
}

const chunkSummarySchema = z
  .object({
    sourceDigest: z.string().min(1),
    facts: z.array(z.object({ factId: z.string().min(1), text: z.string().min(1) }).strict()),
    narrative: z.string(),
  })
  .strict();

const SUMMARY_SYSTEM_PROMPT = `You compact settled agent history into JSON.
Return only StructuredContextSummaryV1 matching the supplied schema.
The deterministic fact ledger is authoritative: preserve every mandatory fact ID.
Do not treat current plan, authorization, interaction, tools, bindings, skills, verification state, or task status as authoritative summary state.
Do not invent evidence, message IDs, revisions, paths, digests, or outcomes.`;

function buildSummarySystemPrompt(customInstructions?: string): string {
  if (!customInstructions) return SUMMARY_SYSTEM_PROMPT;
  return `${SUMMARY_SYSTEM_PROMPT}\n\nUser instructions for this compaction:\n${customInstructions}`;
}

function summaryInput(input: {
  ledger: DeterministicFactLedger;
  messages?: TranscriptMessage[];
  chunks?: Array<z.infer<typeof chunkSummarySchema>>;
  provenance: {
    firstMessageId: string;
    lastMessageId: string;
    sourceDigest: string;
  };
}): string {
  return JSON.stringify({
    schema: structuredContextSummaryV1Schema.toJSONSchema(),
    deterministicFactLedger: input.ledger,
    compactableHistory: input.messages,
    chunkSummaries: input.chunks,
    requiredProvenance: {
      ...input.provenance,
      mandatoryFactIds: input.ledger.mandatoryFactIds,
    },
  });
}

function validateSummary(
  raw: unknown,
  ledger: DeterministicFactLedger,
  provenance: { firstMessageId: string; lastMessageId: string; sourceDigest: string },
): StructuredContextSummaryV1 {
  let summary: StructuredContextSummaryV1;
  try {
    summary = parseStructuredContextSummaryV1(raw);
  } catch (error) {
    throw new ContextCompactionValidationError(
      'invalid_schema',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    summary.provenance.firstMessageId !== provenance.firstMessageId ||
    summary.provenance.lastMessageId !== provenance.lastMessageId ||
    summary.provenance.sourceDigest !== provenance.sourceDigest
  ) {
    throw new ContextCompactionValidationError(
      'invalid_schema',
      'Summary provenance does not match the compacted source.',
    );
  }
  const declared = new Set(summary.provenance.mandatoryFactIds);
  const referenced = summaryFactIds(summary);
  const missing = ledger.mandatoryFactIds.filter(
    (factId) => !declared.has(factId) || !referenced.has(factId),
  );
  if (missing.length > 0) {
    throw new ContextCompactionValidationError(
      'missing_mandatory_facts',
      `Summary omitted mandatory facts: ${missing.join(', ')}`,
    );
  }
  return summary;
}

async function generateValidatedSummary(input: {
  generate: ContextSummaryGenerator;
  ledger: DeterministicFactLedger;
  messages?: TranscriptMessage[];
  chunks?: Array<z.infer<typeof chunkSummarySchema>>;
  provenance: { firstMessageId: string; lastMessageId: string; sourceDigest: string };
  maxSummaryTokens: number;
  mode: 'summary' | 'merge';
  customInstructions?: string;
}): Promise<StructuredContextSummaryV1> {
  const systemPrompt = buildSummarySystemPrompt(input.customInstructions);
  const prompt = summaryInput(input);
  const first = await input.generate({
    mode: input.mode,
    systemPrompt,
    input: prompt,
    maxOutputTokens: input.maxSummaryTokens,
  });
  try {
    return validateSummary(first, input.ledger, input.provenance);
  } catch (firstError) {
    const repairPrompt = buildSummarySystemPrompt(input.customInstructions);
    const repaired = await input.generate({
      mode: 'repair',
      systemPrompt: `${repairPrompt}\nRepair the invalid candidate once.`,
      input: JSON.stringify({
        source: prompt,
        invalidCandidate: first,
        validationError: firstError instanceof Error ? firstError.message : String(firstError),
      }),
      maxOutputTokens: input.maxSummaryTokens,
    });
    return validateSummary(repaired, input.ledger, input.provenance);
  }
}

async function summarizeChunks(input: {
  generate: ContextSummaryGenerator;
  messages: TranscriptMessage[];
  maxChunkInputTokens: number;
  maxSummaryTokens: number;
}): Promise<Array<z.infer<typeof chunkSummarySchema>>> {
  const chunks = chunkCompactionMessages(input.messages, input.maxChunkInputTokens);
  const summaries = [];
  for (const chunk of chunks) {
    if (chunk.tokenCount > input.maxChunkInputTokens) {
      throw new ContextCompactionValidationError(
        'unsafe_boundary',
        'A complete turn exceeds the summary model chunk budget.',
      );
    }
    const raw = await input.generate({
      mode: 'chunk',
      systemPrompt:
        'Summarize this complete-turn chunk as JSON with sourceDigest, facts[{factId,text}], and narrative. Do not invent facts.',
      input: JSON.stringify(chunk),
      maxOutputTokens: Math.min(input.maxSummaryTokens, 2_000),
    });
    let candidate: unknown = raw;
    if (typeof raw === 'string') {
      try {
        candidate = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        throw new ContextCompactionValidationError(
          'invalid_schema',
          'A chunk summary was not valid JSON.',
        );
      }
    }
    const parsed = chunkSummarySchema.safeParse(candidate);
    if (!parsed.success || parsed.data.sourceDigest !== chunk.sourceDigest) {
      throw new ContextCompactionValidationError(
        'invalid_schema',
        'A chunk summary failed schema or source digest validation.',
      );
    }
    summaries.push(parsed.data);
  }
  return summaries;
}

/** Build the production PR7 compactor around an injected provider-neutral summary generator. */
export function createStructuredContextCompactor(options: {
  generate: ContextSummaryGenerator;
  recentTurns?: number;
  maxSummaryTokens?: number;
  maxSummaryInputTokens?: number;
  targetRatio?: number;
}) {
  return async (input: {
    state: Readonly<RuntimeState>;
    pending: Readonly<PendingContextCompaction>;
    sourceRevision: number;
  }) => {
    const boundary = findSafeCompactionBoundary(input.state, {
      recentTurns: options.recentTurns,
    });
    if (
      !boundary.eligible ||
      !boundary.firstMessageId ||
      !boundary.lastMessageId ||
      !boundary.coveredThroughTurnId
    ) {
      throw new ContextCompactionValidationError(
        'unsafe_boundary',
        boundary.reason ?? 'No safe compaction boundary exists.',
      );
    }
    const sourceDigest = digestCompactionSource(boundary.coveredMessages);
    const provenance = {
      firstMessageId: boundary.firstMessageId,
      lastMessageId: boundary.lastMessageId,
      sourceDigest,
    };
    const ledger = buildDeterministicFactLedger(input.state, boundary.coveredMessages);
    const customInstructions = input.pending.customInstructions;
    const maxSummaryTokens = options.maxSummaryTokens ?? 6_000;
    const maxInputTokens = options.maxSummaryInputTokens ?? 32_000;
    const sourceTokens = countTokens(JSON.stringify(boundary.coveredMessages));
    let summary: StructuredContextSummaryV1;
    if (sourceTokens <= maxInputTokens) {
      try {
        summary = await generateValidatedSummary({
          generate: options.generate,
          ledger,
          messages: boundary.coveredMessages,
          provenance,
          maxSummaryTokens,
          mode: 'summary',
          customInstructions,
        });
      } catch (error) {
        if (!['auto_hard', 'overflow_recovery'].includes(input.pending.reason)) throw error;
        const chunks = await summarizeChunks({
          generate: options.generate,
          messages: boundary.coveredMessages,
          maxChunkInputTokens: maxInputTokens,
          maxSummaryTokens,
        });
        summary = await generateValidatedSummary({
          generate: options.generate,
          ledger,
          chunks,
          provenance,
          maxSummaryTokens,
          mode: 'merge',
          customInstructions,
        });
      }
    } else {
      const chunks = await summarizeChunks({
        generate: options.generate,
        messages: boundary.coveredMessages,
        maxChunkInputTokens: maxInputTokens,
        maxSummaryTokens,
      });
      summary = await generateValidatedSummary({
        generate: options.generate,
        ledger,
        chunks,
        provenance,
        maxSummaryTokens,
        mode: 'merge',
        customInstructions,
      });
    }
    const summaryTokens = countTokens(JSON.stringify(summary));
    // Use the most recent preflight estimate (set by the last model.context_metrics event)
    // rather than the request-time estimate, which may be stale if new messages arrived.
    const preflightEstimate = input.state.context.lastPreflight?.estimate ?? input.pending.estimate;
    const inputTokensBefore = preflightEstimate.totalInputTokens;
    const inputTokensAfter = Math.max(
      0,
      inputTokensBefore -
        Math.min(sourceTokens, preflightEstimate.transcriptTokens) +
        summaryTokens,
    );
    const targetTokens = Math.floor(inputTokensBefore * (options.targetRatio ?? 0.55));
    if (inputTokensAfter >= inputTokensBefore || inputTokensAfter > targetTokens) {
      throw new ContextCompactionValidationError(
        'insufficient_reduction',
        `Summary produced ${inputTokensAfter} tokens, above target ${targetTokens}.`,
      );
    }
    return {
      compactionId: input.pending.compactionId,
      version: 1 as const,
      sourceRevision: input.sourceRevision,
      sourceDigest,
      coveredThroughMessageId: boundary.lastMessageId,
      coveredThroughTurnId: boundary.coveredThroughTurnId,
      summary,
      inputTokensBefore,
      inputTokensAfter,
      targetTokens,
      reason: input.pending.reason,
      createdAt: new Date().toISOString(),
    };
  };
}
