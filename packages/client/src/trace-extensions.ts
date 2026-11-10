import { ClientError, type Responses, validateRequest } from './decode';
import type * as API from './generated/api';

type Options = { signal?: AbortSignal };
export interface TraceExtensionTransport {
  request<K extends keyof Responses>(
    path: string,
    response: K,
    body: unknown | undefined,
    signal?: AbortSignal,
  ): Promise<Responses[K]>;
}
const installationPath = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new ClientError('invalid_request');
  return `/v1/trace/extensions/${encodeURIComponent(id)}`;
};
const partitionPath = (installationId: string, partitionId: string) => {
  if (!partitionId || partitionId.length > 512) throw new ClientError('invalid_request');
  return `${installationPath(installationId)}/partitions/${encodeURIComponent(partitionId)}`;
};
/** Trace management has explicit operations and never retries a mutation with an unknown outcome. */
export class TraceExtensionClient {
  private readonly transport: TraceExtensionTransport;
  constructor(transport: TraceExtensionTransport) {
    this.transport = transport;
  }
  private body<T>(shape: Parameters<typeof validateRequest>[0], input: T): T {
    const value = structuredClone(input);
    validateRequest(shape, value);
    return value;
  }
  list(options: Options = {}) {
    return this.transport.request(
      '/v1/trace/extensions',
      'TraceInstallationList',
      undefined,
      options.signal,
    );
  }
  inspect(id: string, options: Options = {}) {
    return this.transport.request(
      installationPath(id),
      'TraceInstallation',
      undefined,
      options.signal,
    );
  }
  delivery(id: string, options: Options = {}) {
    return this.transport.request(
      `${installationPath(id)}/delivery`,
      'TraceRemoteDeliveryStatus',
      undefined,
      options.signal,
    );
  }
  validate(input: API.TraceInstallRequest, options: Options = {}) {
    return this.transport.request(
      '/v1/trace/extensions/validate',
      'TraceBundleValidation',
      this.body('TraceInstallRequest', input),
      options.signal,
    );
  }
  install(input: API.TraceInstallRequest, options: Options = {}) {
    return this.transport.request(
      '/v1/trace/extensions/install',
      'TraceInstallResult',
      this.body('TraceInstallRequest', input),
      options.signal,
    );
  }
  installOpenTelemetry(input: API.TraceOtelInstallRequest, options: Options = {}) {
    return this.transport.request(
      '/v1/trace/integrations/opentelemetry/install',
      'TraceInstallResult',
      this.body('TraceOtelInstallRequest', input),
      options.signal,
    );
  }
  configure(id: string, input: API.TraceConfigureRequest, options: Options = {}) {
    return this.transport.request(
      `${installationPath(id)}/configure`,
      'TraceInstallation',
      this.body('TraceConfigureRequest', input),
      options.signal,
    );
  }
  grant(id: string, input: API.TraceGrantRequest, options: Options = {}) {
    return this.transport.request(
      `${installationPath(id)}/grant`,
      'TraceInstallation',
      this.body('TraceGrantRequest', input),
      options.signal,
    );
  }
  update(id: string, input: API.TraceInstallRequest, options: Options = {}) {
    return this.transport.request(
      `${installationPath(id)}/update`,
      'TraceInstallation',
      this.body('TraceInstallRequest', input),
      options.signal,
    );
  }
  action(id: string, action: 'enable' | 'disable' | 'revoke' | 'uninstall', options: Options = {}) {
    if (!['enable', 'disable', 'revoke', 'uninstall'].includes(action))
      throw new ClientError('invalid_request');
    return this.transport.request(
      `${installationPath(id)}/${action}`,
      'TraceActionResult',
      {},
      options.signal,
    );
  }
  history(id: string, input: API.TraceHistoryRequest, options: Options = {}) {
    return this.transport.request(
      `${installationPath(id)}/history`,
      'TraceHistoryResult',
      this.body('TraceHistoryRequest', input),
      options.signal,
    );
  }
  partition(id: string, partitionId: string, options: Options = {}) {
    return this.transport.request(
      partitionPath(id, partitionId),
      'TracePartitionStatus',
      undefined,
      options.signal,
    );
  }
  deadLetters(id: string, partitionId: string, options: Options = {}) {
    return this.transport.request(
      `${partitionPath(id, partitionId)}/dead-letters`,
      'TraceDeadLetterList',
      undefined,
      options.signal,
    );
  }
  partitionAction(
    id: string,
    partitionId: string,
    action: 'retry' | 'cancel' | 'pause' | 'resume',
    options: Options = {},
  ) {
    if (!['retry', 'cancel', 'pause', 'resume'].includes(action))
      throw new ClientError('invalid_request');
    return this.transport.request(
      `${partitionPath(id, partitionId)}/${action}`,
      'TraceActionResult',
      {},
      options.signal,
    );
  }
  bindCredential(id: string, input: API.TraceCredentialBind, options: Options = {}) {
    return this.transport.request(
      `${installationPath(id)}/credentials/bind`,
      'TraceCredentialResult',
      this.body('TraceCredentialBind', input),
      options.signal,
    );
  }
  revokeCredential(id: string, input: API.TraceCredentialRevoke, options: Options = {}) {
    return this.transport.request(
      `${installationPath(id)}/credentials/revoke`,
      'TraceActionResult',
      this.body('TraceCredentialRevoke', input),
      options.signal,
    );
  }
}
