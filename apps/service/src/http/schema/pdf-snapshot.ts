import { z } from 'zod';
/** UI-only authorized byte snapshot. Never accepts a filesystem path. */
export const PdfSnapshotRequest = z
  .object({
    expectedStoreId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    page: z.number().int().min(1).max(500),
    data: z
      .string()
      .min(1)
      .max(89478488)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
