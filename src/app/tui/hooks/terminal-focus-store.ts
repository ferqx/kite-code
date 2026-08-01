// Terminal focus events (DEC private mode 1004)
//   CSI I  -> focus gained
//   CSI O  -> focus lost
const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

export interface TerminalFocusInput {
  on(event: 'data', listener: (buffer: Buffer) => void): unknown;
  off(event: 'data', listener: (buffer: Buffer) => void): unknown;
}

export interface TerminalFocusOutput {
  write(value: string): unknown;
}

export interface TerminalFocusDiagnostics {
  subscriberCount: number;
  inputListenerAttached: boolean;
}

/**
 * Multiplex terminal focus reporting through one physical stdin listener.
 * React components subscribe to this store instead of attaching listeners
 * directly, so remounts and parallel Ink renderers cannot exceed EventTarget's
 * listener limit.
 */
export class TerminalFocusStore {
  private readonly subscribers = new Set<() => void>();
  private readonly input: TerminalFocusInput;
  private readonly output: TerminalFocusOutput;
  private focused = true;
  private inputListenerAttached = false;

  constructor(input: TerminalFocusInput, output: TerminalFocusOutput) {
    this.input = input;
    this.output = output;
  }

  readonly getSnapshot = (): boolean => this.focused;

  readonly getServerSnapshot = (): boolean => true;

  readonly subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber);
    if (!this.inputListenerAttached) this.attach();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.detach();
    };
  };

  diagnostics(): TerminalFocusDiagnostics {
    return {
      subscriberCount: this.subscribers.size,
      inputListenerAttached: this.inputListenerAttached,
    };
  }

  private readonly onData = (buffer: Buffer): void => {
    const value = buffer.toString();
    const next = value.includes(FOCUS_IN) ? true : value.includes(FOCUS_OUT) ? false : this.focused;
    if (next === this.focused) return;
    this.focused = next;
    for (const subscriber of this.subscribers) subscriber();
  };

  private attach(): void {
    this.inputListenerAttached = true;
    this.output.write(ENABLE_FOCUS_REPORTING);
    this.input.on('data', this.onData);
  }

  private detach(): void {
    if (!this.inputListenerAttached) return;
    this.inputListenerAttached = false;
    this.input.off('data', this.onData);
    this.output.write(DISABLE_FOCUS_REPORTING);
    this.focused = true;
  }
}

export const terminalFocusStore = new TerminalFocusStore(process.stdin, process.stdout);
