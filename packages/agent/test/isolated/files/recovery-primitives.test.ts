import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';

const budget = { maxBytes: 1024 * 1024 };
function fixture(protectedPaths: string[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-recovery-')));
  const files = createWorkspaceFiles({ root, protectedPaths });
  return {
    root,
    files,
    async close() {
      await files.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function denied(operation: Promise<unknown>, code?: string) {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  if (code) expect(error).toMatchObject({ code });
}

test('trusted byte primitives preserve binary, BOM/CRLF and full baseline without adding Model tools', async () => {
  const f = fixture();
  try {
    const original = Buffer.concat([
      Buffer.from('\uFEFF多字节\r\n'),
      Buffer.from([0, 255, 128, 13, 10]),
      Buffer.alloc(70000, 231),
    ]);
    writeFileSync(join(f.root, 'data'), original);
    const snapshot = await f.files.readBytes('data', budget);
    expect(Buffer.from(snapshot.bytes)).toEqual(original);
    expect(snapshot.baseline.hash).toBe(createHash('sha256').update(original).digest('hex'));
    expect(snapshot.baseline.size).toBe(original.length);
    await denied(f.files.read('data'), 'file_encoding_invalid');
    const newer = await f.files.restore({
      path: 'data',
      bytes: Buffer.from('next\r\n'),
      base: snapshot.baseline,
      ...budget,
    });
    expect(readFileSync(join(f.root, 'data'))).toEqual(Buffer.from('next\r\n'));
    const restored = await f.files.restore({
      path: 'data',
      bytes: snapshot.bytes,
      base: newer.baseline,
      ...budget,
    });
    expect(readFileSync(join(f.root, 'data'))).toEqual(original);
    expect(restored.baseline.hash).toBe(snapshot.baseline.hash);
    expect(restored.baseline.inode).not.toBe(snapshot.baseline.inode);
    expect(createFileTools(f.files).map((tool) => tool.id)).toEqual([
      'files.read',
      'files.write',
      'files.edit',
      'files.list',
      'files.glob',
      'files.search',
    ]);
    const created = await f.files.restore({
      path: 'created',
      bytes: new Uint8Array(),
      base: null,
      ...budget,
    });
    expect(created.baseline.size).toBe(0);
    expect(await f.files.remove({ path: 'created', base: created.baseline, ...budget })).toEqual({
      path: 'created',
      removedBaseline: created.baseline,
    });
    expect(existsSync(join(f.root, 'created'))).toBe(false);
    await denied(f.files.remove({ path: 'created', base: created.baseline, ...budget }));
  } finally {
    await f.close();
  }
});

test('finite budgets, current content and inode CAS reject without publication', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'data'), Buffer.from([0, 1, 2, 3]));
    const original = await f.files.readBytes('data', budget);
    await denied(f.files.readBytes('data', { maxBytes: 3 }), 'file_too_large');
    for (const maxBytes of [0, -1, NaN, Infinity, 1.5])
      await denied(f.files.readBytes('data', { maxBytes }), 'file_limit_invalid');
    await denied(
      f.files.restore({ path: 'new', bytes: Buffer.alloc(5), base: null, maxBytes: 4 }),
      'file_too_large',
    );
    expect(existsSync(join(f.root, 'new'))).toBe(false);
    writeFileSync(join(f.root, 'data'), Buffer.from([0, 1, 2, 4]));
    await denied(
      f.files.remove({ path: 'data', base: original.baseline, ...budget }),
      'file_baseline_conflict',
    );
    await denied(
      f.files.restore({ path: 'data', bytes: original.bytes, base: original.baseline, ...budget }),
      'file_baseline_conflict',
    );
    writeFileSync(join(f.root, 'other'), original.bytes);
    renameSync(join(f.root, 'other'), join(f.root, 'data'));
    await denied(
      f.files.remove({ path: 'data', base: original.baseline, ...budget }),
      'file_baseline_conflict',
    );
    await denied(
      f.files.restore({ path: 'data', bytes: original.bytes, base: null, ...budget }),
      'file_baseline_conflict',
    );
    expect(readFileSync(join(f.root, 'data'))).toEqual(Buffer.from(original.bytes));
    await denied(
      f.files.remove({ path: 'data', base: null as never, ...budget }),
      'file_baseline_invalid',
    );
  } finally {
    await f.close();
  }
});

