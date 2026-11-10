import { createInterface } from 'node:readline';
import { z } from 'zod';
import { exportOtelSpans, type OtelSendAuthorization } from './exporter';
import { materializeSpan } from './mapping';
import { OtelAdapterStore, type OtelStoreOptions } from './store';

const inputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('request'),
    id: z.number().int().positive(),
    method: z.enum(['initialize', 'grant', 'accept', 'pump', 'cancel', 'inspect', 'close']),
    input: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('authorization'),
    id: z.number().int().positive(),
    allowed: z.boolean(),
    authorization: z
      .strictObject({
        headers: z.record(z.string(), z.string()),
        target: z.strictObject({
          address: z.string().max(64),
          family: z.union([z.literal(4), z.literal(6)]),
        }),
      })
      .optional(),
  }),
]);
const stampSchema = z.strictObject({
  revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  epoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
  active: z.boolean(),
});
const initializationSchema = z.strictObject({
  path: z.string().max(4096),
  installationId: z.string().min(1).max(512),
  endpoint: z.string().max(2048),
  sampleRate: z.number().min(0).max(1).optional(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .optional(),
  maxAcceptedEvents: z.number().int().positive().max(100000).optional(),
  grant: stampSchema,
});
let store: OtelAdapterStore | undefined,
  pump: Promise<unknown> | undefined,
  closing = false,
  sequence = 0;
const authorizations = new Map<
  number,
  { resolve(authorization: OtelSendAuthorization): void; reject(error: Error): void }
>();
function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function invoke(method: string, input: unknown): Promise<unknown> {
  if (method === 'initialize') {
    if (store) throw Error('otel_already_initialized');
    const { grant, ...options } = initializationSchema.parse(input);
    store = new OtelAdapterStore(options as OtelStoreOptions);
    store.setGrant(grant);
    return null;
  }
  if (!store || closing) throw Error('otel_adapter_closed');
  switch (method) {
    case 'accept':
      return store.consume(input as Parameters<OtelAdapterStore['consume']>[0]);
    case 'grant':
      store.setGrant(stampSchema.parse(input));
      return null;
    case 'cancel':
      store.cancelTask(z.string().min(1).max(512).parse(input));
      return null;
    case 'inspect':
      return store.inspect();
    case 'pump': {
      if (pump) throw Error('otel_adapter_busy');
      const row = store.next();
      if (!row) return null;
      const current = store;
      pump = (async () => {
        const outcome = await exportOtelSpans({
          endpoint: current.options.endpoint,
          spans: [materializeSpan(row.envelope)],
          async authorizeSend() {
            if (closing) throw Error('otel_adapter_closed');
            const id = ++sequence;
            const authorization = await new Promise<OtelSendAuthorization>((resolve, reject) => {
              authorizations.set(id, { resolve, reject });
              send({
                type: 'authorize_send',
                id,
                taskId: row.taskId,
                revision: row.revision,
                epoch: row.epoch,
                endpoint: current.options.endpoint,
              });
            });
            if (closing) throw Error('otel_adapter_closed');
            current.admitSend(row);
            return authorization;
          },
        });
        current.finish(row, outcome);
        return outcome;
      })().finally(() => {
        pump = undefined;
      });
      return pump;
    }
    case 'close': {
      closing = true;
      for (const item of authorizations.values()) item.reject(Error('otel_adapter_closed'));
      authorizations.clear();
      await pump;
      store.close();
      store = undefined;
      return null;
    }
    default:
      throw Error('otel_method_invalid');
  }
}
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on('line', (line) => {
  if (Buffer.byteLength(line) > 768 * 1024) {
    process.exitCode = 1;
    lines.close();
    return;
  }
  try {
    const request = inputSchema.parse(JSON.parse(line));
    if (request.type === 'authorization') {
      const target = authorizations.get(request.id);
      if (!target) return;
      authorizations.delete(request.id);
      if (request.allowed && request.authorization) target.resolve(request.authorization);
      else target.reject(Error('otel_permission_revoked'));
      return;
    }
    void invoke(request.method, request.input).then(
      (result) => {
        send({ type: 'result', id: request.id, result });
        if (request.method === 'close') {
          lines.close();
          process.stdin.destroy();
        }
      },
      (error) => {
        const code =
          error instanceof Error && /^otel_[a-z_]{1,80}$/.test(error.message)
            ? error.message
            : 'otel_request_failed';
        send({ type: 'error', id: request.id, code });
      },
    );
  } catch {
    send({ type: 'fatal', code: 'otel_protocol_invalid' });
    process.exitCode = 1;
    lines.close();
  }
});
lines.on('close', () => {
  if (store && !pump) store.close();
});
