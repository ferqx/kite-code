export interface DesktopDevelopment {
  readonly rendererUrl: string;
  readonly cspNonce: string;
  readonly control: { readonly port: number; readonly token: string };
}
export interface DevelopmentServiceReload {
  readonly id: string;
  readonly sha256: string;
}

/** Only an explicit development build can select a local renderer server. */
export function parseDesktopDevelopment(
  value: unknown,
  development: boolean,
): DesktopDevelopment | null {
  if (value === null || value === undefined) return null;
  if (!development || !value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid_desktop_development');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    typeof input.rendererUrl !== 'string' ||
    typeof input.cspNonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input.cspNonce)
  )
    throw Error('invalid_desktop_development');
  if (!input.control || typeof input.control !== 'object' || Array.isArray(input.control))
    throw Error('invalid_desktop_development');
  const control = input.control as Record<string, unknown>;
  if (
    Object.keys(control).length !== 2 ||
    !Number.isInteger(control.port) ||
    typeof control.port !== 'number' ||
    control.port < 1 ||
    control.port > 65535 ||
    typeof control.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(control.token)
  )
    throw Error('invalid_desktop_development');
  const url = new URL(input.rendererUrl);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.href !== input.rendererUrl
  )
    throw Error('invalid_desktop_development');
  return {
    rendererUrl: url.href,
    cspNonce: input.cspNonce,
    control: { port: control.port, token: control.token },
  };
}

export function desktopContentSecurityPolicy(development: DesktopDevelopment | null): string {
  const script = development ? `'self' 'nonce-${development.cspNonce}'` : "'self'";
  const connect = development
    ? `'self' ${development.rendererUrl.replace('http:', 'ws:').replace(/\/$/, '')}`
    : "'none'";
  return `default-src 'self'; script-src ${script}; connect-src ${connect}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}

export function parseDevelopmentServiceReload(value: unknown): DevelopmentServiceReload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid_development_service_reload');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    input.kind !== 'service.reload' ||
    typeof input.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input.id) ||
    typeof input.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    throw Error('invalid_development_service_reload');
  return { id: input.id, sha256: input.sha256 };
}

/** The authenticated parent's stream is independent of renderer IPC and has no path/command fields. */
export function serveDevelopmentReload(input: {
  stream: NodeJS.ReadableStream;
  reply: (line: string) => void;
  reload: (request: DevelopmentServiceReload) => Promise<void>;
}): () => void {
  let buffer = '',
    busy = false,
    closed = false;
  const receive = (chunk: Buffer | string) => {
    if (closed) return;
    buffer += String(chunk);
    if (Buffer.byteLength(buffer) > 4096) {
      closed = true;
      buffer = '';
      return;
    }
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let request: DevelopmentServiceReload;
      try {
        request = parseDevelopmentServiceReload(JSON.parse(line));
      } catch {
        continue;
      }
      const reply = (ok: boolean) =>
        input.reply(`${JSON.stringify({ kind: 'service.reloaded', id: request.id, ok })}\n`);
      if (busy) {
        reply(false);
        continue;
      }
      busy = true;
      void input
        .reload(request)
        .then(
          () => reply(true),
          () => reply(false),
        )
        .finally(() => {
          busy = false;
        });
    }
  };
  input.stream.on('data', receive);
  return () => {
    closed = true;
    input.stream.off('data', receive);
  };
}
