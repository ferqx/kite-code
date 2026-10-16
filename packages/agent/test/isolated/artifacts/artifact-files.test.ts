import { expect, test } from 'bun:test';
import { join } from 'node:path';

// Per-probe processes contain fs/Buffer instrumentation; no global mocks enter other suites.
async function probe(mode: string, consume = 'full') {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'artifact-files.fixture.ts'), mode, consume],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: '' });
  return JSON.parse(output) as {
    mode: string;
    consume: string;
    dataBytes: number;
    allocations: number[];
    concatenations: number;
    reads: number;
    error: string | null;
    matches: boolean;
    yieldedBytes: number;
    isolatedChunks: boolean;
    openAfterYield: number;
    remainingDescriptors: number;
  };
}
const posixTest = process.platform === 'win32' ? test.skip : test;
posixTest(
  'tiny and empty Artifact consumers allocate by actual size and do not concatenate whole reads',
  async () => {
    for (const mode of ['tiny', 'empty'])
      for (const consume of ['full', 'chunks', 'verify']) {
        const result = await probe(mode, consume);
        expect(result.error).toBeNull();
        expect(result.remainingDescriptors).toBe(0);
        expect(result.matches).toBe(true);
        expect(result.allocations.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
          result.dataBytes + 1,
        );
        if (consume === 'full') expect(result.concatenations).toBe(0);
      }
  },
);
posixTest(
  'large Artifact verify uses fixed scratch, whole read owns one target, yielded chunks remain independent',
  async () => {
    for (const consume of ['verify', 'full', 'chunks']) {
      const result = await probe('large', consume);
      expect(result.error).toBeNull();
      expect(result.remainingDescriptors).toBe(0);
      expect(result.matches).toBe(true);
      if (consume === 'verify')
        expect(result.allocations.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(64 * 1024 + 1);
      if (consume === 'full') {
        expect(result.allocations.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
          result.dataBytes + 1,
        );
        expect(result.concatenations).toBe(0);
      }
      if (consume === 'chunks') {
        expect(result.yieldedBytes).toBe(result.dataBytes);
        expect(result.isolatedChunks).toBe(true);
      }
    }
  },
);
posixTest('short reads retain all UTF-8 bytes and integrity for each consumer', async () => {
  for (const consume of ['verify', 'full', 'chunks']) {
    const result = await probe('short', consume);
    expect(result.error).toBeNull();
    expect(result.matches).toBe(true);
    expect(result.remainingDescriptors).toBe(0);
    if (consume === 'chunks') expect(result.yieldedBytes).toBe(result.dataBytes);
  }
});
posixTest(
  'EOF rejects growth, truncation and ctime mutation and closes the original descriptor',
  async () => {
    for (const mode of ['growth', 'truncation', 'ctime'])
      for (const consume of ['full', 'verify', 'chunks']) {
        const result = await probe(mode, consume);
        expect(result.error).toBe('artifact_content_mismatch');
        expect(result.remainingDescriptors).toBe(0);
      }
  },
);
posixTest('hash, size, immutable-file and symlink gates remain enforced', async () => {
  for (const mode of ['hash', 'size', 'mutable', 'symlink', 'inode']) {
    const result = await probe(mode);
    expect(result.error).not.toBeNull();
    expect(result.remainingDescriptors).toBe(0);
  }
});
posixTest('generator early return and injected read failure close descriptors', async () => {
  const early = await probe('early', 'chunks');
  expect(early.error).toBeNull();
  expect(early.openAfterYield).toBe(1);
  expect(early.remainingDescriptors).toBe(0);
  for (const consume of ['verify', 'full', 'chunks']) {
    const result = await probe('io_error', consume);
    expect(result.error).toBe('EIO');
    expect(result.remainingDescriptors).toBe(0);
  }
});

posixTest(
  'invalid size and empty-content hash still pass through the integrity gates',
  async () => {
    for (const consume of ['verify', 'full', 'chunks']) {
      const invalid = await probe('invalid_size', consume);
      expect(invalid.error).toBe('artifact_size_invalid');
      expect(invalid.allocations).toEqual([]);
      expect(invalid.remainingDescriptors).toBe(0);
      const empty = await probe('empty_bad_hash', consume);
      expect(empty.error).toBe('artifact_content_mismatch');
      expect(empty.remainingDescriptors).toBe(0);
    }
  },
);
posixTest('a consumer throw closes the active generator descriptor', async () => {
  const result = await probe('throw', 'chunks');
  expect(result.error).toBe('owned_abort');
  expect(result.openAfterYield).toBe(1);
  expect(result.remainingDescriptors).toBe(0);
});

posixTest(
  'whole-read runtime capacity rejection is typed and closes the opened file before allocating',
  async () => {
    const result = await probe('runtime_limit');
    expect(result.error).toBe('artifact_content_unavailable');
    expect(result.allocations).toEqual([]);
    expect(result.remainingDescriptors).toBe(0);
  },
);
