import { z } from 'zod';

export const KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_ =
  'kite.app-server-daemon.status-request.v1' as const;
export const KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_ =
  'kite.app-server-daemon.status-response.v1' as const;
export const KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_SCHEMA_ =
  'kite.app-server-daemon.shutdown-request.v1' as const;
export const KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_ =
  'kite.app-server-daemon.shutdown-response.v1' as const;

const loopbackWebOrigin = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u)
  .max(128)
  .refine((value) => Number(value.slice(value.lastIndexOf(':') + 1)) <= 65_535);

export const KITE_APP_SERVER_DAEMON_STATUS_REQUEST_CODEC_ = z
  .object({ schema: z.literal(KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_) })
  .strict();
export const KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_ = z
  .object({
    schema: z.literal(KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_),
    state: z.enum(['ready', 'draining']),
    instanceId: z.string().min(1).max(128),
    buildId: z.string().min(1).max(4_096),
    startedAt: z.iso.datetime({ offset: false }),
    workspace: z.string().min(1).max(4_096),
    webOrigin: loopbackWebOrigin,
  })
  .strict();
export const KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_CODEC_ = z
  .object({ schema: z.literal(KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_SCHEMA_) })
  .strict();
export const KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_CODEC_ = z
  .object({
    schema: z.literal(KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_),
    outcome: z.literal('accepted'),
  })
  .strict();

export type KiteAppServerDaemonStatusResponse = z.infer<
  typeof KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_
>;
