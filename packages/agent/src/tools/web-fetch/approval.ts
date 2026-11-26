import type { Json, ToolDefinition } from '../../extensions';
import { grantDigest, grantScopeDigest } from '../../permission-grants';
import type { TrustedToolBehavior } from '../../tool-behavior';
import { type WebNetworkPolicy, webUrl } from './network';

export const webFetchOriginContract = 'builtin.web.exact-origin';

export function webFetchInitialOrigin(input: Json): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (Object.hasOwn(input, 'url') === Object.hasOwn(input, 'urls')) return;
  const urls = Array.isArray(input.urls) ? input.urls : [input.url];
  if (!urls.length || urls.some((url) => typeof url !== 'string')) return;
  try {
    const origins = new Set(urls.map((url) => webUrl(url as string).origin));
    return origins.size === 1 ? origins.values().next().value : undefined;
  } catch {
    return;
  }
}

export function createWebFetchToolBehavior(
  definition: ToolDefinition,
  configuration: Json,
  policy: WebNetworkPolicy,
): TrustedToolBehavior {
  const capability = {
    kind: 'tool' as const,
    definitionId: definition.id,
    definitionVersion: definition.version,
  };
  return {
    definition,
    capability,
    contractRef: webFetchOriginContract,
    configurationDigest: grantDigest(configuration),
    async grantOffers(request) {
      const origin = webFetchInitialOrigin(request.input);
      if (!origin || policy.mode === 'off') return [];
      const hostname = webUrl(origin)
        .hostname.replace(/^\[|\]$/g, '')
        .toLowerCase();
      if (
        policy.mode === 'allowlist' &&
        !policy.hosts.some((host) => host.toLowerCase() === hostname)
      )
        return [];
      const candidate = {
        ruleId: 'builtin.web.origin',
        contractId: webFetchOriginContract,
        scope: { origin },
        bindings: [capability],
        presentation: {
          label: '本会话内读取同一来源',
          details: [origin, '仅限相同协议、主机和端口；不允许跳转到其他来源。'],
        },
      };
      return [{ ...candidate, scopeDigest: grantScopeDigest(candidate) }];
    },
  };
}
