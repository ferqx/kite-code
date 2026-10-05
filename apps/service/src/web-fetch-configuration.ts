import {
  createPinnedWebNetworkPort,
  createWebFetchExtension,
  type PinnedWebNetworkOptions,
  type WebExtractor,
} from '@kite-ai/agent/web-fetch';
import type { CapabilityDescription } from './permissions';

export interface WebFetchConfigurationOptions {
  /** Trusted resource policy/admission only; never populated from JSONC/Tool input. */
  readonly network: PinnedWebNetworkOptions;
  readonly extractor?: WebExtractor;
}
/** Pure default registration helper. No DNS, parser Worker or socket until ordinary Tool dispatch. */
export function createWebFetchConfiguration(options: WebFetchConfigurationOptions) {
  const policy = structuredClone(options.network.policy);
  const extension = createWebFetchExtension({
    networkPort: createPinnedWebNetworkPort(options.network),
    ...(options.extractor ? { extractor: options.extractor } : {}),
  });
  const capabilities: CapabilityDescription[] = [
    {
      kind: 'tool',
      definitionId: 'web_fetch',
      definitionVersion: '1',
      revision: 'builtin.web:1',
      hardAllowed: policy.mode !== 'off',
      effects: ['network', 'unknown'],
      safeRead: false,
    },
  ];
  return {
    extension,
    capabilities,
    toolIds: ['web_fetch'] as readonly string[],
    snapshot: {
      definition: { id: 'web_fetch', version: '1' },
      policy,
      parsingBytes: 5_000_000,
      parser: 'passive-bounded-worker',
      completeByDefault: true,
    },
  };
}
