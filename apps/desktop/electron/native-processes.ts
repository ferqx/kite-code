import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

type SpawnChild = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type Entry = { closed: Promise<void>; stop(error: Error): void };

/** Main owns these exact direct child handles, not the applications they hand off to. */
export class NativeProcessOwner {
  private readonly children = new Set<Entry>();
  private readonly spawnChild: SpawnChild;
  private draining = false;
  private closing?: Promise<void>;

  constructor(
    spawnChild: SpawnChild = (command, args, options) => spawn(command, [...args], options),
  ) {
    this.spawnChild = spawnChild;
  }

  start(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
    errors: { timeoutMs: number; timeoutError: string; launchError: string },
  ): { child: ChildProcess; result: Promise<number | null>; stop(error: Error): void } {
    if (this.draining) throw Error('native_draining');
    let child: ChildProcess;
    try {
      child = this.spawnChild(command, args, options);
    } catch {
      throw Error(errors.launchError);
    }
    let closed = false,
      stopping = false,
      failure: Error | undefined;
    let resolveClose!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const stop = (error: Error) => {
      if (closed) return;
      failure ??= error;
      if (stopping) return;
      stopping = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // A failed signal does not prove cleanup. Keep waiting for this handle's close.
      }
    };
    const entry: Entry = { closed: completion, stop };
    const result = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => stop(Error(errors.timeoutError)), errors.timeoutMs);
      child.on('error', () => stop(Error(errors.launchError)));
      child.once('close', (code) => {
        closed = true;
        clearTimeout(timer);
        this.children.delete(entry);
        resolveClose();
        if (failure) reject(failure);
        else resolve(code);
      });
    });
    // The caller may be finishing another await when a child closes during shutdown.
    void result.catch(() => {});
    this.children.add(entry);
    return { child, result, stop };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.draining = true;
    const children = [...this.children];
    for (const child of children) child.stop(Error('native_draining'));
    // Node close includes reaping the original child and closing its stdio pipes.
    this.closing = Promise.all(children.map((child) => child.closed)).then(() => undefined);
    return this.closing;
  }
}
