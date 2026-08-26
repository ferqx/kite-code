import { readFileSync } from 'node:fs';

export type TraceAttributeValue = string | number | boolean;

export interface TraceRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  timestamp: string;
  attributes: Record<string, TraceAttributeValue>;
  status: { code: 'OK' | 'ERROR'; message: string };
  events?: Array<{
    name: string;
    timestamp: string;
    attributes: Record<string, TraceAttributeValue>;
  }>;
}

export interface ReplayOptions {
  turn?: number;
  color?: boolean;
}

export interface ReplayTurn {
  index: number;
  records: TraceRecord[];
}

export function parseTraceJsonl(path: string): TraceRecord[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || !('name' in parsed)) {
        throw new Error('not a trace record');
      }
      return parsed as TraceRecord;
    } catch (error) {
      throw new Error(
        `Invalid JSONL trace at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export function groupTraceTurns(records: TraceRecord[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  let current: ReplayTurn | undefined;
  for (const record of records) {
    if (record.name === 'runtime.turn.started') {
      current = { index: turns.length + 1, records: [] };
      turns.push(current);
    }
    if (!current) {
      current = { index: 1, records: [] };
      turns.push(current);
    }
    current.records.push(record);
  }
  return turns;
}

export function filterTraceTurn(records: TraceRecord[], turn?: number): TraceRecord[] {
  if (!turn) return records;
  return groupTraceTurns(records).find((candidate) => candidate.index === turn)?.records ?? [];
}

function paint(value: string, code: number, color: boolean): string {
  return color ? `\u001B[${code}m${value}\u001B[0m` : value;
}

function eventLabel(record: TraceRecord, color: boolean): string {
  const type = String(
    record.attributes['kite_code.runtime_event'] ?? record.name.replace(/^runtime\./, ''),
  );
  const failed =
    record.status.code === 'ERROR' || type.includes('failed') || type.includes('rejected');
  const code = failed ? 31 : type.includes('approval') || type.includes('input') ? 33 : 36;
  const tool = record.attributes['kite_code.tool.name'];
  const callId = record.attributes['kite_code.tool.call_id'];
  const suffix = tool ? ` (${tool}${callId ? `: ${callId}` : ''})` : '';
  return paint(`${type}${suffix}`, code, color);
}

export function formatTrace(records: TraceRecord[], options: ReplayOptions = {}): string {
  const turns = groupTraceTurns(records).filter(
    (turn) => !options.turn || turn.index === options.turn,
  );
  if (options.turn && turns.length === 0) return `Turn ${options.turn} not found.`;
  if (turns.length === 0) return 'Trace is empty.';
  return turns
    .map((turn) =>
      [
        `Turn ${turn.index}`,
        ...turn.records.map((record) => `  ├─ ${eventLabel(record, options.color ?? false)}`),
      ].join('\n'),
    )
    .join('\n\n');
}
