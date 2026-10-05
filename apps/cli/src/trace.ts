import type { CLIArguments } from './arguments';

export class CLITraceError extends Error {
  readonly code: string;
  readonly line: number | undefined;
  constructor(code: string, line?: number) {
    super(line === undefined ? code : `${code}: line ${line}`);
    this.code = code;
    this.line = line;
  }
}
export type TraceRecord = Record<string, unknown>;
const originalJSON = new WeakMap<TraceRecord, string>();

/** Parse the entire explicit file before publishing any output. No valid prefix is a successful trace. */
export function readTrace(bytes: Uint8Array): TraceRecord[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CLITraceError('trace_invalid_utf8');
  }
  const records: TraceRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CLITraceError('trace_invalid_json', index + 1);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new CLITraceError('trace_invalid_record', index + 1);
    originalJSON.set(value as TraceRecord, line);
    records.push(value as TraceRecord);
  }
  return records;
}
/** A supplied exact turn is a fact, never the file order or digits guessed from an ID. */
export function traceTurn(record: TraceRecord): number | undefined {
  return typeof record.turn === 'number' && Number.isSafeInteger(record.turn) && record.turn > 0
    ? record.turn
    : undefined;
}
function terminalSafe(value: string): string {
  return value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls, including ANSI and bidi controls.
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
function isTurnStart(record: TraceRecord): boolean {
  const attributes = record.attributes,
    status = record.status;
  return (
    record.name === 'runtime.turn.started' &&
    !!attributes &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes) &&
    !!status &&
    typeof status === 'object' &&
    'code' in status &&
    (status.code === 'OK' || status.code === 'ERROR')
  );
}
export function renderTrace(
  records: readonly TraceRecord[],
  options: { turn?: number; format: 'text' | 'json' },
): string {
  let ordinal = 0;
  const indexed = records.map((record) => {
    if (isTurnStart(record)) ordinal++;
    if (!ordinal) ordinal = 1;
    return { record, turn: traceTurn(record) ?? ordinal, ordinal: traceTurn(record) === undefined };
  });
  const selected =
    options.turn === undefined ? indexed : indexed.filter((value) => value.turn === options.turn);
  const json = (record: TraceRecord) => originalJSON.get(record) ?? JSON.stringify(record);
  if (options.format === 'json')
    return `[${selected.map((value) => json(value.record)).join(',\n')}]`;
  const lines = selected.map(
    (value) =>
      `${value.ordinal ? 'Log turn' : 'Turn'} ${value.turn} · ${terminalSafe(json(value.record))}`,
  );
  if (!lines.length)
    lines.push(options.turn === undefined ? 'Trace is empty.' : `Turn ${options.turn} not found.`);
  if (selected.some((value) => value.ordinal))
    lines.push(
      'Log turn is the recorded runtime.turn.started segment ordinal, not a Runtime identity. Unknown fields are preserved.',
    );
  return lines.join('\n');
}
export function runTrace(
  input: Extract<CLIArguments, { kind: 'trace' }>,
  read: (path: string) => Uint8Array,
  write: (value: string) => void,
): number {
  let bytes: Uint8Array;
  try {
    bytes = read(input.path);
  } catch {
    throw new CLITraceError('trace_read_failed');
  }
  const records = readTrace(bytes);
  write(renderTrace(records, input));
  return 0;
}
