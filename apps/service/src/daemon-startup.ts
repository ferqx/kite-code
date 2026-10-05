import { z } from 'zod';
import { privateStartupSchema } from './bootstrap';
import { profileSchema } from './daemon/reservation';
import { daemonWebSelectionSchema } from './daemon/web-assets';

export const daemonStartupSchema = z.strictObject({
  operation: z.enum(['start', 'preflight']),
  startup: privateStartupSchema,
  workspace: z.string().min(1).max(4096),
  socket: z.string().min(1).max(4096).optional(),
  web: daemonWebSelectionSchema,
});
export type DaemonStartup = z.infer<typeof daemonStartupSchema>;

export const daemonPreflightSchema = z.strictObject({
  operation: z.literal('preflight'),
  instanceId: z.string().min(1).max(512),
  buildId: z.string().min(1).max(512),
  profile: profileSchema,
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('absent') }),
    z.strictObject({ status: z.literal('uninitialized') }),
    z.strictObject({
      status: z.literal('compatible'),
      storeId: z.string().min(1),
      formatMajor: z.literal(1),
    }),
  ]),
});
