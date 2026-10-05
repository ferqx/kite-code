import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTrace, renderTrace, runTrace } from '../../src/trace';

function fixture() {
  const root = mkdtempSync('/private/tmp/kite-cli-trace-');
  return {
    root,
    path: join(root, 'events.jsonl'),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const started = JSON.stringify({
  name: 'runtime.turn.started',
  attributes: { 'kite_code.runtime_event': 'turn.started' },
  status: { code: 'OK', message: '' },
});
test('old qualified JSONL turn markers still filter actual log segments and preserve unknown future content', () => {
  const f = fixture();
  try {
    writeFileSync(
      f.path,
      `${started}\n${JSON.stringify({ name: 'future.record', future: { complete: ['unknown', 9] } })}\n${started}\n${JSON.stringify({ name: 'runtime.tool.finished', attributes: { 'kite_code.tool.name': 'read_file' }, status: { code: 'OK' } })}\n`,
    );
    const records = readTrace(readFileSync(f.path));
    const first = JSON.parse(renderTrace(records, { turn: 1, format: 'json' }));
    expect(first).toHaveLength(2);
    expect(first[1].future).toEqual({ complete: ['unknown', 9] });
    const second = renderTrace(records, { turn: 2, format: 'text' });
    expect(second).toContain('read_file');
    expect(second).not.toContain('future.record');
    expect(second).toContain('Log turn');
    expect(second).toContain('not a Runtime identity');
    expect(renderTrace(records, { turn: 3, format: 'text' })).toBe('Turn 3 not found.');
  } finally {
    f.close();
  }
});
test('explicit exact turn wins over position; complete JSON retains number lexemes and text escapes terminal control', () => {
  const f = fixture();
  try {
    writeFileSync(
      f.path,
      '{"turn":7,"name":"future","huge":9007199254740993,"body":"\\u0000\\u001b[31m\\u009b\\u202eTAIL"}\n{"turn":2,"name":"other"}',
    );
    const records = readTrace(readFileSync(f.path));
    const json = renderTrace(records, { turn: 7, format: 'json' });
    expect(json).toContain('9007199254740993');
    expect(JSON.parse(json)[0].turn).toBe(7);
    const text = renderTrace(records, { turn: 7, format: 'text' });
    expect(text).toContain('TAIL');
    expect(text).toContain('\\u001b');
    expect(text).not.toContain(String.fromCharCode(27));
    expect(text).not.toContain(String.fromCharCode(0x202e));
    expect(text).toContain('Turn 7');
  } finally {
    f.close();
  }
});
test('invalid UTF8, raw NUL, incomplete JSON and non-record input never publish a valid prefix', () => {
  const f = fixture();
  try {
    for (const [body, code] of [
      [new Uint8Array([0xff]), 'trace_invalid_utf8'],
      ['{"name":"valid"}\n{"bad":', 'trace_invalid_json'],
      ['{"name":"valid"}\n{"body":"\0"}', 'trace_invalid_json'],
      ['[]', 'trace_invalid_record'],
    ] as const) {
      writeFileSync(f.path, body);
      const output: string[] = [];
      expect(() =>
        runTrace({ kind: 'trace', path: f.path, format: 'text' }, readFileSync, (text) =>
          output.push(text),
        ),
      ).toThrow(code);
      expect(output).toEqual([]);
    }
    writeFileSync(f.path, '');
    expect(readTrace(readFileSync(f.path))).toEqual([]);
    expect(renderTrace([], { format: 'text' })).toBe('Trace is empty.');
  } finally {
    f.close();
  }
});
test('actual argv trace process reads only the explicit file without network/Service/Provider/profile startup', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, `${started}\n{"turn":9,"future":{"full":"last"}}\n`);
    const before = readdirSync(f.root).sort();
    const child = Bun.spawn(
      [
        process.execPath,
        '--preload',
        join(import.meta.dir, '../fixtures/trace-readonly.ts'),
        join(import.meta.dir, '../../host/main.ts'),
        'trace',
        f.path,
        '--turn',
        '9',
        '--format',
        'json',
      ],
      {
        cwd: f.root,
        env: {
          ...process.env,
          KITE_HOME: join(f.root, 'never-profile'),
          KITE_SERVER: 'http://127.0.0.1:1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual([{ turn: 9, future: { full: 'last' } }]);
    expect(readdirSync(f.root).sort()).toEqual(before);
    writeFileSync(f.path, '{"valid":true}\n{"partial":');
    const invalid = Bun.spawn(
      [
        process.execPath,
        '--preload',
        join(import.meta.dir, '../fixtures/trace-readonly.ts'),
        join(import.meta.dir, '../../host/main.ts'),
        'trace',
        f.path,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [badCode, badOut, badErr] = await Promise.all([
      invalid.exited,
      new Response(invalid.stdout).text(),
      new Response(invalid.stderr).text(),
    ]);
    expect(badCode).toBe(1);
    expect(badOut).toBe('');
    expect(badErr).toBe('trace_invalid_json: line 2\n');
  } finally {
    f.close();
  }
});
