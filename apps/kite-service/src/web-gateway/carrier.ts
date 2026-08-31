import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { createWebGatewayAuth, type WebGatewaySessionRegistry } from './auth';

export const KITE_WEB_LOOPBACK_HOST = '127.0.0.1' as const;

const DEFAULT_DRAIN_DEADLINE_MS = 1_000;
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

type RequestIp = Readonly<{ address: string }> | null;
type SocketData = undefined;

export type WebGatewayDiagnosticCode = 'request_rejected' | 'drain_timeout';

export interface WebGatewayLimits {
  readonly drainDeadlineMs?: number;
}

export type WebGatewayAssetReader = (absolutePath: string) => Promise<Response | undefined>;

export interface WebGatewayCarrierOptions {
  readonly staticAssetRoot: string;
  readonly instanceId: string;
  readonly limits?: WebGatewayLimits;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxSessions?: number;
  readonly readAsset?: WebGatewayAssetReader;
  readonly requestIp?: (request: Request, server: Bun.Server<SocketData>) => RequestIp;
  readonly serve?: typeof Bun.serve;
  readonly onDiagnostic?: (code: WebGatewayDiagnosticCode) => void;
}

export interface WebGatewayCarrier extends AsyncDisposable {
  readonly origin: string;
  readonly browserAuth: WebGatewaySessionRegistry;
  close(): Promise<void>;
}

/** Static Web asset and in-memory Browser-session owner; all business data uses `/v1`. */
export function createWebGatewayCarrier(options: WebGatewayCarrierOptions): WebGatewayCarrier {
  const staticRoot = options.readAsset
    ? resolve(options.staticAssetRoot)
    : secureStaticAssetRoot(options.staticAssetRoot);
  const readAsset = options.readAsset ?? defaultAssetReader;
  const drainDeadlineMs = boundedDeadline(options.limits?.drainDeadlineMs);
  let closed = false;
  let closing: Promise<void> | undefined;
  let auth!: ReturnType<typeof createWebGatewayAuth>;
  const server = (options.serve ?? Bun.serve)<SocketData>({
    hostname: KITE_WEB_LOOPBACK_HOST,
    port: 0,
    development: false,
    async fetch(request, activeServer) {
      if (closed || !activeServer.port) return secureResponse(503, 'unavailable');
      const binding = bindingFor(activeServer.port);
      const requestIp = (options.requestIp ?? defaultRequestIp)(request, activeServer);
      if (
        requestIp?.address !== KITE_WEB_LOOPBACK_HOST ||
        request.headers.get('host') !== binding.host
      ) {
        diagnose(options, 'request_rejected');
        return secureResponse(403, 'forbidden');
      }
      const url = new URL(request.url);
      if (
        request.method !== 'GET' ||
        url.search ||
        url.username ||
        url.password ||
        request.headers.get('authorization') !== null
      ) {
        diagnose(options, 'request_rejected');
        return secureResponse(request.method === 'GET' ? 403 : 405, 'forbidden');
      }
      let setCookie: string | undefined;
      if (url.pathname === '/') {
        const current = auth.inspectCookie(request.headers.get('cookie'));
        if (current.status !== 'valid') {
          setCookie = auth.createSession();
          if (!setCookie) return secureResponse(503, 'unavailable');
        }
      }
      const path = safeAssetPath(staticRoot, url.pathname === '/' ? '/index.html' : url.pathname);
      if (!path) return secureResponse(404, 'not_found');
      const asset = await readAsset(path);
      if (asset?.status !== 200) return secureResponse(404, 'not_found');
      return secureResponse(200, await asset.arrayBuffer(), {
        'content-type': contentTypeFor(path),
        ...(setCookie ? { 'set-cookie': setCookie } : {}),
      });
    },
  });
  if (!server.port) throw new Error('Web Gateway did not obtain the Service listener port.');
  const binding = bindingFor(server.port);
  auth = createWebGatewayAuth({
    instanceId: options.instanceId,
    cookiePath: '/',
    now: options.now,
    randomBytes: options.randomBytes,
    maxSessions: options.maxSessions,
  });
  return Object.freeze({
    origin: binding.origin,
    browserAuth: auth,
    close() {
      closing ??= (async () => {
        if (closed) return;
        closed = true;
        auth.close();
        let settled = false;
        const stop = Promise.resolve(server.stop(false)).finally(() => {
          settled = true;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          stop,
          new Promise<void>((resolvePromise) => {
            timer = setTimeout(resolvePromise, drainDeadlineMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!settled) {
          diagnose(options, 'drain_timeout');
          await server.stop(true);
        }
      })();
      return closing;
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  });
}

function bindingFor(port: number): { readonly host: string; readonly origin: string } {
  const host = `${KITE_WEB_LOOPBACK_HOST}:${port}`;
  return { host, origin: `http://${host}` };
}

function defaultRequestIp(request: Request, server: Bun.Server<SocketData>): RequestIp {
  return server.requestIP(request);
}

function safeAssetPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const name =
    decoded === '/' || decoded === '/api-docs' || decoded === '/api-docs/'
      ? 'index.html'
      : decoded.replace(/^\/+/, '');
  if (
    name !== 'index.html' &&
    name !== 'api-docs/openapi.json' &&
    !/^assets\/[A-Za-z0-9_-]+\.(?:css|ico|js|mjs|png|svg|woff2)$/u.test(name)
  ) {
    return undefined;
  }
  const candidate = resolve(root, name);
  const child = relative(root, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || child.includes(`..${sep}`))
    return undefined;
  return candidate;
}

function secureStaticAssetRoot(path: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Web Gateway static root is invalid.');
  }
  return realpathSync.native(absolute);
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  const values: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  return values[extension] ?? 'application/octet-stream';
}

async function defaultAssetReader(path: string): Promise<Response | undefined> {
  let descriptor: number | undefined;
  try {
    const parent = lstatSync(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) return undefined;
    return new Response(readFileSync(descriptor));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function secureResponse(
  status: number,
  body: BodyInit | undefined,
  extra: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers(SECURITY_HEADERS);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  if (typeof body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }
  return new Response(body, { status, headers });
}

function boundedDeadline(value: number | undefined): number {
  const selected = value ?? DEFAULT_DRAIN_DEADLINE_MS;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 30_000) {
    throw new RangeError('Web Gateway drain deadline is invalid.');
  }
  return selected;
}

function diagnose(options: WebGatewayCarrierOptions, code: WebGatewayDiagnosticCode): void {
  try {
    options.onDiagnostic?.(code);
  } catch {
    // Observation cannot affect the request or close path.
  }
}
