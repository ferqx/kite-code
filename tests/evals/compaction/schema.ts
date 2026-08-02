import { z } from 'zod';

export const COMPACTION_FACT_CATEGORIES = [
  'goal',
  'hard_constraint',
  'decision',
  'artifact',
  'failure',
  'approval',
  'verification',
  'plan_state',
  'pending',
  'next_step',
] as const;

export const COMPACTION_MATCHER_KINDS = ['exact', 'normalized', 'semantic'] as const;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const boundedText = z.string().min(1).max(16_384);

const transcriptMessageSchema = z
  .object({
    version: z.literal(1),
    messageId: identifier,
    role: z.enum(['user', 'assistant', 'tool']),
    content: boundedText,
    toolCallId: identifier.nullable(),
  })
  .strict();

const factSchema = z
  .object({
    version: z.literal(1),
    factId: identifier,
    importance: z.enum(['critical', 'important']),
    category: z.enum(COMPACTION_FACT_CATEGORIES),
    matcher: z.enum(COMPACTION_MATCHER_KINDS),
    expected: boundedText,
  })
  .strict();

const continuationSchema = z
  .object({
    version: z.literal(1),
    prompt: boundedText,
    requiredArtifacts: z.array(identifier).max(32),
    requiredChecks: z.array(identifier).max(32),
  })
  .strict();

export const compactionCaseV1Schema = z
  .object({
    version: z.literal(1),
    caseId: identifier,
    caseVersion: z.number().int().positive(),
    source: z.literal('synthetic_fixture'),
    transcript: z.array(transcriptMessageSchema).min(1).max(128),
    increments: z.array(z.array(transcriptMessageSchema).min(1).max(32)).min(1).max(5),
    facts: z.array(factSchema).min(1).max(128),
    forbiddenClaims: z.array(boundedText).max(64),
    continuation: continuationSchema.nullable(),
    fixtureDigest: digest,
  })
  .strict()
  .superRefine((value, context) => {
    const messageIds = [
      ...value.transcript.map((message) => message.messageId),
      ...value.increments.flatMap((increment) => increment.map((message) => message.messageId)),
    ];
    if (new Set(messageIds).size !== messageIds.length) {
      context.addIssue({ code: 'custom', message: 'messageId must be unique across the fixture.' });
    }
    const factIds = value.facts.map((fact) => fact.factId);
    if (new Set(factIds).size !== factIds.length) {
      context.addIssue({ code: 'custom', message: 'factId must be unique.' });
    }
    const toolMessages = [value.transcript, ...value.increments]
      .flat()
      .filter((message) => message.role === 'tool');
    if (toolMessages.some((message) => message.toolCallId === null)) {
      context.addIssue({ code: 'custom', message: 'tool messages require toolCallId.' });
    }
  });

export type CompactionCaseV1 = z.infer<typeof compactionCaseV1Schema>;
export type CompactionFactV1 = CompactionCaseV1['facts'][number];

export function parseCompactionCase(value: unknown): CompactionCaseV1 {
  return structuredClone(compactionCaseV1Schema.parse(value));
}

export function syntheticCompactionCase(): CompactionCaseV1 {
  return {
    version: 1,
    caseId: 'preserve-hard-constraint',
    caseVersion: 1,
    source: 'synthetic_fixture',
    transcript: [
      {
        version: 1,
        messageId: 'm1',
        role: 'user',
        content: 'Update the fixture without network access. Keep src/stable.ts unchanged.',
        toolCallId: null,
      },
    ],
    increments: [
      [
        {
          version: 1,
          messageId: 'm2',
          role: 'assistant',
          content: 'The plan keeps src/stable.ts unchanged.',
          toolCallId: null,
        },
      ],
    ],
    facts: [
      {
        version: 1,
        factId: 'stable-path',
        importance: 'critical',
        category: 'hard_constraint',
        matcher: 'normalized',
        expected: 'Keep ./src/stable.ts unchanged',
      },
      {
        version: 1,
        factId: 'natural-goal',
        importance: 'important',
        category: 'goal',
        matcher: 'semantic',
        expected: 'Improve the synthetic fixture safely',
      },
    ],
    forbiddenClaims: ['verification passed'],
    continuation: {
      version: 1,
      prompt: 'Finish the synthetic fixture change.',
      requiredArtifacts: ['diff'],
      requiredChecks: ['unit-test'],
    },
    fixtureDigest: `sha256:${'1'.repeat(64)}`,
  };
}
