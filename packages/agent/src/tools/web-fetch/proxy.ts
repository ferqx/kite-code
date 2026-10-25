import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { WebFetchError } from './network-errors';

export interface WebProxySettings {
  readonly http?: string;
  readonly https?: string;
  readonly noProxy?: string;
}
export function proxyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebFetchError('web_proxy_invalid');
  }
  if (url.username || url.password) throw new WebFetchError('web_proxy_auth_unsupported');
  if (!['http:', 'https:'].includes(url.protocol))
    throw new WebFetchError('web_proxy_protocol_unsupported');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new WebFetchError('web_proxy_invalid');
  return url.origin;
}
export function selectedProxy(
  settings: WebProxySettings | undefined,
  target: URL,
): string | undefined {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const raw of settings?.noProxy?.split(/[;,]/) ?? []) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*' || (entry === '<local>' && !host.includes('.') && !host.includes(':')))
      return;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match || (match[2] && match[2] !== port)) continue;
    const name = match[1]!.replace(/^\[|\]$/g, '').replace(/^\*?\./, '');
    if (host === name || host.endsWith(`.${name}`)) return;
  }
  return target.protocol === 'https:' ? settings?.https : settings?.http;
}

/** CONNECT names only an already verified IP. Proxy credentials/redirects never reach the target. */
export async function openProxyTunnel(
  proxy: string,
  target: URL,
  address: string,
  signal: AbortSignal,
  ca?: string,
): Promise<Socket> {
  signal.throwIfAborted();
  const endpoint = new URL(proxy);
  const authority = `${address.includes(':') ? `[${address}]` : address}:${target.port || (target.protocol === 'https:' ? '443' : '80')}`;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const agent =
      endpoint.protocol === 'https:'
        ? new HttpsAgent({ keepAlive: false, proxyEnv: {}, ...(ca ? { ca } : {}) })
        : new HttpAgent({ keepAlive: false, proxyEnv: {} });
    const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      agent,
      maxHeaderSize: 16384,
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    });
    let tunnel: Socket | undefined;
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      tunnel?.destroy();
      request.destroy();
      agent.destroy();
      reject(signal.aborted ? signal.reason : new WebFetchError('web_proxy_connect_failed'));
    };
    const abort = () => fail();
    signal.addEventListener('abort', abort, { once: true });
    request.once('error', fail);
    request.once('response', (response) => {
      response.destroy();
      fail();
    });
    request.once('connect', (response, connected, head) => {
      tunnel = connected;
      connected.on('error', () => {});
      connected.once('close', () => agent.destroy());
      if (response.statusCode !== 200 || head.length || signal.aborted) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      resolve(connected);
    });
    if (signal.aborted) fail();
    else request.end();
  });
  if (target.protocol !== 'https:') return socket;
  return new Promise<Socket>((resolve, reject) => {
    const secure = tlsConnect({
      socket,
      servername: target.hostname.replace(/^\[|\]$/g, ''),
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    });
    const abort = () => {
      signal.removeEventListener('abort', abort);
      secure.destroy();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    secure.once('error', () => {
      signal.removeEventListener('abort', abort);
      secure.destroy();
      reject(signal.aborted ? signal.reason : new WebFetchError('web_tls_failed'));
    });
    secure.once('secureConnect', () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
      else resolve(secure);
    });
    if (signal.aborted) abort();
  });
}
