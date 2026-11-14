import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  directoryLink,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import {
  collectOutputFiles,
  enumerateOutputFiles,
  prepareOutputDirectory,
} from '../../../src/business/output-collection';
import type { JobContext } from '../../../src/extensions';
import { launchIdentityAsync } from '../../../src/jobs/launch-identity';
import type { OutputCollection } from '../../../src/output-files';
import type { AgentRuntime } from '../../../src/runtime';
import { AgentError } from '../../../src/storage/types';
import { createWorkspaceFileIo } from '../../../src/tools/files-io';

async function fixture() {
  const root = temporaryDirectory('kite-output-identity-');
  const producer = join(root, 'producer');
  mkdirSync(producer);
  const context = { signal: new AbortController().signal } as JobContext;
  let allocation!: OutputCollection['allocation'];
  const original = await launchIdentityAsync(producer);
  try {
    const result = await prepareOutputDirectory(
      {
        async allocateShellOutput(_context, identity, outputIdentity) {
          // Simulate the durable JSON boundary; never retain native handles in records.
          allocation = JSON.parse(
            JSON.stringify({ identity, outputIdentity, outputRelativePath: 'out' }),
          );
          return { allocation } as OutputCollection;
        },
      } as AgentRuntime,
      context,
      original,
    );
    return {
      root,
      producer,
      context,
      original,
      result,
      collection: { allocation } as OutputCollection,
      close: () => removeTemporaryDirectory(root),
    };
  } catch (error) {
    removeTemporaryDirectory(root);
    throw error;
  }
}

test('output allocation persists complete native identity and leaves launch identity unchanged', async () => {
  const f = await fixture();
  try {
    expect(f.collection.allocation.identity).toEqual(f.original);
    expect(f.result).toEqual({
      env: { KITE_OUTPUT_DIR: join(f.producer, 'out') },
      cleanupTransferred: true,
    });
    const fact = f.collection.allocation.outputIdentity;
    const io = createWorkspaceFileIo(fact.canonical, [], true);
    try {
      const stat = io.stat(io.root);
      expect(fact.device).toBe(String(stat.dev));
      expect(fact.inode).toBe(String(stat.ino));
    } finally {
      io.close();
    }
    mkdirSync(join(fact.path, 'nested'));
    writeFileSync(join(fact.path, 'nested', 'report.bin'), Buffer.from([0, 128, 255]));
    const files = await enumerateOutputFiles(f.collection, f.context.signal);
    expect(files).toHaveLength(1);
    expect(files[0]?.relativePath).toBe('nested/report.bin');
    expect(files[0]?.sourceIdentity.size).toBe('3');
    // The same immutable allocation can be reopened without an in-memory identity cache.
    expect(
      await enumerateOutputFiles(JSON.parse(JSON.stringify(f.collection)), f.context.signal),
    ).toEqual(files);
  } finally {
    f.close();
  }
});

for (const [field, highBit] of [
  ['device', 32n],
  ['inode', 64n],
] as const) {
  test(`output identity rejects altered high ${field} bits even when lower bits match`, async () => {
    const f = await fixture();
    try {
      const fact = f.collection.allocation.outputIdentity;
      fact[field] = String(BigInt(fact[field]) ^ (1n << highBit));
      await expect(enumerateOutputFiles(f.collection, f.context.signal)).rejects.toMatchObject({
        code: 'output_root_changed',
      });
    } finally {
      f.close();
    }
  });
}

test('legacy lstat allocation only works when its entire persisted identity matches native', async () => {
  const f = await fixture();
  try {
    const native = f.collection.allocation.outputIdentity;
    const legacy = await launchIdentityAsync(native.path);
    f.collection.allocation.outputIdentity = legacy;
    if (legacy.device === native.device && legacy.inode === native.inode) {
      expect(await enumerateOutputFiles(f.collection, f.context.signal)).toEqual([]);
    } else {
      await expect(enumerateOutputFiles(f.collection, f.context.signal)).rejects.toMatchObject({
        code: 'output_root_changed',
      });
    }
    expect(f.collection.allocation.outputIdentity).toEqual(legacy);
  } finally {
    f.close();
  }
});

for (const linked of [false, true]) {
  test(`output allocation rejects a ${linked ? 'directory link' : 'replacement directory'} at its original path`, async () => {
    const f = await fixture();
    try {
      const path = f.collection.allocation.outputIdentity.path;
      const retained = join(f.producer, 'original-out');
      renameSync(path, retained);
      if (linked) directoryLink(retained, path);
      else mkdirSync(path);
      await expect(enumerateOutputFiles(f.collection, f.context.signal)).rejects.toMatchObject({
        code: 'output_root_changed',
      });
      expect(existsSync(retained)).toBe(true);
    } finally {
      f.close();
    }
  });
}

test('collector reopens the native allocation, streams original bytes and cleans the launch directory', async () => {
  const f = await fixture();
  try {
    const content = Buffer.from([0, 1, 127, 128, 255]);
    writeFileSync(join(f.collection.allocation.outputIdentity.path, 'report.bin'), content);
    let c = {
      ...f.collection,
      id: 'collection',
      revision: '1',
      expectedFiles: null,
      state: 'pending',
      errors: [],
      source: {
        storeId: 'store',
        sessionId: 'session',
        subjectId: 'owner',
        runOriginSeq: '1',
        producerExecutionId: 'producer',
      },
    } as unknown as OutputCollection;
    let published = Buffer.alloc(0);
    let commits = 0;
    const runtime: Pick<
      AgentRuntime,
      'mutateShellOutput' | 'resolveOutputFile' | 'publishShellOutput'
    > = {
      async mutateShellOutput(_context, mutation) {
        if (mutation.kind === 'freeze') c = { ...c, expectedFiles: mutation.entries };
        if (mutation.kind === 'commit') commits++;
        if (mutation.kind === 'settle')
          c = { ...c, errors: mutation.errors, state: mutation.errors.length ? 'failed' : 'ready' };
        return c;
      },
      async resolveOutputFile() {
        throw new AgentError('output_file_not_found');
      },
      async publishShellOutput(_context, _collection, _ref, _media, chunks) {
        for await (const chunk of chunks)
          published = Buffer.concat([published, Buffer.from(chunk)]);
        return {} as Awaited<ReturnType<AgentRuntime['publishShellOutput']>>;
      },
    };
    expect(await collectOutputFiles(runtime as AgentRuntime, f.context, c.id, 1)).toMatchObject({
      outcome: 'succeeded',
      content: 'output_collection_ready',
    });
    expect(published).toEqual(content);
    expect(commits).toBe(1);
    expect(c.errors).toEqual([]);
    expect(existsSync(f.producer)).toBe(false);
  } finally {
    f.close();
  }
});
