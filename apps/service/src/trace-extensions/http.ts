import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { engineDigest } from './engine/assets';
import type { TraceHost } from './host';
import { traceExtensionSchemas as schemas } from './schemas';
import { TraceHostError } from './types';

type FailureStatus = 400 | 403 | 404 | 409 | 413 | 429 | 503;
export interface TraceHttpRouteOptions {
  host?: TraceHost;
  /** Reuse Service's bounded body-reader custody with requireStoreId:false. */
  readBody<T>(request: Request, schema: z.ZodType<T>, maxBytes: number): Promise<T>;
  fail(code: string, status: FailureStatus): never;
}
/** Root middleware authenticates first. No caller-supplied subject, origin, vault ref or source reader. */
export function registerTraceExtensionRoutes(app: Hono, options: TraceHttpRouteOptions): void {
  const parameter = (context: Context, name: string) =>
    z.string().min(1).max(512).parse(context.req.param(name));
  const host = () => options.host ?? options.fail('capability_unavailable', 503);
  const action =
    (run: (context: Context) => Promise<Response> | Response) => async (context: Context) => {
      context.header('cache-control', 'no-store');
      context.header('x-content-type-options', 'nosniff');
      try {
        return await run(context);
      } catch (error) {
        if (error instanceof z.ZodError) return options.fail('invalid_request', 400);
        if (error instanceof TraceHostError) {
          const code = error.code;
          const status =
            code.includes('denied') || code.includes('revoked')
              ? 403
              : code.includes('limit') || code.includes('busy')
                ? 429
                : code === 'trace_installation_unavailable' ||
                    code === 'trace_partition_unavailable'
                  ? 404
                  : code.includes('invalid')
                    ? 400
                    : code.includes('stale') || code.includes('changed')
                      ? 409
                      : 503;
          return options.fail(code, status);
        }
        throw error;
      }
    };
  app.get(
    '/v1/trace/extensions',
    action((context) =>
      context.json(
        schemas.TraceInstallationList.parse({ installations: host().listInstallations() }),
      ),
    ),
  );
  app.post(
    '/v1/trace/integrations/opentelemetry/install',
    action(async (context) => {
      const input = await options.readBody(context.req.raw, schemas.TraceOtelInstallRequest, 8192);
      return context.json({ installationId: host().installOtelIntegration(input) }, 201);
    }),
  );
  app.post(
    '/v1/trace/extensions/validate',
    action(async (context) => {
      host();
      const input = await options.readBody(
        context.req.raw,
        schemas.TraceInstallRequest,
        2 * 1024 * 1024,
      );
      const digest = engineDigest(input.bundle.source);
      if (digest !== input.bundle.sha256 || Buffer.byteLength(input.bundle.source) > 512 * 1024)
        options.fail('trace_bundle_invalid', 400);
      return context.json({ valid: true as const, digest });
    }),
  );
  app.post(
    '/v1/trace/extensions/install',
    action(async (context) => {
      const input = await options.readBody(
        context.req.raw,
        schemas.TraceInstallRequest,
        2 * 1024 * 1024,
      );
      return context.json({ installationId: host().install(input.manifest, input.bundle) }, 201);
    }),
  );
  app.get(
    '/v1/trace/extensions/:installationId',
    action((context) =>
      context.json(
        schemas.TraceInstallation.parse(
          host().inspectInstallation(parameter(context, 'installationId')),
        ),
      ),
    ),
  );
  app.get(
    '/v1/trace/extensions/:installationId/delivery',
    action(async (context) =>
      context.json(
        schemas.TraceRemoteDeliveryStatus.parse(
          await host().deliveryStatus(parameter(context, 'installationId'), context.req.raw.signal),
        ),
      ),
    ),
  );
  app.post(
    '/v1/trace/extensions/:installationId/configure',
    action(async (context) => {
      const input = await options.readBody(context.req.raw, schemas.TraceConfigureRequest, 8192),
        id = parameter(context, 'installationId');
      host().configure(id, input.settings);
      return context.json(schemas.TraceInstallation.parse(host().inspectInstallation(id)));
    }),
  );
  app.post(
    '/v1/trace/extensions/:installationId/grant',
    action(async (context) => {
      const input = await options.readBody(context.req.raw, schemas.TraceGrantRequest, 32768),
        id = parameter(context, 'installationId');
      await host().authorize(id, input);
      return context.json(schemas.TraceInstallation.parse(host().inspectInstallation(id)));
    }),
  );
  for (const method of ['enable', 'disable', 'revoke', 'uninstall'] as const)
    app.post(
      `/v1/trace/extensions/:installationId/${method}`,
      action(async (context) => {
        await options.readBody(context.req.raw, schemas.TraceAction, 1024);
        await host()[method](parameter(context, 'installationId'));
        return context.json({ completed: true as const });
      }),
    );
  app.post(
    '/v1/trace/extensions/:installationId/update',
    action(async (context) => {
      const input = await options.readBody(
          context.req.raw,
          schemas.TraceInstallRequest,
          2 * 1024 * 1024,
        ),
        id = parameter(context, 'installationId');
      await host().update(id, input.manifest, input.bundle);
      return context.json(schemas.TraceInstallation.parse(host().inspectInstallation(id)));
    }),
  );
  app.post(
    '/v1/trace/extensions/:installationId/history',
    action(async (context) => {
      const input = await options.readBody(context.req.raw, schemas.TraceHistoryRequest, 8192);
      return context.json({
        partitionId: await host().startHistoryExport(
          parameter(context, 'installationId'),
          input,
          context.req.raw.signal,
        ),
      });
    }),
  );
  app.get(
    '/v1/trace/extensions/:installationId/partitions/:partitionId',
    action((context) =>
      context.json(
        schemas.TracePartitionStatus.parse(
          host().partition(parameter(context, 'installationId'), parameter(context, 'partitionId')),
        ),
      ),
    ),
  );
  app.get(
    '/v1/trace/extensions/:installationId/partitions/:partitionId/dead-letters',
    action((context) =>
      context.json(
        schemas.TraceDeadLetterList.parse({
          entries: host().deadLetters(
            parameter(context, 'installationId'),
            parameter(context, 'partitionId'),
          ),
        }),
      ),
    ),
  );
  for (const method of ['retry', 'cancel', 'pause', 'resume'] as const)
    app.post(
      `/v1/trace/extensions/:installationId/partitions/:partitionId/${method}`,
      action(async (context) => {
        await options.readBody(context.req.raw, schemas.TraceAction, 1024);
        const id = parameter(context, 'installationId'),
          partition = parameter(context, 'partitionId');
        if (method === 'retry') host().retryDeadLetter(id, partition);
        else if (method === 'cancel') await host().cancelHistoryExport(id, partition);
        else if (method === 'pause') await host().pauseHistoryExport(id, partition);
        else host().resumeHistoryExport(id, partition);
        return context.json({ completed: true as const });
      }),
    );
  app.post(
    '/v1/trace/extensions/:installationId/credentials/bind',
    action(async (context) => {
      const input = await options.readBody(context.req.raw, schemas.TraceCredentialBind, 16384);
      return context.json(
        schemas.TraceCredentialResult.parse(
          await host().bindCredential(
            parameter(context, 'installationId'),
            input.origin,
            input.secret,
          ),
        ),
      );
    }),
  );
  app.post(
    '/v1/trace/extensions/:installationId/credentials/revoke',
    action(async (context) => {
      const input = await options.readBody(context.req.raw, schemas.TraceCredentialRevoke, 1024);
      await host().revokeCredential(parameter(context, 'installationId'), input.handle);
      return context.json({ completed: true as const });
    }),
  );
}
