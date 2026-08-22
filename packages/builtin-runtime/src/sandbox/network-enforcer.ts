import { createHash, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { canonicalNetworkHostname, type NetworkBoundaryPolicyV1 } from './network-policy';

export type NetworkBoundaryFailureCode =
  | 'network_off'
  | 'invalid_url'
  | 'protocol_denied'
  | 'credentials_denied'
  | 'host_not_allowlisted'
  | 'ip_literal_denied'
  | 'dns_unavailable'
  | 'private_or_reserved_address'
  | 'endpoint_revision_mismatch'
  | 'redirect_denied'
  | 'request_body_too_large'
  | 'response_body_too_large'
  | 'controller_unavailable';

export class NetworkBoundaryError extends Error {
  readonly code: NetworkBoundaryFailureCode;

  constructor(code: NetworkBoundaryFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkBoundaryError';
    this.code = code;
  }
}

export interface NetworkResolvedAddressV1 {
  address: string;
  family: 4 | 6;
}

export interface NetworkAdmissionReceiptV1 {
  version: 1;
  outcome: 'allowed';
  toolCallId: string;
  invocationId: string;
  hop: number;
  policyRevision: string;
  canonicalOrigin: string;
  host: string;
  address: string;
  family: 4 | 6;
  endpointRevision: string;
  expectedEndpointRevision?: string;
  receiptDigest: string;
}

export interface NetworkDenialReceiptV1 {
  version: 1;
  outcome: 'denied';
  toolCallId: string;
  invocationId: string;
  hop: number;
  policyRevision: string;
  canonicalOrigin: string;
  host: string;
  failureCode: NetworkBoundaryFailureCode;
  expectedEndpointRevision?: string;
  receiptDigest: string;
}

export type NetworkDecisionReceiptV1 = NetworkAdmissionReceiptV1 | NetworkDenialReceiptV1;
export type NetworkDecisionRecorderV1 = (
  decision: NetworkDecisionReceiptV1,
) => void | Promise<void>;

export type NetworkResolverV1 = (hostname: string) => Promise<readonly NetworkResolvedAddressV1[]>;

export interface NetworkBoundaryEnforcerV1 {
  readonly policy: NetworkBoundaryPolicyV1;
  admit(input: {
    url: string | URL;
    toolCallId: string;
    invocationId: string;
    hop: number;
    expectedEndpointRevision?: string;
  }): Promise<NetworkAdmissionReceiptV1>;
}

export function createNetworkBoundaryEnforcerV1(
  policy: NetworkBoundaryPolicyV1,
  resolver: NetworkResolverV1 = resolveNetworkAddresses,
  recordDecision?: NetworkDecisionRecorderV1,
): NetworkBoundaryEnforcerV1 {
  const allowedHosts = new Set(policy.allowedHosts.map(canonicalNetworkHostname));
  return {
    policy,
    async admit(input) {
      let admission: NetworkAdmissionReceiptV1;
      try {
        admission = await admitNetworkEndpoint(policy, allowedHosts, resolver, input);
      } catch (error) {
        const boundaryError =
          error instanceof NetworkBoundaryError
            ? error
            : new NetworkBoundaryError(
                'controller_unavailable',
                'Network admission controller is unavailable.',
                { cause: error },
              );
        try {
          await recordDecision?.(denialReceipt(policy, input, boundaryError.code));
        } catch (recordError) {
          throw new NetworkBoundaryError(
            'controller_unavailable',
            'Network denial decision could not be persisted.',
            { cause: recordError },
          );
        }
        throw boundaryError;
      }
      try {
        await recordDecision?.(admission);
      } catch (error) {
        throw new NetworkBoundaryError(
          'controller_unavailable',
          'Network admission decision could not be persisted.',
          { cause: error },
        );
      }
      return admission;
    },
  };
}

async function admitNetworkEndpoint(
  policy: NetworkBoundaryPolicyV1,
  allowedHosts: ReadonlySet<string>,
  resolver: NetworkResolverV1,
  input: {
    url: string | URL;
    toolCallId: string;
    invocationId: string;
    hop: number;
    expectedEndpointRevision?: string;
  },
): Promise<NetworkAdmissionReceiptV1> {
  if (policy.mode === 'off') {
    throw new NetworkBoundaryError('network_off', 'Network access is disabled by policy.');
  }

  const url = parseNetworkUrl(input.url);
  if (url.username || url.password) {
    throw new NetworkBoundaryError(
      'credentials_denied',
      'Network targets with embedded credentials are denied.',
    );
  }
  const host = canonicalNetworkHostname(url.hostname);
  if (isIP(host) !== 0 || isBracketedIpLiteral(host)) {
    throw new NetworkBoundaryError(
      'ip_literal_denied',
      'IP-literal network targets are denied by the host allowlist.',
    );
  }
  if (METADATA_HOSTS.has(host)) {
    throw new NetworkBoundaryError(
      'private_or_reserved_address',
      `Network host '${host}' is a reserved metadata endpoint.`,
    );
  }
  if (!allowedHosts.has(host)) {
    throw new NetworkBoundaryError(
      'host_not_allowlisted',
      `Network host '${host}' is not in the execution allowlist.`,
    );
  }

  let resolved: readonly NetworkResolvedAddressV1[];
  try {
    resolved = await resolver(host);
  } catch (error) {
    if (error instanceof NetworkBoundaryError) throw error;
    throw new NetworkBoundaryError(
      'controller_unavailable',
      'Network admission controller is unavailable.',
      { cause: error },
    );
  }
  const addresses = normalizeResolvedAddresses(resolved);
  if (addresses.length === 0) {
    throw new NetworkBoundaryError(
      'dns_unavailable',
      `DNS returned no usable address for '${host}'.`,
    );
  }
  const denied = addresses.find((entry) => !isPublicNetworkAddress(entry.address));
  if (denied) {
    throw new NetworkBoundaryError(
      'private_or_reserved_address',
      `DNS for '${host}' resolved to a private or reserved address.`,
    );
  }

  const selected = addresses[0]!;
  const endpointRevision = digest({
    policyRevision: policy.revision,
    host,
    addresses,
  });
  if (input.expectedEndpointRevision && input.expectedEndpointRevision !== endpointRevision) {
    throw new NetworkBoundaryError(
      'endpoint_revision_mismatch',
      'The resolved network endpoint revision changed before dispatch.',
    );
  }
  const receipt = {
    version: 1 as const,
    outcome: 'allowed' as const,
    toolCallId: input.toolCallId,
    invocationId: input.invocationId,
    hop: input.hop,
    policyRevision: policy.revision,
    canonicalOrigin: url.origin,
    host,
    address: selected.address,
    family: selected.family,
    endpointRevision,
    ...(input.expectedEndpointRevision
      ? { expectedEndpointRevision: input.expectedEndpointRevision }
      : {}),
  };
  return {
    ...receipt,
    receiptDigest: digest(receipt),
  };
}

const METADATA_HOSTS = new Set(['metadata.google.internal', 'instance-data.ec2.internal']);

function isBracketedIpLiteral(host: string): boolean {
  return host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) !== 0;
}

