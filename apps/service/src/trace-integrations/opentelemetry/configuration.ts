import { z } from 'zod';

/** Non-secret installation settings. Exact Origin/target/credential permission remains Host-owned. */
export const otelIntegrationConfigSchema = z.strictObject({
  endpoint: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.href === value
        );
      } catch {
        return false;
      }
    }),
  sampleRate: z.number().min(0).max(1).default(1),
  credentialHandle: z.string().min(1).max(512).optional(),
});
export type OtelIntegrationConfig = z.infer<typeof otelIntegrationConfigSchema>;
