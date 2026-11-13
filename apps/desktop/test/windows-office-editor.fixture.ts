import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeOfficeEditor } from '../electron/office-editor';
import {
  acquireDesktopProfileAccess,
  attachDesktopProfileAccess,
  prepareWindowsPrivateUi,
  windowsOfficeStorage,
} from '../electron/profile-access';
import { loadWindowsAccess, type WindowsOfficeStorage } from '../electron/windows-access';

const input = JSON.parse(process.argv[2]!);
const api = loadWindowsAccess(input.addon);
const profile = api.profileShared(join(input.root, 'data'), 'office');
assert.throws(() => profile.officeAccess('root'), /windows_access_unavailable/);
profile.preparePrivateUi();
const storage: WindowsOfficeStorage = { access: (path) => profile.officeAccess(path) };
const root = join(input.root, 'data/office/desktop-private/office-editor');
const options = { root, assetsRoot: input.assetsRoot, storage };
const editors = new Set<NativeOfficeEditor>();
const createReader = () => {
  const reader = new NativeOfficeEditor(options);
  editors.add(reader);
  return reader;
};
const f = input.history;
const open = { sourceKey: f.sourceKey, name: 'deck.pptx', check() {} };
const expected = f.snapshots[1];
const names = (await readdir(f.dir)).sort();
const before = await Promise.all(
  names.map(async (name) => [name, await readFile(join(f.dir, name))] as const),
);
try {
  assert.equal('officeWriteAccess' in profile, false);
  assert.equal('syncOfficeFile' in profile, false);
  assert.equal('apply' in NativeOfficeEditor.prototype, false);
  assert.throws(() => windowsOfficeStorage({ close() {} }), /profile_access_unavailable/);
  const facade = await acquireDesktopProfileAccess({
    ...input.profileInputs,
    profile: { dataRoot: join(input.root, 'data'), profile: 'facade' },
    windowsAsset: input.addon,
  });
  assert.throws(() => windowsOfficeStorage(facade), /profile_access_unavailable/);
  const detach = attachDesktopProfileAccess(facade, join(input.root, 'data/facade'));
  assert.throws(() => windowsOfficeStorage(facade), /windows_access_unavailable/);
  prepareWindowsPrivateUi(facade);
  const port = windowsOfficeStorage(facade);
  assert.deepEqual(Object.keys(port), ['access']);
  const independent = port.access('root');
  detach();
  assert.throws(() => port.access('root'), /profile_access_unavailable/);
  independent.verify();
  independent.release();
  facade.close();

  assert.throws(() => profile.officeAccess.call({} as never, 'root'), /windows_access_unavailable/);
  for (const path of [
    '../other',
    'C:\\secret',
    'root/file',
    'a'.repeat(63),
    `${'a'.repeat(64)}/101.pptx`,
    `${f.editorId}/pending-00000000-0000-0000-0000-000000000000`,
    `${f.editorId}/00000000-0000-0000-0000-000000000000.json`,
  ])
    assert.throws(() => profile.officeAccess(path), /windows_access_unavailable/);
  assert.throws(() => profile.officeAccess('a'.repeat(64)), /office_editor_revision_unavailable/);
  assert.deepEqual(await readdir(root), [f.editorId]);

  let reader = createReader();
  const [snapshot, concurrent] = await Promise.all([reader.open(open), reader.open(open)]);
  assert.deepEqual(snapshot, expected);
  assert.deepEqual(concurrent, expected);
  snapshot.notes.push('caller mutation');
  assert.deepEqual(await reader.open(open), expected);
  const [historical] = await Promise.all([reader.resolve(f.editorId, 0), reader.open(open)]);
  assert.deepEqual(historical.snapshot, f.snapshots[0]);
  assert.deepEqual(reader.read(f.editorId, 0).snapshot, f.snapshots[0]);
  const chunks: Buffer[] = [];
  for await (const chunk of historical.openStream()) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), await readFile(join(f.dir, '0.pptx')));
  assert.throws(() => reader.assertSource(f.editorId, 'wrong'), /office_editor_source_mismatch/);
  const destination = join(input.root, 'export.pptx');
  await reader.materialize(f.editorId, 0, destination, () => {});
  assert.deepEqual(await readFile(destination), await readFile(join(f.dir, '0.pptx')));
  let failure: 'verify' | 'release' | undefined;
  const faulty = new NativeOfficeEditor({
    ...options,
    storage: {
      access(relative) {
        const held = storage.access(relative);
        let checks = 0;
        return {
          verify() {
            held.verify();
            if (failure === 'verify' && ++checks === 2) throw Error('post-copy verify failure');
          },
          release() {
            held.release();
            if (failure === 'release') throw Error('post-copy release failure');
          },
        };
      },
    },
  });
  editors.add(faulty);
  await faulty.open(open);
  await faulty.resolve(f.editorId, 0);
  for (const mode of ['verify', 'release'] as const) {
    failure = mode;
    const output = join(input.root, `${mode}-failed.pptx`);
    await assert.rejects(
      faulty.materialize(f.editorId, 0, output, () => {}),
      /post-copy/,
    );
    await assert.rejects(readFile(output), /ENOENT/);
  }
  failure = undefined;
  const existing = join(input.root, 'existing-user-file.pptx');
  await writeFile(existing, 'do not delete existing data');
  await assert.rejects(
    faulty.materialize(f.editorId, 0, existing, () => {}),
    /EEXIST/,
  );
  assert.equal(await readFile(existing, 'utf8'), 'do not delete existing data');
  await assert.rejects(faulty.close(), /office_editor_close_unknown/);
  editors.delete(faulty);
  const cancelled = join(input.root, 'cancelled.pptx');
  let checks = 0;
  await assert.rejects(
    reader.materialize(f.editorId, 0, cancelled, () => {
      if (++checks === 2) throw Error('scope changed');
    }),
    /scope changed/,
  );
  await assert.rejects(readFile(cancelled), /ENOENT/);
  await reader.close();
  reader = createReader();
  assert.deepEqual(await reader.open(open), expected);
  await assert.rejects(
    reader.open({ ...open, sourceKey: 'missing history' }),
    /office_editor_revision_unavailable/,
  );
  assert.deepEqual(await readdir(root), [f.editorId]);

  const path = join(f.dir, '1.pptx'),
    alias = join(input.root, 'hardlink.pptx');
  await link(path, alias);
  assert.throws(() => reader.read(f.editorId, 1).openStream(), /windows_access_unavailable/);
  await rm(alias);
  const guard = profile.officeAccess(`${f.editorId}/1.pptx`);
  await assert.rejects(writeFile(path, 'must not write'));
  const acl = (args: string[]) => {
    const result = spawnSync(
      join(process.env.SystemRoot!, 'System32/icacls.exe'),
      [path, ...args],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  acl(['/grant', '*S-1-1-0:(R)']);
  try {
    assert.throws(() => guard.verify(), /windows_access_unavailable/);
    assert.throws(() => profile.officeAccess(`${f.editorId}/1.pptx`), /windows_access_unavailable/);
  } finally {
    acl(['/remove:g', '*S-1-1-0']);
  }
  guard.verify();
  guard.release();
  await reader.close();

  const current = join(f.dir, 'current.json'),
    archive = join(f.dir, '1.json');
  const currentBytes = await readFile(current),
    archiveBytes = await readFile(archive);
  await writeFile(archive, JSON.stringify({ ...expected, sourceHash: '0'.repeat(64) }));
  const corrupt = createReader();
  await assert.rejects(corrupt.open(open), /office_editor_recovery_invalid/);
  await corrupt.close();
  await writeFile(archive, archiveBytes);
  await writeFile(current, JSON.stringify({ ...expected, editorId: 'f'.repeat(64) }));
  const mismatched = createReader();
  await assert.rejects(mismatched.open(open), /office_editor_recovery_invalid/);
  await mismatched.close();
  await writeFile(current, currentBytes);
  for (const missing of [current, archive, path]) {
    const bytes = await readFile(missing);
    await rm(missing);
    const missingReader = createReader();
    await assert.rejects(missingReader.open(open), /office_editor_revision_unavailable/);
    await missingReader.close();
    await assert.rejects(readFile(missing), /ENOENT/);
    await writeFile(missing, bytes);
  }
  const streamReader = createReader();
  await streamReader.open(open);
  const stream = streamReader.read(f.editorId, 1).openStream();
  await streamReader.close();
  assert.equal(stream.closed, true);
  await assert.rejects(streamReader.open(open), /office_editor_closed/);

  const delayed = createReader();
  const internals = delayed as unknown as { inspect(path: string): Promise<[]> };
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  internals.inspect = async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return [];
  };
  const opening = delayed.open(open);
  await ready;
  let closed = false;
  const closing = delayed.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await opening;
  await closing;
  assert.equal(closed, true);
  for (const [name, bytes] of before) assert.deepEqual(await readFile(join(f.dir, name)), bytes);
  assert.deepEqual((await readdir(f.dir)).sort(), names);
  const retained = profile.officeAccess('root');
  profile.release();
  retained.verify();
  assert.throws(() => profile.officeAccess('root'), /windows_access_unavailable/);
  retained.release();
  console.log(
    JSON.stringify({
      phase: 'WINDOWS_OFFICE_NATIVE_PASS',
      revision: 1,
      readOnly: true,
      checks: [
        'no writer API',
        'genuine prepared live lease',
        'closed historical namespace',
        'no missing-directory creation',
        'shared open and concurrent historical resolve',
        'cold history and exact hashes',
        'read-only export and stream',
        'hardlink and immutable pin',
        'live ACL refusal',
        'no restoration on missing objects',
        'operation and stream drain',
        'independent retained SH lifetime',
      ],
    }),
  );
} finally {
  for (const reader of editors) await reader.close();
  profile.release();
}
