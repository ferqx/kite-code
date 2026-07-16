export interface BrowserOpener {
  open(url: URL): Promise<void>;
}

/** Opens an HTTP(S) URL without shell parsing or string interpolation. */
export class NativeBrowserOpener implements BrowserOpener {
  async open(url: URL): Promise<void> {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Only HTTP(S) authorization URLs can be opened.');
    }
    const command = browserCommand(url.toString());
    const processHandle = Bun.spawn(command, {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await processHandle.exited;
    if (exitCode !== 0) throw new Error('Unable to open the system browser.');
  }
}

function browserCommand(url: string): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['open', url];
    case 'win32':
      return ['rundll32', 'url.dll,FileProtocolHandler', url];
    default:
      return ['xdg-open', url];
  }
}