test('root, protected component prefixes, unsafe paths, symlinks, hardlinks and directories remain closed', async () => {
  const f = fixture(['protected', '.git']);
  try {
    mkdirSync(join(f.root, 'protected'));
    mkdirSync(join(f.root, '.git'));
    mkdirSync(join(f.root, 'dir'));
    writeFileSync(join(f.root, 'protected', 'data'), 'secret');
    writeFileSync(join(f.root, '.gitignore'), 'plain');
    const ok = await f.files.readBytes('.gitignore', budget);
    expect(ok.baseline.size).toBe(5);
    for (const path of ['protected', 'protected/data', '.git/config']) {
      await denied(f.files.readBytes(path, budget), 'file_path_protected');
      await denied(
        f.files.restore({ path, bytes: Buffer.from('bad'), base: null, ...budget }),
        'file_path_protected',
      );
      await denied(f.files.remove({ path, base: ok.baseline, ...budget }), 'file_path_protected');
    }
    for (const path of ['', '/', '../data', './data', 'a/../data', 'a\\data'])
      await denied(f.files.readBytes(path, budget), 'file_path_invalid');
    symlinkSync(join(f.root, 'protected'), join(f.root, 'escape'));
    symlinkSync(join(f.root, '.gitignore'), join(f.root, 'link'));
    for (const path of ['escape/data', 'link', 'dir']) {
      await denied(f.files.readBytes(path, budget));
      await denied(
        f.files.restore({ path, bytes: Buffer.from('bad'), base: ok.baseline, ...budget }),
      );
      await denied(f.files.remove({ path, base: ok.baseline, ...budget }));
    }
    linkSync(join(f.root, '.gitignore'), join(f.root, 'hard'));
    await denied(f.files.readBytes('hard', budget), 'file_owner_invalid');
    await denied(
      f.files.restore({ path: 'hard', bytes: Buffer.from('bad'), base: ok.baseline, ...budget }),
      'file_owner_invalid',
    );
    await denied(
      f.files.remove({ path: 'hard', base: ok.baseline, ...budget }),
      'file_owner_invalid',
    );
    expect(readFileSync(join(f.root, 'protected/data'), 'utf8')).toBe('secret');
    expect(readFileSync(join(f.root, '.gitignore'), 'utf8')).toBe('plain');
    for (const path of ['', '/', '../p', './p'])
      expect(() => createWorkspaceFiles({ root: f.root, protectedPaths: [path] })).toThrow();
  } finally {
    await f.close();
  }
});

test('original Workspace identity and explicit host size bound survive new primitives', async () => {
  const f = fixture();
  const moved = `${f.root}-moved`;
  try {
    writeFileSync(join(f.root, 'data'), 'original');
    const baseline = (await f.files.readBytes('data', budget)).baseline;
    const limited = createWorkspaceFiles({ root: f.root, maxFileBytes: 2 });
    try {
      await denied(limited.readBytes('data', budget), 'file_too_large');
    } finally {
      await limited.close();
    }
    renameSync(f.root, moved);
    mkdirSync(f.root);
    writeFileSync(join(f.root, 'data'), 'foreign');
    await denied(f.files.readBytes('data', budget), 'file_root_changed');
    await denied(
      f.files.restore({ path: 'data', bytes: Buffer.from('bad'), base: baseline, ...budget }),
      'file_root_changed',
    );
    await denied(f.files.remove({ path: 'data', base: baseline, ...budget }), 'file_root_changed');
    expect(readFileSync(join(f.root, 'data'), 'utf8')).toBe('foreign');
    expect(readFileSync(join(moved, 'data'), 'utf8')).toBe('original');
  } finally {
    await f.close();
    rmSync(moved, { recursive: true, force: true });
  }
});

