import { McpOAuthSessionError } from './mcp-oauth-session';

/** Explicit Login only. The authorization URL is an argv element, never shell text or output. */
export async function openMcpOAuthBrowser(url: URL, signal: AbortSignal): Promise<void> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new McpOAuthSessionError('mcp_oauth_authorization_url_invalid');
  signal.throwIfAborted();
  const argv =
    process.platform === 'darwin'
      ? ['/usr/bin/open', url.href]
      : process.platform === 'win32'
        ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url.href]
        : ['xdg-open', url.href];
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  } catch {
    throw new McpOAuthSessionError('mcp_oauth_browser_unavailable');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted!: () => void;
  let failed = false;
  let failure: unknown;
  try {
    const exit = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new McpOAuthSessionError('mcp_oauth_browser_unavailable')),
          5000,
        );
        aborted = () => reject(new McpOAuthSessionError('mcp_oauth_cancelled'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
    signal.throwIfAborted();
    if (exit !== 0) throw new McpOAuthSessionError('mcp_oauth_browser_unavailable');
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (timer) clearTimeout(timer);
    if (aborted) signal.removeEventListener('abort', aborted);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) => {
          deadline = setTimeout(() => resolve(false), 250);
        }),
      ]);
      if (deadline) clearTimeout(deadline);
      if (!exited) child.kill('SIGKILL');
      const confirmed = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) => {
          deadline = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      if (deadline) clearTimeout(deadline);
      if (!confirmed) {
        failed = true;
        failure = new McpOAuthSessionError('mcp_oauth_cleanup_unknown');
      }
    }
  }
  if (failed) throw failure;
}
