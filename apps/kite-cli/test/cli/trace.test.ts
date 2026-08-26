import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '#kite-cli/cli/index';
import { formatTrace, parseTraceJsonl } from '#kite-cli/trace/replay';

test('replays a JSONL trace grouped by runtime turns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kite-trace-'));
  const path = join(dir, 'events.jsonl');
  try {
    writeFileSync(
      path,
      `${JSON.stringify({ name: 'runtime.turn.started', attributes: { 'kite_code.runtime_event': 'turn.started' }, status: { code: 'OK', message: '' } })}\n${JSON.stringify({ name: 'runtime.tool.finished', attributes: { 'kite_code.runtime_event': 'tool.finished', 'kite_code.tool.name': 'read_file' }, status: { code: 'OK', message: '' } })}\n`,
    );
    const records = parseTraceJsonl(path);
    expect(formatTrace(records)).toContain('tool.finished (read_file)');
    expect(formatTrace(records, { turn: 2 })).toBe('Turn 2 not found.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports corrupted JSONL with its line number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kite-trace-'));
  const path = join(dir, 'events.jsonl');
  try {
    writeFileSync(path, '{bad json}\n');
    expect(() => parseTraceJsonl(path)).toThrow('line 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formats an empty trace without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kite-trace-'));
  const path = join(dir, 'events.jsonl');
  try {
    writeFileSync(path, '');
    expect(formatTrace(parseTraceJsonl(path))).toBe('Trace is empty.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an invalid trace turn selector', () => {
  expect(() => parseArgs(['trace', 'events.jsonl', '--turn', 'zero'])).toThrow('positive integer');
});
