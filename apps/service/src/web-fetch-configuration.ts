import { createHash } from 'node:crypto';
import { builtinCapability, type CapabilityDescription } from '@kite-ai/agent/permissions';
import {
  createPinnedWebNetworkPort,
  createWebFetchBindingFactory,
  type PinnedWebNetworkOptions,
  type WebExtractor,
  WebFetchError,
} from '@kite-ai/agent/web-fetch';

export interface WebFetchConfigurationOptions {
  /** Host policy/admission; Service may merge validated user transport, never project/Tool input. */
  readonly network: PinnedWebNetworkOptions;
  readonly extractor?: WebExtractor;
  readonly unavailableReason?: string;
}
/** Pure default registration helper. No DNS, parser Worker or socket until ordinary Tool dispatch. */
export function createWebFetchConfiguration(options: WebFetchConfigurationOptions) {
  const policy = structuredClone(options.network.policy);
  const pinned = createPinnedWebNetworkPort(options.network);
  const factory = createWebFetchBindingFactory({
    networkPort: options.unavailableReason
      ? {
          async request() {
            throw new WebFetchError(options.unavailableReason!);
          },
        }
      : pinned,
    ...(options.extractor ? { extractor: options.extractor } : {}),
  });
  const extension = factory.extension;
  const capabilities: CapabilityDescription[] = [
    {
      kind: 'tool',
      definitionId: 'web_fetch',
      definitionVersion: '1',
      revision: 'builtin.web:1',
      hardAllowed: policy.mode !== 'off',
      ...builtinCapability(
        extension.id,
        'web_fetch',
        'tool',
        '',
        extension.tools?.find((tool) => tool.id === 'web_fetch')?.version,
      ),
    },
  ];
  return {
    extension,
    bind: factory.bind,
    capabilities,
    toolIds: ['web_fetch'] as readonly string[],
    snapshot: {
      definition: { id: 'web_fetch', version: '1' },
      policy,
      parsingBytes: 5_000_000,
      parser: 'passive-bounded-worker',
      completeByDefault: true,
      defaultTimeoutMs: factory.defaultTimeoutMs,
      // Keep legacy custom-host snapshots stable when no transport was selected.
      ...(options.network.proxy ||
      options.network.dnsOverHttps ||
      options.network.recoverFakeIp ||
      options.network.certificateAuthority ||
      options.unavailableReason
        ? {
            transport: {
              proxy: structuredClone(options.network.proxy ?? {}),
              dns: options.network.dnsOverHttps
                ? structuredClone(options.network.dnsOverHttps)
                : null,
              recoverFakeIp: options.network.recoverFakeIp === true,
              resolver: 'cloudflare-doh-wire-1',
              ...(options.network.certificateAuthority
                ? {
                    certificateAuthorityHash: createHash('sha256')
                      .update(options.network.certificateAuthority)
                      .digest('hex'),
                  }
                : {}),
              ...(options.unavailableReason
                ? { unavailableReason: options.unavailableReason }
                : {}),
            },
          }
        : {}),
    },
  };
}
