export function startTestHttpServer(options: {
  fetch(request: Request): Response | Promise<Response>;
  idleTimeout?: number;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    // Let the OS reserve an available ephemeral port atomically. Picking a random
    // port first races parallel test processes and can hide non-collision failures.
    port: 0,
    ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
    fetch: options.fetch,
  });
}
