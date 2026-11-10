import {
  type TraceConsumer,
  type TrustedTraceConsumerInput,
  traceConsumerInspectionSchema,
} from '../../trace-extensions/consumer';
import {
  createOtelIntegration,
  type OtelAdapterAssets,
  otelIntegrationConfigSchema,
} from './index';

/** Service-injected binding only. An arbitrary extension manifest cannot select this factory. */
export async function createOtelConsumer(
  input: TrustedTraceConsumerInput,
  options: { path: string; assets: OtelAdapterAssets },
): Promise<TraceConsumer> {
  const config = otelIntegrationConfigSchema.parse(input.settings);
  const integration = await createOtelIntegration({
    installationId: input.installationId,
    path: options.path,
    endpoint: config.endpoint,
    grant: { revision: input.grant.revision, epoch: input.grant.epoch, active: input.grant.active },
    sampleRate: config.sampleRate,
    assets: options.assets,
    authorizeSend: (request, signal) =>
      input.authorizeSend(request.taskId, request.endpoint, signal, config.credentialHandle),
  });
  return {
    generation: input.generation,
    async initialize(_value, signal) {
      signal?.throwIfAborted();
    },
    async onEvents(batch, signal) {
      signal?.throwIfAborted();
      const result = await integration.accept(batch);
      signal?.throwIfAborted();
      return result;
    },
    async retire() {
      await integration.close();
      return integration.readExitEvidence();
    },
    pump: () => integration.pump(),
    cancelTask: (taskId) => integration.cancelTask(taskId),
    setGrant: (stamp) => integration.setGrant(stamp),
    inspect: async () => traceConsumerInspectionSchema.parse(await integration.inspect()),
  };
}
