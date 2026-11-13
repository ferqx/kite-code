import { serve } from '../../scripts/tooling/http';

export function startTestHttpServer(options: {
  fetch(request: Request): Response | Promise<Response>;
  idleTimeout?: number;
}) {
  return serve({
    hostname: '127.0.0.1',
    port: 0,
    ...options,
  });
}
