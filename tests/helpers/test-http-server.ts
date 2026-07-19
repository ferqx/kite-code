export function startTestHttpServer(options: {
  fetch(request: Request): Response | Promise<Response>;
}): ReturnType<typeof Bun.serve> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 30_000 + Math.floor(Math.random() * 30_000);
    try {
      return Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: options.fetch,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
