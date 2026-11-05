const marker = Symbol.for('@kite-ai/agent.BrowserExecutorFailure.v1');
const codes = new Set([
  'browser_executor_closed',
  'browser_executor_cleanup_unknown',
  'browser_executor_frame_limit',
  'browser_executor_protocol',
  'browser_executor_call_limit',
  'browser_executor_cancelled',
  'browser_executor_result_limit',
  'browser_executor_api_failed',
  'browser_executor_output_limit',
  'browser_executor_unawaited_calls',
  'browser_executor_ended',
  'browser_executor_timeout',
  'browser_executor_budget_unavailable',
  'browser_executor_failed',
]);

/** Host-only bounded console output; arbitrary exception text and causes stay private. */
export class BrowserExecutorFailure extends Error {
  readonly output: string;
  constructor(error: unknown, output: string) {
    super(
      error instanceof Error && codes.has(error.message)
        ? error.message
        : 'browser_executor_failed',
    );
    this.name = 'BrowserExecutorFailure';
    this.output = output;
    Object.defineProperty(this, marker, { value: true });
  }
  /** Source and independently built executor entries may have different constructors. */
  static isInstance(error: unknown): error is BrowserExecutorFailure {
    if (!(error instanceof Error)) return false;
    const value = error as BrowserExecutorFailure & { [marker]?: boolean };
    return (
      value[marker] === true &&
      codes.has(value.message) &&
      typeof value.output === 'string' &&
      Buffer.byteLength(value.output) <= 16385
    );
  }
}