test('real fsync failures distinguish zero publication, committed restore/remove unknown, and last-check drift', () => {
  const entry = new URL('../../../src/files.ts', import.meta.url).pathname;
  const child = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `
    import {mock} from 'bun:test';
    import * as fs from 'node:fs';
    const actual = {...fs};
    let mode = '';
    let target = '';
    let writtenFd = -1;
    let directorySynced = false;
    mock.module('node:fs', () => ({...actual, fsyncSync(fd) {
      if (mode === 'before' && actual.fstatSync(fd).isFile()) throw new Error('injected before publication');
      if (mode === 'drift' && actual.fstatSync(fd).isFile()) actual.writeFileSync(target, 'external');
      actual.fsyncSync(fd);
      if (mode === 'close' && actual.fstatSync(fd).isDirectory()) directorySynced = true;
      if (mode === 'after' && actual.fstatSync(fd).isDirectory()) throw new Error('injected after publication');
    }, writeFileSync(fd, ...args) {
      if (mode === 'close' && typeof fd === 'number') writtenFd = fd;
      return actual.writeFileSync(fd, ...args);
    }, closeSync(fd) {
      actual.closeSync(fd);
      if (mode === 'close' && directorySynced && fd === writtenFd) throw new Error('injected published fd close');
    }}));
    const {createWorkspaceFiles} = await import(${JSON.stringify(entry)});
    const root = actual.realpathSync(actual.mkdtempSync('/private/tmp/kite-files-fsync-'));
    const files = createWorkspaceFiles({root});
    const budget = {maxBytes:1024};
    const facts = [];
    async function run(operation) {try {await operation; return 'success';} catch(e) {return e.code;}}
    try {
      target = root + '/data'; actual.writeFileSync(target,'original');
      const original = await files.readBytes('data',budget);
      mode = 'before'; facts.push(await run(files.restore({path:'data',base:original.baseline,bytes:Buffer.from('next'),...budget})), actual.readFileSync(target,'utf8'));
      mode = 'drift'; facts.push(await run(files.restore({path:'data',base:original.baseline,bytes:Buffer.from('next'),...budget})), actual.readFileSync(target,'utf8'));
      mode = ''; const current = await files.readBytes('data',budget);
      mode = 'after'; facts.push(await run(files.restore({path:'data',base:current.baseline,bytes:Buffer.from('published'),...budget})), actual.readFileSync(target,'utf8'));
      mode = ''; const published = await files.readBytes('data',budget);
      mode = 'after'; facts.push(await run(files.remove({path:'data',base:published.baseline,...budget})), actual.existsSync(target));
      mode = 'after'; facts.push(await run(files.restore({path:'new',base:null,bytes:Buffer.from('created'),...budget})), actual.readFileSync(root+'/new','utf8'), actual.statSync(root+'/new').nlink);
      mode = ''; const created = await files.readBytes('new',budget);
      mode = 'close'; facts.push(await run(files.restore({path:'new',base:created.baseline,bytes:Buffer.from('closed'),...budget})), actual.readFileSync(root+'/new','utf8'));
      facts.push(actual.readdirSync(root).filter(name=>name.startsWith('.kite-write-')).length);
      console.log(JSON.stringify(facts));
    } finally {await files.close(); actual.rmSync(root,{recursive:true,force:true});}
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual(
    [
      undefined,
      'original',
      'file_baseline_conflict',
      'external',
      'file_publish_outcome_unknown',
      'published',
      'file_publish_outcome_unknown',
      false,
      'file_publish_outcome_unknown',
      'created',
      1,
      'file_publish_outcome_unknown',
      'closed',
      0,
    ].map((value) => (value === undefined ? null : value)),
  );
});

test('built public byte leaf executes outside the source tree with exact restore/remove facts', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-built-files-recovery-')));
  try {
    const entry = new URL('../../../src/files.ts', import.meta.url).pathname;
    const built = join(root, 'files.js');
    const build = Bun.spawnSync(
      [process.execPath, 'build', entry, '--target=bun', '--outfile', built],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const child = Bun.spawnSync(
      [
        process.execPath,
        '--eval',
        `
      import {readFileSync, mkdirSync} from 'node:fs';
      const {createWorkspaceFiles}=await import(${JSON.stringify(built)});
      mkdirSync('workspace');
      const files=createWorkspaceFiles({root:process.cwd()+'/workspace'});
      const bytes=Buffer.from([239,187,191,13,10,0,255,128]);
      try {
        const created=await files.restore({path:'binary',bytes,base:null,maxBytes:1024});
        const read=await files.readBytes('binary',{maxBytes:1024});
        const actual=readFileSync('workspace/binary');
        const removed=await files.remove({path:'binary',base:read.baseline,maxBytes:1024});
        console.log(JSON.stringify({bytes:Array.from(actual),same:created.baseline.hash===read.baseline.hash,removed:removed.removedBaseline.hash===read.baseline.hash}));
      } finally {await files.close();}
    `,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      bytes: [239, 187, 191, 13, 10, 0, 255, 128],
      same: true,
      removed: true,
    });
    expect(existsSync(join(root, 'workspace/binary'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
