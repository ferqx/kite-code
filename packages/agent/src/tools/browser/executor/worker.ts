import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import { start } from 'node:repl';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

// This interpreter runs only inside the OS sandbox. REPL is a language facility,
// not the security boundary. No host credential, endpoint or session token enters it.
const send = (frame: object) => process.stdout.write(JSON.stringify(frame) + '\n');
const diagnostics = new PassThrough();
const interpreter = start({
  input: new PassThrough(),
  output: diagnostics,
  terminal: false,
  prompt: '',
});
type Evaluation = { id: number; open: boolean };
const evaluations = new AsyncLocalStorage<Evaluation>();
let batch = 0,
  sequence = 0;
let active: Evaluation | undefined;
function errorSummary(text: string): string {
  const header = text
    .split(/\r?\n/)
    .map((line) =>
      stripVTControlCharacters(line)
        .trim()
        .replace(/^Uncaught:?\s*/, ''),
    )
    .find((line) =>
      /^(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AggregateError|Error):(?:\s|$)/.test(
        line,
      ),
    );
  if (!header) return 'browser_executor_evaluation_failed';
  let summary = '',
    size = 0;
  for (const character of header) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > 512) break;
    summary += character;
    size += bytes;
  }
  return summary;
}
let diagnostic: { origin: Evaluation; chunks: Buffer[]; size: number } | undefined;
// The Node REPL sends rejected top-level await to its output instead of
// its eval callback. This output has no prompts or normal result printing here.
diagnostics.on('data', (bytes: Buffer) => {
  const origin = evaluations.getStore();
  if (!origin || origin !== active || (diagnostic ? diagnostic.origin !== origin : !origin.open))
    return;
  if (!diagnostic) {
    origin.open = false; // Seal this evaluation, including callbacks it created.
    diagnostic = { origin, chunks: [], size: 0 };
    setImmediate(() => {
      const captured = diagnostic!;
      diagnostic = undefined;
      // Streaming decode drops an incomplete UTF8 tail at the bounded buffer edge.
      const text = new TextDecoder().decode(Buffer.concat(captured.chunks), { stream: true });
      send({
        type: 'done',
        batch: captured.origin.id,
        pending: pending.size,
        error: errorSummary(text),
      });
    });
  }
  const chunk = bytes.subarray(0, Math.max(0, 2048 - diagnostic.size));
  if (chunk.byteLength) diagnostic.chunks.push(Buffer.from(chunk));
  diagnostic.size += chunk.byteLength;
});
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
// An unhandled rejection from a retired evaluation can otherwise exit the process.
// The process event can lose ALS; never attribute an unscoped, detached rejection
// to the active evaluation. Awaited evaluation failures still use the REPL
// callback/diagnostic path. Host operations and their failures live outside here.
process.on('unhandledRejection', (reason) => {
  const origin = evaluations.getStore();
  if (!origin || origin !== active || !origin.open) return;
  origin.open = false;
  send({
    type: 'done',
    batch: origin.id,
    pending: pending.size,
    error: errorSummary(reason instanceof Error ? `${reason.name}: ${reason.message}` : ''),
  });
});
function call(method: string, args: unknown = null): Promise<unknown> {
  const origin = evaluations.getStore();
  if (!origin || origin !== active || !origin.open)
    return Promise.reject(Error('browser_executor_no_batch'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'call', batch: origin.id, id, method, args });
  });
}
function page(id: unknown) {
  if (typeof id !== 'string') throw Error('browser_executor_invalid_page');
  const handle: Record<string, unknown> = { id };
  for (const method of [
    'snapshot',
    'screenshot',
    'click',
    'fill',
    'scroll',
    'close',
    'press',
    'select',
    'hover',
    'navigate',
    'back',
    'forward',
    'reload',
    'wait',
    'dialog',
    'dialogs',
    'pointer',
  ])
    handle[method] = (...args: unknown[]) => call(method, { page: id, args });
  return Object.freeze(handle);
}
interpreter.context.browser = Object.freeze({
  call,
  page,
  async open(url: string) {
    return page(await call('open', { url }));
  },
  pages() {
    return call('pages');
  },
});
interpreter.context.console = Object.freeze({
  log: (...values: unknown[]) => {
    const origin = evaluations.getStore();
    if (!origin || origin !== active || !origin.open) return;
    send({
      type: 'output',
      batch: origin.id,
      content: values
        .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
        .join(' '),
    });
  },
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  try {
    if (Buffer.byteLength(line) > 131072) throw Error('browser_executor_frame_limit');
    const frame = JSON.parse(line);
    if (frame.type === 'result' && frame.batch === batch && Number.isSafeInteger(frame.id)) {
      const waiter = pending.get(frame.id);
      if (!waiter) throw Error('browser_executor_unknown_response');
      pending.delete(frame.id);
      if (frame.error) waiter.reject(Error(frame.error));
      else waiter.resolve(frame.value);
    } else if (
      frame.type === 'execute' &&
      !active?.open &&
      pending.size === 0 &&
      !diagnostic &&
      Number.isSafeInteger(frame.batch) &&
      frame.batch > batch &&
      typeof frame.code === 'string'
    ) {
      batch = frame.batch;
      const origin: Evaluation = { id: batch, open: true };
      active = origin;
      evaluations.run(origin, () =>
        interpreter.eval(frame.code + '\n', interpreter.context, 'computer-use', (error, value) => {
          if (!origin.open || active !== origin) return;
          // Unawaited effects cannot leak into the next batch.
          if (pending.size) error = Error('browser_executor_unawaited_calls');
          origin.open = false;
          try {
            send({
              type: 'done',
              batch: origin.id,
              pending: pending.size,
              ...(error
                ? { error: errorSummary(`${error.name}: ${error.message}`) }
                : { value: value === undefined ? null : value }),
            });
          } catch {
            send({
              type: 'done',
              batch: origin.id,
              pending: pending.size,
              error: 'browser_executor_result_not_json',
            });
          }
        }),
      );
    } else throw Error('browser_executor_protocol');
  } catch {
    process.exit(125);
  }
});
lines.on('close', () => process.exit(0));
send({ type: 'ready' });