function denialReceipt(
  policy: NetworkBoundaryPolicyV1,
  input: {
    url: string | URL;
    toolCallId: string;
    invocationId: string;
    hop: number;
    expectedEndpointRevision?: string;
  },
  failureCode: NetworkBoundaryFailureCode,
): NetworkDenialReceiptV1 {
  const target = safeNetworkAuthority(input.url);
  const receipt = {
    version: 1 as const,
    outcome: 'denied' as const,
    toolCallId: input.toolCallId,
    invocationId: input.invocationId,
    hop: input.hop,
    policyRevision: policy.revision,
    canonicalOrigin: target.origin,
    host: target.host,
    failureCode,
    ...(input.expectedEndpointRevision
      ? { expectedEndpointRevision: input.expectedEndpointRevision }
      : {}),
  };
  return { ...receipt, receiptDigest: digest(receipt) };
}

function safeNetworkAuthority(input: string | URL): { origin: string; host: string } {
  try {
    const url = input instanceof URL ? input : new URL(input);
    return {
      origin: url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : 'invalid',
      host: canonicalNetworkHostname(url.hostname),
    };
  } catch {
    return { origin: 'invalid', host: 'invalid' };
  }
}

export interface NetworkBoundaryFetchOptionsV1 {
  resolver?: NetworkResolverV1;
  onAdmission?: (receipt: NetworkAdmissionReceiptV1) => void;
  recordDecision?: NetworkDecisionRecorderV1;
  toolCallId?: string;
  expectedEndpointRevision?: string;
  invocationIdFactory?: () => string;
  request?: PinnedNetworkRequestV1;
  maxRedirects?: number;
}

