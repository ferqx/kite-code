import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOfficeDocument } from '../../src/tools/documents/office-command';
import { runOfficeCLI, verifyOfficeRuntimeAssets } from '../../src/tools/documents/office-runtime';

// Explicit integration suite: local pinned assets are required; never install/download.
test('pinned CLI exposes the discovery and read commands documented by the skill', async () => {
  await verifyOfficeRuntimeAssets();
  for (const [args, required] of [
    [['--help'], ['view <file> <mode>', 'set <file> <path>']],
    [
      ['view', '--help'],
      ['text, annotated, outline, stats, issues', '--range'],
    ],
    [
      ['set', '--help'],
      ['--prop', '<path>'],
    ],
  ] as const) {
    const result = await runOfficeCLI({ args });
    expect(result.code).toBe(0);
    for (const text of required) expect(result.stdout).toContain(text);
  }
}, 30000);

test('real helper edits preserve source bytes; semantic checks reject missing or collateral edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-office-contract-'));
  const source = join(root, 'source.xlsx');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const set = (cell: string, props: Record<string, string>) => ({
    command: 'set',
    path: `/Sheet1/${cell}`,
    props,
  });
  try {
    await createOfficeDocument({
      format: 'xlsx',
      out: source,
      operations: [
        set('A1', { value: '2' }),
        set('A2', { value: '3' }),
        set('A3', { formula: 'SUM(A1:A2)' }),
      ],
    });
    const before = await readFile(source);
    const read = async (file: string, path: string) => {
      const result = await runOfficeCLI({ args: ['get', file, path, '--json'] });
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    const baseline = await Promise.all(['A1', 'A2', 'A3'].map((c) => read(source, `/Sheet1/${c}`)));
    const edited = join(root, 'edited.xlsx');
    await createOfficeDocument({ source, out: edited, operations: [set('A1', { value: '7' })] });
    const changed = await read(edited, '/Sheet1/A1');
    expect(changed.results).toHaveLength(1);
    expect(changed.results[0].text).toBe('7');
    expect(changed).not.toEqual(baseline[0]);
    expect(await read(edited, '/Sheet1/A2')).toEqual(baseline[1]);
    // Formula readback separately from derived cache values.
    const formula = await read(edited, '/Sheet1/A3');
    expect(JSON.stringify(formula)).toContain('SUM(A1:A2)');
    const accepts = async (file: string) =>
      JSON.stringify(await read(file, '/Sheet1/A1')) === JSON.stringify(changed) &&
      JSON.stringify(await read(file, '/Sheet1/A2')) === JSON.stringify(baseline[1]) &&
      JSON.stringify(await read(file, '/Sheet1/A3')) === JSON.stringify(formula);
    expect(await accepts(source)).toBe(false);
    expect(await accepts(edited)).toBe(true);
    const collateral = join(root, 'collateral.xlsx');
    await createOfficeDocument({
      source: edited,
      out: collateral,
      operations: [set('A2', { value: '99' })],
    });
    expect(await accepts(collateral)).toBe(false);
    // Change only the ZIP archive comment, not any Office part or its contents.
    const bytes = Buffer.from(await readFile(edited));
    const end = bytes.length - 22;
    expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
    expect(bytes.readUInt16LE(end + 20)).toBe(0);
    const comment = Buffer.from('container metadata only');
    bytes.writeUInt16LE(comment.length, end + 20);
    const repacked = join(root, 'metadata.xlsx');
    await writeFile(repacked, Buffer.concat([bytes, comment]));
    expect(hash(await readFile(repacked))).not.toBe(hash(await readFile(edited)));
    expect(await accepts(repacked)).toBe(true);
    expect(hash(await readFile(source))).toBe(hash(before));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test('real DOCX edit permits only scoped valid revision metadata, not collateral changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-office-metadata-'));
  const source = join(root, 'source.docx'),
    out = join(root, 'edited.docx');
  try {
    await createOfficeDocument({
      format: 'docx',
      out: source,
      operations: ['Target before', 'Neighbor unchanged'].map((text) => ({
        command: 'add',
        parent: '/body',
        type: 'paragraph',
        props: { text },
      })),
    });
    const hash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    await createOfficeDocument({
      source,
      out,
      operations: [{ command: 'set', path: '/body/p[1]', props: { text: 'Target after' } }],
    });
    // Independent standard-library ZIP/XML assertions; local Python is required by this explicit suite.
    const oracle = Bun.spawnSync([
      'python3',
      join(import.meta.dir, 'office-edit-metadata.fixture.py'),
      source,
      out,
      hash,
    ]);
    expect(oracle.exitCode).toBe(0);
    expect(oracle.stdout.toString()).toContain('13 collateral/invalid mutations rejected');
    const external = join(root, 'external.docx');
    const externalOut = join(root, 'external-edited.docx');
    const fixture = join(import.meta.dir, 'office-edit-metadata.fixture.py');
    const strip = Bun.spawnSync(['python3', fixture, '--without-custom', source, external]);
    expect(strip.exitCode).toBe(0);
    // Use the same host-provided runtime as the skill, not an optional OS hash utility.
    const hashed = Bun.spawnSync([
      process.execPath,
      '-e',
      "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); console.log(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))",
      external,
    ]);
    expect(hashed.exitCode).toBe(0);
    const externalHash = hashed.stdout.toString().trim();
    expect(externalHash).toBe(
      createHash('sha256')
        .update(await readFile(external))
        .digest('hex'),
    );
    await createOfficeDocument({
      source: external,
      out: externalOut,
      operations: [{ command: 'set', path: '/body/p[1]', props: { text: 'Target after' } }],
    });
    const added = Bun.spawnSync(['python3', fixture, external, externalOut, externalHash]);
    expect(added.stderr.toString()).toBe('');
    expect(added.exitCode).toBe(0);
    expect(added.stdout.toString()).toContain(
      '8 unexplained part/content/relationship mutations rejected',
    );

    expect(
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
    ).toBe(hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
