// Terminal focus events (DEC private mode 1004)
//   CSI I  -> focus gained
//   CSI O  -> focus lost
const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

export function isTerminalFocusReport(value: string): boolean {
  return (
    value === FOCUS_IN ||
    value === FOCUS_IN.slice(1) ||
    value === FOCUS_OUT ||
    value === FOCUS_OUT.slice(1)
  );
}

export interface TerminalFocusOutput {
  write(value: string): unknown;
}

export interface TerminalFocusDiagnostics {
  subscriberCount: number;
  reportingEnabled: boolean;
}

/**
 * Multiplex terminal focus reporting without reading stdin directly.
 * Ink owns the process input stream; useTerminalFocus forwards focus reports
 * from Ink's useInput channel so session remounts cannot switch stdin between
 * readable and flowing modes.
 */
export class TerminalFocusStore {
  private readonly subscribers = new Set<() => void>();
  private readonly output: TerminalFocusOutput;
  private focused = true;
  private reportingEnabled = false;

  constructor(output: TerminalFocusOutput) {
    this.output = output;
  }

  readonly getSnapshot = (): boolean => this.focused;

  readonly getServerSnapshot = (): boolean => true;

  readonly subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber);
    if (!this.reportingEnabled) this.enableReporting();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.disableReporting();
    };
  };

  diagnostics(): TerminalFocusDiagnostics {
    return {
      subscriberCount: this.subscribers.size,
      reportingEnabled: this.reportingEnabled,
    };
  }

  handleInput(value: string): void {
    const next =
      value === FOCUS_IN || value === FOCUS_IN.slice(1)
        ? true
        : value === FOCUS_OUT || value === FOCUS_OUT.slice(1)
          ? false
          : this.focused;
    if (next === this.focused) return;
    this.focused = next;
    for (const subscriber of this.subscribers) subscriber();
  }

  private enableReporting(): void {
    this.reportingEnabled = true;
    this.output.write(ENABLE_FOCUS_REPORTING);
  }

  private disableReporting(): void {
    if (!this.reportingEnabled) return;
    this.reportingEnabled = false;
    this.output.write(DISABLE_FOCUS_REPORTING);
    this.focused = true;
  }
}

export const terminalFocusStore = new TerminalFocusStore(process.stdout);
