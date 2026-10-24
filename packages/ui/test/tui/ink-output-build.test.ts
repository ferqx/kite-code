import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { plainInkOutput } from '../../scripts/ink-output';

interface Output {
  write(x: number, y: number, text: string, options: { transformers: Transform[] }): void;
  clip(clip: { x1?: number; x2?: number; y1?: number; y2?: number }): void;
  unclip(): void;
  get(): { output: string; height: number };
}
type Transform = (text: string, index: number) => string;
type Constructor = new (size: { width: number; height: number }) => Output;
type Operation =
  | { kind: 'write'; x: number; y: number; text: string; transforms?: Transform[] }
  | { kind: 'clip'; clip: Parameters<Output['clip']>[0] }
  | { kind: 'unclip' };

const inkDirectory = dirname(Bun.resolveSync('ink', import.meta.dir));
const outputPath = join(inkDirectory, 'output.js');
const Original: Constructor = (await import(pathToFileURL(outputPath).href)).default;
const bundle = await Bun.build({
  entrypoints: [outputPath],
  target: 'bun',
  packages: 'bundle',
  plugins: [plainInkOutput(inkDirectory)],
});
if (!bundle.success) throw new AggregateError(bundle.logs, 'ink_output_test_build_failed');
const compiled = await bundle.outputs[0]!.text();
const Compiled: Constructor = (
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
).default;

function output(Impl: Constructor, width: number, height: number, operations: Operation[]): Output {
  const result = new Impl({ width, height });
  for (const operation of operations) {
    if (operation.kind === 'write')
      result.write(operation.x, operation.y, operation.text, {
        transformers: operation.transforms ?? [],
      });
    else if (operation.kind === 'clip') result.clip(operation.clip);
    else result.unclip();
  }
  return result;
}

test('compiled Ink output preserves Unicode, overlapping wide cells, clipping, styling and padding', () => {
  expect(compiled).toContain('lineWithoutEmptyItems.every');
  const samples: { width: number; height: number; operations: Operation[] }[] = [
    { width: 80, height: 24, operations: [] },
    { width: 3.5, height: 2.5, operations: [] },
    {
      width: 30,
      height: 6,
      operations: [
        { kind: 'write', x: 2, y: 1, text: '原🙂e\u0301👩🏽‍💻\n trailing spaces  \n \t\n' },
        { kind: 'write', x: 0, y: 4, text: '\x1b[1;31m红色  \x1b[0m' },
      ],
    },
    {
      width: 12,
      height: 4,
      operations: [
        { kind: 'write', x: 0, y: 0, text: '\x1b[32m甲🙂乙\x1b[0m\n漢字全\n🙂🙂🙂' },
        { kind: 'write', x: 1, y: 0, text: 'a' },
        { kind: 'write', x: 2, y: 1, text: 'b' },
        { kind: 'write', x: 3, y: 2, text: 'XY' },
      ],
    },
    {
      width: 12,
      height: 7,
      operations: [
        { kind: 'write', x: 0, y: 0, text: 'ORIGINAL' },
        { kind: 'clip', clip: { x1: 2, x2: 10, y1: 1, y2: 6 } },
        {
          kind: 'write',
          x: 0,
          y: 0,
          text: '\x1b[34m0123456789ABC\n原🙂CJKwide文\nlastline\x1b[0m',
        },
        { kind: 'clip', clip: { x1: 4, x2: 9, y1: 2, y2: 4 } },
        { kind: 'write', x: 3, y: 2, text: '👩🏽‍💻漢🌿end\ninner\noutside' },
        { kind: 'unclip' },
        { kind: 'write', x: 8, y: 4, text: 'right\nedge' },
        { kind: 'unclip' },
      ],
    },
    {
      width: 40,
      height: 4,
      operations: [
        {
          kind: 'write',
          x: 0,
          y: 0,
          text: '\x1b]8;;https://example.invalid/\x07linked🌿\x1b]8;;\x07\n\x1b[38;2;12;30;90mcolor\x1b[0m',
          transforms: [(text, index) => `\x1b[1m${index}:${text}\x1b[22m`],
        },
        { kind: 'write', x: 9, y: 0, text: '\x1b[2mX\x1b[22m' },
      ],
    },
  ];
  let seed = 1729;
  const random = (size: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % size;
  };
  const text = [
    'abc',
    '原🙂文',
    'e\u0301🌿',
    '\x1b[1mBOLD\x1b[22m',
    '\x1b[31m红\x1b[39m',
    'two\nrows',
    '👩🏽‍💻🇨🇳',
    ' ',
  ];
  for (let sample = 0; sample < 120; sample++) {
    const operations: Operation[] = [];
    for (let index = 0; index < 12; index++) {
      if (index === 4) operations.push({ kind: 'clip', clip: { x1: 2, x2: 16, y1: 1, y2: 6 } });
      if (index === 8) operations.push({ kind: 'unclip' });
      operations.push({
        kind: 'write',
        x: random(19),
        y: random(8),
        text: text[random(text.length)]!,
      });
    }
    samples.push({ width: 20, height: 8, operations });
  }
  for (const sample of samples) {
    const expected = output(Original, sample.width, sample.height, sample.operations).get();
    const actual = output(Compiled, sample.width, sample.height, sample.operations);
    expect(actual.get()).toEqual(expected);
    expect(actual.get()).toEqual(expected);
  }
});

