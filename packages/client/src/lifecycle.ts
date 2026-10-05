import { ClientError, decodeResponse, validateRequest } from './decode';
import type {
  ServiceLifecycle,
  ShutdownServiceRequest,
  ShutdownServiceResponse,
} from './generated/api';

export interface ServiceLifecycleClientOptions {
  readonly endpoint: string;
  readonly token: string;
  /** Selected before contacting this instance; never inferred from its response. */
  readonly expected: {
    readonly profile: ServiceLifecycle['profile'];
    readonly instanceId: string;
  };
}

/** Lifecycle admission is independent of business API compatibility and Store availability. */
export class ServiceLifecycleClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly expected: ServiceLifecycleClientOptions['expected'];
  private readonly controllers = new Set<AbortController>();
  private generation = 0;

  constructor(options: ServiceLifecycleClientOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new ClientError('invalid_endpoint');
    }
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== '/' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new ClientError('invalid_endpoint');
    this.endpoint = endpoint.origin;
    this.token = options.token;
    this.expected = structuredClone(options.expected);
    // Validate the original identity without performing I/O or granting business access.
    validateRequest('ShutdownServiceRequest', this.intent('if_idle'));
  }

  private intent(mode: ShutdownServiceRequest['mode']): ShutdownServiceRequest {
    return {
      lifecycleVersion: 1,
      expectedProfile: this.expected.profile,
      expectedInstanceId: this.expected.instanceId,
      mode,
    };
  }

  private admit(value: ServiceLifecycle): ServiceLifecycle {
    const expected = this.expected;
    if (
      value.instanceId !== expected.instanceId ||
      value.profile.dataRoot !== expected.profile.dataRoot ||
      value.profile.name !== expected.profile.name ||
      value.profile.accessKey !== expected.profile.accessKey
    )
      throw new ClientError('lifecycle_identity_mismatch');
    if (
      new Set(value.reasons).size !== value.reasons.length ||
      value.busy !== value.reasons.length > 0
    )
      throw new ClientError('invalid_response');
    return value;
  }

  private async request(
    path: string,
    body: ShutdownServiceRequest | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      reader = response.body?.getReader();
      if (!reader) throw new ClientError('invalid_response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 64 * 1024) throw new ClientError('response_too_large');
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new ClientError('invalid_response');
      }
      if (!response.ok) {
        const problem = decodeResponse('Problem', value);
        throw new ClientError(problem.code, problem.code, response.status, problem);
      }
      if (response.status !== (body ? 202 : 200)) throw new ClientError('invalid_response');
      return value;
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      this.controllers.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  async getStatus(options: { readonly signal?: AbortSignal } = {}): Promise<ServiceLifecycle> {
    return this.admit(
      decodeResponse(
        'ServiceLifecycle',
        await this.request('/v1/lifecycle', undefined, options.signal),
      ),
    );
  }

  /** One explicit intent, one POST. A lost response is queried with getStatus, never retried. */
  async shutdown(
    mode: ShutdownServiceRequest['mode'],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ShutdownServiceResponse> {
    const intent = this.intent(mode);
    validateRequest('ShutdownServiceRequest', intent);
    const generation = this.generation;
    await this.getStatus(options);
    if (generation !== this.generation) throw new ClientError('network_disposed');
    try {
      const result = decodeResponse(
        'ShutdownServiceResponse',
        await this.request('/v1/lifecycle/shutdown', intent, options.signal),
      );
      this.admit(result.lifecycle);
      if (!result.accepted || result.lifecycle.state === 'accepting')
        throw new ClientError('invalid_response');
      return result;
    } catch (error) {
      if (error instanceof ClientError && error.problem) throw error;
      throw new ClientError('network_outcome_unknown');
    }
  }

  /** Cancels this client's network requests only; never shuts down the Service. */
  disposeNetwork(): void {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
  }
}

export function createServiceLifecycleClient(
  options: ServiceLifecycleClientOptions,
): ServiceLifecycleClient {
  return new ServiceLifecycleClient(options);
}
