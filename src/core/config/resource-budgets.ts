import { z } from 'zod';

export const DEFAULT_RESOURCE_BUDGETS = Object.freeze({
  modelFirstByteMs: 30_000,
  modelIdleMs: 60_000,
  modelTotalMs: 600_000,
  shellDefaultMs: 600_000,
  shellMaxMs: 1_800_000,
  mcpCallMs: 120_000,
  cancellationGraceMs: 3_000,
  modelProjectionBytes: 131_072,
  inMemoryStreamBytes: 1_048_576,
  artifactMaxBytes: 104_857_600,
  eventQueueMaxEvents: 2_048,
  eventQueueMaxBytes: 8_388_608,
  readMaxBytes: 16_777_216,
  searchMaxFiles: 100_000,
  searchMaxBytes: 536_870_912,
  searchMaxDurationMs: 30_000,
  searchMaxResults: 10_000,
});

const positiveInteger = z.number().int().positive();

export const resourceBudgetsSchema = z
  .object({
    modelFirstByteMs: positiveInteger.optional(),
    modelIdleMs: positiveInteger.optional(),
    modelTotalMs: positiveInteger.optional(),
    shellDefaultMs: positiveInteger.optional(),
    shellMaxMs: positiveInteger.optional(),
    mcpCallMs: positiveInteger.optional(),
    cancellationGraceMs: positiveInteger.optional(),
    modelProjectionBytes: positiveInteger.optional(),
    inMemoryStreamBytes: positiveInteger.optional(),
    artifactMaxBytes: positiveInteger.optional(),
    eventQueueMaxEvents: positiveInteger.optional(),
    eventQueueMaxBytes: positiveInteger.optional(),
    readMaxBytes: positiveInteger.optional(),
    searchMaxFiles: positiveInteger.optional(),
    searchMaxBytes: positiveInteger.optional(),
    searchMaxDurationMs: positiveInteger.optional(),
    searchMaxResults: positiveInteger.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const resolved = { ...DEFAULT_RESOURCE_BUDGETS, ...value };
    if (resolved.modelFirstByteMs > resolved.modelTotalMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelFirstByteMs'],
        message: 'modelFirstByteMs must not exceed modelTotalMs',
      });
    }
    if (resolved.modelIdleMs > resolved.modelTotalMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelIdleMs'],
        message: 'modelIdleMs must not exceed modelTotalMs',
      });
    }
    if (resolved.shellDefaultMs > resolved.shellMaxMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shellDefaultMs'],
        message: 'shellDefaultMs must not exceed shellMaxMs',
      });
    }
    if (resolved.modelProjectionBytes > resolved.inMemoryStreamBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelProjectionBytes'],
        message: 'modelProjectionBytes must not exceed inMemoryStreamBytes',
      });
    }
  });

export interface ResourceBudgets {
  readonly modelFirstByteMs: number;
  readonly modelIdleMs: number;
  readonly modelTotalMs: number;
  readonly shellDefaultMs: number;
  readonly shellMaxMs: number;
  readonly mcpCallMs: number;
  readonly cancellationGraceMs: number;
  readonly modelProjectionBytes: number;
  readonly inMemoryStreamBytes: number;
  readonly artifactMaxBytes: number;
  readonly eventQueueMaxEvents: number;
  readonly eventQueueMaxBytes: number;
  readonly readMaxBytes: number;
  readonly searchMaxFiles: number;
  readonly searchMaxBytes: number;
  readonly searchMaxDurationMs: number;
  readonly searchMaxResults: number;
}

export function resolveResourceBudgets(
  input?: z.input<typeof resourceBudgetsSchema>,
): ResourceBudgets {
  return Object.freeze({
    ...DEFAULT_RESOURCE_BUDGETS,
    ...resourceBudgetsSchema.parse(input ?? {}),
  });
}
