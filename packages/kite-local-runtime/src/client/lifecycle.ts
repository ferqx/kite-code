import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { z } from 'zod';
import type { KiteLocalRuntimeEndpoint } from '../service/paths';

export const KITE_LIFECYCLE_SCHEMA = 'kite.lifecycle.v1' as const;
export const KITE_LIFECYCLE_MAX_BYTES = 16 * 1024;
export const KITE_LIFECYCLE_TIMEOUT_MS = 5_000;
const identity = z.string().min(1).max(4096);
const base = { schema: z.literal(KITE_LIFECYCLE_SCHEMA), requestId: z.string().uuid() };
export const KITE_LIFECYCLE_REQUEST = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('status') }).strict(),
  z
    .object({
      ...base,
      operation: z.literal('shutdown'),
      expectedInstanceId: identity,
      mode: z.enum(['if_idle', 'cancel']),
    })
    .strict(),
]);
export const KITE_LIFECYCLE_STATUS = z.object({
  instanceId: identity,
  pid: z.number().int().positive(),
  processStartIdentity: identity,
  homeDigest: identity,
  workspace: identity,
  buildId: identity,
  startedAt: z.iso.datetime(),
  protocol: identity,
  capabilities: z.array(identity).max(128),
  phase: z.enum(['starting', 'ready', 'draining']),
  activeOperations: z.boolean(),
  webOrigin: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u)
    .refine((v) => Number(v.split(':').at(-1)) <= 65535)
    .optional(),
});
export const KITE_LIFECYCLE_RESPONSE = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('status'), status: KITE_LIFECYCLE_STATUS }),
  z.object({
    ...base,
    operation: z.literal('shutdown'),
    outcome: z.enum(['accepted', 'busy', 'instance_changed', 'already_draining']),
  }),
  z.object({
    ...base,
    operation: z.literal('error'),
    code: z.enum(['unsupported', 'invalid_request', 'unavailable']),
  }),
]);
export type KiteLifecycleRequest = z.infer<typeof KITE_LIFECYCLE_REQUEST>;
export type KiteLifecycleResponse = z.infer<typeof KITE_LIFECYCLE_RESPONSE>;
export type KiteLifecycleStatus = z.infer<typeof KITE_LIFECYCLE_STATUS>;

/** Only the selected owner-only endpoint is contacted; never spawns or retries a mutation. */
export async function requestKiteLifecycle(
  endpoint: KiteLocalRuntimeEndpoint,
  input:
    | { operation: 'status' }
    | { operation: 'shutdown'; expectedInstanceId: string; mode: 'if_idle' | 'cancel' },
): Promise<KiteLifecycleResponse> {
  if (endpoint.kind === 'unix') {
    const parent = lstatSync(endpoint.root);
    const socketStat = lstatSync(endpoint.socket);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      realpathSync.native(endpoint.root) !== endpoint.root ||
      (parent.mode & 0o077) !== 0 ||
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink() ||
      (socketStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' &&
        (parent.uid !== process.getuid() || socketStat.uid !== process.getuid()))
    ) {
      throw new Error('Lifecycle endpoint identity is unavailable.');
    }
  }
  const request = KITE_LIFECYCLE_REQUEST.parse({
    schema: KITE_LIFECYCLE_SCHEMA,
    requestId: randomUUID(),
    ...input,
  });
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.kind === 'unix' ? endpoint.socket : endpoint.pipeName);
    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, response?: KiteLifecycleResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(
      () => finish(new Error('Lifecycle request timed out.')),
      KITE_LIFECYCLE_TIMEOUT_MS,
    );
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      if (buffered.length + chunk.length > KITE_LIFECYCLE_MAX_BYTES)
        return finish(new Error('Invalid lifecycle response.'));
      buffered = Buffer.concat([buffered, chunk]);
      if (!buffered.includes(10)) return;
      try {
        const response = KITE_LIFECYCLE_RESPONSE.parse(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              buffered.subarray(0, buffered.indexOf(10)),
            ),
          ),
        );
        if (
          response.requestId !== request.requestId ||
          (response.operation !== 'error' && response.operation !== request.operation)
        )
          throw new Error();
        finish(undefined, response);
      } catch {
        finish(new Error('Invalid lifecycle response.'));
      }
    });
    socket.on('error', () => finish(new Error('Lifecycle endpoint is unavailable.')));
    socket.on('close', () => finish(new Error('Lifecycle connection closed.')));
  });
}