test('compiled Ink output preserves all 9MB and 75001 physical rows', () => {
  const body = `${'正文'.repeat(1500000)}ACTUAL_HOST_VERIFIED_TAIL`;
  const rows = Array.from({ length: 75000 }, () => '正文'.repeat(20));
  rows.push('ACTUAL_HOST_VERIFIED_TAIL');
  const text = rows.join('\n');
  const operations: Operation[] = [{ kind: 'write', x: 0, y: 0, text }];
  const expected = output(Original, 80, 75001, operations).get();
  const actual = output(Compiled, 80, 75001, operations).get();
  expect(actual).toEqual(expected);
  expect(actual.output).toBe(text);
  expect(actual.output.replaceAll('\n', '')).toBe(body);
  expect(Buffer.byteLength(body)).toBe(9000025);
}, 15000);

test('Ink output build rejects unreviewed versions or changed serialization and binds one physical module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-ink-output-build-'));
  if (dirname(resolve(root)) !== resolve(tmpdir())) throw Error('ink_test_cleanup_outside_temp');
  const build = join(root, 'build');
  mkdirSync(build);
  const manifest = join(root, 'package.json');
  const candidate = join(build, 'output.js');
  try {
    writeFileSync(manifest, JSON.stringify({ name: 'ink', version: '7.2.0' }));
    writeFileSync(candidate, 'export default 1;');
    expect(() => plainInkOutput(build)).toThrow('tui_ink_build_version_unreviewed');
    writeFileSync(manifest, JSON.stringify({ name: 'ink', version: '7.1.1' }));
    const rejected = await Bun.build({
      throw: false,
      entrypoints: [candidate],
      plugins: [plainInkOutput(build)],
    });
    expect(rejected.success).toBe(false);
    expect(rejected.logs.map(String).join('\n')).toContain('tui_ink_output_contract_changed');
    writeFileSync(candidate, readFileSync(outputPath, 'utf8').repeat(2));
    const duplicate = await Bun.build({
      throw: false,
      entrypoints: [candidate],
      plugins: [plainInkOutput(build)],
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.logs.map(String).join('\n')).toContain('tui_ink_output_contract_changed');
    writeFileSync(candidate, 'export default 1;');
    const other = await Bun.build({
      entrypoints: [candidate],
      plugins: [plainInkOutput(inkDirectory)],
    });
    expect(other.success).toBe(true);
    expect(await other.outputs[0]!.text()).toContain('1');
    expect(readFileSync(outputPath, 'utf8')).not.toContain('lineWithoutEmptyItems.every');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