export type PinnedNetworkRequestV1 = (input: {
  url: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
  admission: NetworkAdmissionReceiptV1;
}) => Promise<Response>;

/**
 * Fetch implementation that resolves and admits every hop, then pins the
 * socket lookup to the admitted address. It never trusts proxy environment
 * variables and never lets the transport perform an unchecked redirect.
 */
export function createNetworkBoundaryFetchV1(
  policy: NetworkBoundaryPolicyV1,
  options: NetworkBoundaryFetchOptionsV1 = {},
): typeof fetch {
  const enforcer = createNetworkBoundaryEnforcerV1(
    policy,
    options.resolver,
    options.recordDecision,
  );
  const request = options.request ?? requestPinnedNetworkEndpoint;
  const maxRedirects = normalizeMaxRedirects(options.maxRedirects);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const invocationId = options.invocationIdFactory?.() ?? randomUUID();
    let normalized = await normalizeFetchRequest(input, init);
    let hop = 0;
    while (true) {
      const admission = await enforcer.admit({
        url: normalized.url,
        toolCallId: options.toolCallId ?? invocationId,
        invocationId,
        hop,
        expectedEndpointRevision: options.expectedEndpointRevision,
      });
      try {
        options.onAdmission?.(admission);
      } catch (error) {
        throw new NetworkBoundaryError(
          'controller_unavailable',
          'Network admission observer failed before dispatch.',
          { cause: error },
        );
      }
      const response = await request({
        ...normalized,
        headers: authoritativeRequestHeaders(normalized.headers, normalized.url),
        admission,
      });
      if (!isRedirectResponse(response)) return response;

      const location = response.headers.get('location');
      if (!location || normalized.redirect === 'manual') return response;
      if (normalized.redirect === 'error') {
        await response.body?.cancel();
        throw new NetworkBoundaryError('redirect_denied', 'Network redirect is denied by policy.');
      }
      if (hop >= maxRedirects) {
        await response.body?.cancel();
        throw new NetworkBoundaryError(
          'redirect_denied',
          `Network redirect limit exceeded (${maxRedirects}).`,
        );
      }

      const target = new URL(location, normalized.url);
      await response.body?.cancel();
      normalized = redirectRequest(normalized, target, response.status);
      hop += 1;
    }
  }) as typeof fetch;
}

async function resolveNetworkAddresses(
  hostname: string,
): Promise<readonly NetworkResolvedAddressV1[]> {
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses.flatMap((entry) =>
      entry.family === 4 || entry.family === 6
        ? [{ address: entry.address, family: entry.family }]
        : [],
    );
  } catch (error) {
    throw new NetworkBoundaryError('dns_unavailable', `DNS lookup failed for '${hostname}'.`, {
      cause: error,
    });
  }
}

function parseNetworkUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch (error) {
    throw new NetworkBoundaryError('invalid_url', 'Network target is not a valid URL.', {
      cause: error,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkBoundaryError(
      'protocol_denied',
      `Network protocol '${url.protocol}' is denied.`,
    );
  }
  return url;
}

function normalizeResolvedAddresses(
  addresses: readonly NetworkResolvedAddressV1[],
): NetworkResolvedAddressV1[] {
  const unique = new Map<string, NetworkResolvedAddressV1>();
  for (const entry of addresses) {
    const family = isIP(entry.address);
    if (family !== 4 && family !== 6) continue;
    unique.set(`${family}:${entry.address}`, { address: entry.address, family });
  }
  return [...unique.values()].sort(
    (left, right) => left.family - right.family || left.address.localeCompare(right.address),
  );
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Value(address);
  if (value === null) return false;
  return ![
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([network, prefix]) => ipv4InCidr(value, network as string, prefix as number));
}

function ipv4Value(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function ipv4InCidr(value: number, network: string, prefix: number): boolean {
  const networkValue = ipv4Value(network);
  if (networkValue === null) return true;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (networkValue & mask);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  if (value === null) return false;
  // Only ordinary global-unicast space is accepted. Translation, mapped,
  // compatible, ULA, link-local, multicast and other special-purpose ranges
  // are rejected instead of trying to infer a safe embedded destination.
  if (!ipv6InCidr(value, '2000::', 3)) return false;
  return ![
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
  ].some(([network, prefix]) => ipv6InCidr(value, network as string, prefix as number));
}

function normalizeMaxRedirects(value: number | undefined): number {
  const resolved = value ?? 10;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 20) {
    throw new NetworkBoundaryError(
      'redirect_denied',
      'Network redirect limit must be an integer between 0 and 20.',
    );
  }
  return resolved;
}

function ipv6Value(address: string): bigint | null {
  let normalized = address.toLowerCase().split('%', 1)[0]!;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = ipv4Value(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(value: bigint, network: string, prefix: number): boolean {
  const networkValue = ipv6Value(network);
  if (networkValue === null) return true;
  const shift = BigInt(128 - prefix);
  return value >> shift === networkValue >> shift;
}

interface NormalizedFetchRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
  redirect: RequestRedirect;
}

const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

async function normalizeFetchRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<NormalizedFetchRequest> {
  const request = new Request(input, { ...init, redirect: 'manual' });
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  if ((body?.byteLength ?? 0) > MAX_REQUEST_BODY_BYTES) {
    throw new NetworkBoundaryError(
      'request_body_too_large',
      `Network request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`,
    );
  }
  return {
    url: parseNetworkUrl(request.url),
    method: request.method,
    headers: new Headers(request.headers),
    body,
    signal: init?.signal ?? request.signal,
    redirect: init?.redirect ?? 'follow',
  };
}

function redirectRequest(
  current: NormalizedFetchRequest,
  target: URL,
  status: number,
): NormalizedFetchRequest {
  const headers = new Headers(current.headers);
  let method = current.method;
  let body = current.body;
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    method = 'GET';
    body = undefined;
    headers.delete('content-length');
    headers.delete('content-type');
  }
  if (current.url.origin !== target.origin) {
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('proxy-authorization');
  }
  return { ...current, url: parseNetworkUrl(target), method, body, headers };
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function authoritativeRequestHeaders(headers: Headers, url: URL): Headers {
  const authoritative = new Headers(headers);
  authoritative.delete('host');
  authoritative.set('host', url.host);
  return authoritative;
}

async function requestPinnedNetworkEndpoint(
  input: Parameters<PinnedNetworkRequestV1>[0],
): Promise<Response> {
  if (input.signal?.aborted) throw abortError(input.signal.reason);
  const request = input.url.protocol === 'https:' ? requestHttps : requestHttp;
  const requestHeaders = authoritativeRequestHeaders(input.headers, input.url);
  return await new Promise<Response>((resolve, reject) => {
    const abort = () => requestHandle.destroy(abortError(input.signal?.reason));
    const requestHandle = request(
      input.url,
      {
        method: input.method,
        headers: Object.fromEntries(requestHeaders.entries()),
        // The boundary deliberately returns only the admitted address. Bun's
        // Node-compatible client asks custom lookups for an `all: true` result,
        // while Node may ask for the ordinary scalar form.
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) {
            (
              callback as unknown as (
                error: Error | null,
                addresses: { address: string; family: number }[],
              ) => void
            )(null, [{ address: input.admission.address, family: input.admission.family }]);
            return;
          }
          callback(null, input.admission.address, input.admission.family);
        },
      },
      (incoming) => {
        const removeAbortListener = () => input.signal?.removeEventListener('abort', abort);
        incoming.once('close', removeAbortListener);
        incoming.once('end', removeAbortListener);
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name && value) headers.append(name, value);
        }
        const response = new Response(
          Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
          {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers,
          },
        );
        Object.defineProperty(response, 'url', { value: input.url.href });
        resolve(response);
      },
    );
    input.signal?.addEventListener('abort', abort, { once: true });
    requestHandle.on('error', (error) => {
      input.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    if (input.body) requestHandle.write(input.body);
    requestHandle.end();
  });
}

function abortError(reason: unknown): DOMException {
  return new DOMException(reason instanceof Error ? reason.message : 'Aborted', 'AbortError');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
