import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ConfigurationError } from '@kite-ai/agent/config';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { expect, test } from '#kite-test';
import { createEncryptedModelCredentialBackend } from '../../src/encrypted-model-credentials';

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-model-credentials-')));
  const user = join(root, 'user');
  privateDirectory(user);
  const directory = join(user, 'model-credentials');
  const configurationPath = join(user, 'kite-code.jsonc');
  const keys = new Map<string, Buffer>();
  const creates: string[] = [];
  const wrappingKey = {
    async read(id: string) {
      const key = keys.get(id);
      return key ? Buffer.from(key) : null;
    },
    async create(id: string, key: Buffer) {
      expect(keys.has(id)).toBe(false);
      creates.push(id);
      keys.set(id, Buffer.from(key));
    },
  };
  const open = (
    overrides: Partial<Parameters<typeof createEncryptedModelCredentialBackend>[0]> = {},
  ) => createEncryptedModelCredentialBackend({ configurationPath, wrappingKey, ...overrides });
  return {
    root,
    directory,
    configurationPath,
    keys,
    creates,
    wrappingKey,
    open,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

const id = () => `credential:${randomUUID()}`;
const record = (directory: string, ref: string) => join(directory, `${ref.slice(11)}.credential`);
const unavailable = { code: 'credential_unavailable' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('seals private records to their references and reopens with the same key and bytes', async () => {
  const f = fixture();
  try {
    const a = id();
    const b = id();
    const secret = '\ufeffSYNTHETIC_MODEL_CREDENTIAL_甲';
    await f.open().put(a, secret);
    await f.open().put(b, secret);
    expect(f.creates).toHaveLength(1);
    const aPath = record(f.directory, a);
    const bPath = record(f.directory, b);
    const aBytes = readFileSync(aPath);
    expect(aBytes.includes(secret)).toBe(false);
    expect(aBytes.equals(readFileSync(bPath))).toBe(false);
    if (process.platform !== 'win32') {
      expect(lstatSync(f.directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(aPath).mode & 0o777).toBe(0o600);
    }
    expect(await f.open().resolve(a)).toBe(secret);
    await expect(f.open().put(a, 'SYNTHETIC_REPLACEMENT')).rejects.toMatchObject(unavailable);
    writeFileSync(bPath, aBytes);
    await expect(f.open().resolve(b)).rejects.toMatchObject(unavailable);
    aBytes[aBytes.length - 1]! ^= 1;
    writeFileSync(aPath, aBytes);
    await expect(f.open().resolve(a)).rejects.toMatchObject(unavailable);
  } finally {
    f.close();
  }
});

test('serializes first key publication across instances and never recreates a lost ready key', async () => {
  const f = fixture();
  try {
    const a = id();
    const b = id();
    await Promise.all([f.open().put(a, 'SYNTHETIC_A'), f.open().put(b, 'SYNTHETIC_B')]);
    expect(f.creates).toHaveLength(1);
    expect(await f.open().resolve(a)).toBe('SYNTHETIC_A');
    expect(await f.open().resolve(b)).toBe('SYNTHETIC_B');
    f.keys.clear();
    await expect(f.open().resolve(a)).rejects.toMatchObject(unavailable);
    await expect(f.open().put(id(), 'SYNTHETIC_C')).rejects.toMatchObject(unavailable);
    const metadata = join(f.directory, 'key');
    writeFileSync(metadata, `1:pending:${f.creates[0]}`);
    const backend = f.open({ wrappingKey: { ...f.wrappingKey, authorize: async () => false } });
    await expect(backend.authorize()).rejects.toMatchObject(unavailable);
    unlinkSync(metadata);
    await expect(f.open().put(id(), 'SYNTHETIC_D')).rejects.toMatchObject(unavailable);
    expect(f.creates).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('concurrent Service processes publish one key even when each starts from an empty store', async () => {
  const f = fixture();
  const exec = promisify(execFile);
  const registrar = fileURLToPath(
    new URL('../../../../scripts/tooling/register.mjs', import.meta.url),
  );
  const entrypoint = new URL('../../src/encrypted-model-credentials.ts', import.meta.url).href;
  const run = (ref: string) =>
    exec(
      process.execPath,
      [
        '--import',
        registrar,
        '--input-type=module',
        '--eval',
        `import { readFile, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import { setTimeout as delay } from 'node:timers/promises';
        const [entrypoint, configurationPath, testRoot, ref] = process.argv.slice(1);
        const { createEncryptedModelCredentialBackend } = await import(entrypoint);
        const store = createEncryptedModelCredentialBackend({
          configurationPath,
          wrappingKey: {
            async read(keyId) {
              try { return await readFile(join(testRoot, keyId + '.fixture-key')); }
              catch (error) { if (error.code === 'ENOENT') return null; throw error; }
            },
            async create(keyId, key) {
              await delay(100);
              await writeFile(join(testRoot, keyId + '.fixture-key'), key, { flag: 'wx' });
            },
          },
        });
        await store.put(ref, 'SYNTHETIC_CROSS_PROCESS');
        if (await store.resolve(ref) !== 'SYNTHETIC_CROSS_PROCESS') process.exitCode = 1;`,
        entrypoint,
        f.configurationPath,
        f.root,
        ref,
      ],
      { timeout: 5000 },
    );
  try {
    const refs = [id(), id()];
    const results = await Promise.allSettled(refs.map(run));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    expect(readdirSync(f.root).filter((name) => name.endsWith('.fixture-key'))).toHaveLength(1);
    expect(readdirSync(f.directory).filter((name) => name.endsWith('.credential'))).toHaveLength(2);
  } finally {
    f.close();
  }
}, 8000);

test('reuses the pending key identifier after an uncertain wrapping-key create', async () => {
  const f = fixture();
  try {
    const a = id();
    const backend = f.open({
      wrappingKey: {
        ...f.wrappingKey,
        async create(keyId, key) {
          await f.wrappingKey.create(keyId, key);
          throw Error('synthetic interruption after write');
        },
      },
    });
    await expect(backend.put(a, 'SYNTHETIC_PENDING')).rejects.toMatchObject(unavailable);
    expect(await f.open().resolve(a)).toBeNull();
    await f.open().put(a, 'SYNTHETIC_PENDING');
    expect(f.creates).toHaveLength(1);
    expect(await f.open().resolve(a)).toBe('SYNTHETIC_PENDING');
  } finally {
    f.close();
  }
});

test('imports only the requested legacy value, keeps the old item, and makes revocation durable', async () => {
  const f = fixture();
  try {
    const a = id();
    const b = id();
    const lookup: string[] = [];
    const remove: string[] = [];
    const legacy = {
      async resolve(ref: string) {
        lookup.push(ref);
        return ref === a ? 'SYNTHETIC_LEGACY' : null;
      },
      async remove(ref: string) {
        remove.push(ref);
        throw Error('synthetic native refusal');
      },
    };
    expect(await f.open({ legacy }).resolve(a)).toBe('SYNTHETIC_LEGACY');
    expect(await f.open({ legacy }).resolve(a)).toBe('SYNTHETIC_LEGACY');
    expect(lookup).toEqual([a]);
    expect(remove).toEqual([]);
    await expect(f.open({ legacy }).remove(a)).rejects.toMatchObject(unavailable);
    expect(remove).toEqual([a]);
    expect(await f.open({ legacy }).resolve(a)).toBeNull();
    expect(await f.open({ legacy }).resolve(b)).toBeNull();
    expect(lookup).toEqual([a, b]);
    await expect(f.open().put(a, 'SYNTHETIC_RESURRECTION')).rejects.toMatchObject(unavailable);
  } finally {
    f.close();
  }
});

test('a legacy item that requires confirmation migrates only after explicit settings authorization', async () => {
  const f = fixture();
  try {
    const reference = id();
    let authorizations = 0;
    const backend = f.open({
      wrappingKey: {
        ...f.wrappingKey,
        async authorize() {
          return true;
        },
      },
      legacy: {
        async resolve() {
          throw new ConfigurationError('model_credentials_locked');
        },
        async authorize(ref) {
          expect(ref).toBe(reference);
          authorizations++;
          return 'SYNTHETIC_INTERACTIVE_LEGACY';
        },
        async remove() {},
      },
    });
    await expect(backend.resolve(reference)).rejects.toMatchObject({
      code: 'model_credentials_locked',
    });
    expect(authorizations).toBe(0);
    expect(f.creates).toHaveLength(0);
    await backend.authorize(reference);
    expect(await f.open().resolve(reference)).toBe('SYNTHETIC_INTERACTIVE_LEGACY');
    expect(authorizations).toBe(1);
  } finally {
    f.close();
  }
});

test.each([
  false,
  true,
])('an in-flight legacy lookup cannot resurrect a concurrently revoked credential (lookup failure: %s)', async (fails) => {
  const f = fixture();
  try {
    const a = id();
    const entered = deferred<void>();
    const released = deferred<string>();
    const legacy = {
      async resolve() {
        entered.resolve();
        const result = await released.promise;
        if (fails) throw new ConfigurationError('model_credentials_locked');
        return result;
      },
      async remove() {},
    };
    const pending = f.open({ legacy }).resolve(a);
    await entered.promise;
    await f.open().remove(a);
    released.resolve('SYNTHETIC_LATE_LEGACY');
    expect(await pending).toBeNull();
    expect(f.creates).toHaveLength(0);
  } finally {
    f.close();
  }
});

test('explicit authorization releases the store lock and normal reads stay silent', async () => {
  const f = fixture();
  try {
    const a = id();
    const b = id();
    const entered = deferred<string>();
    const released = deferred<void>();
    const wrappingKey = {
      ...f.wrappingKey,
      async authorize(keyId: string) {
        entered.resolve(keyId);
        await released.promise;
        return true;
      },
    };
    const backend = f.open({ wrappingKey });
    await backend.authorize();
    await backend.put(a, 'SYNTHETIC_AUTHORIZED');
    const interactive = backend.authorize();
    expect(await entered.promise).toBe(f.creates[0]);
    await f.open().put(b, 'SYNTHETIC_CONCURRENT');
    released.resolve();
    await interactive;
    const locked = f.open({
      wrappingKey: {
        ...wrappingKey,
        async read() {
          throw new ConfigurationError('model_credentials_locked');
        },
        async authorize() {
          throw Error('ordinary resolve must not authorize');
        },
      },
    });
    await expect(locked.resolve(a)).rejects.toMatchObject({ code: 'model_credentials_locked' });
    const unavailableKey = f.open({
      wrappingKey: {
        ...f.wrappingKey,
        async read() {
          throw new ConfigurationError('model_credentials_backend_unavailable');
        },
      },
    });
    await expect(unavailableKey.resolve(a)).rejects.toMatchObject({
      code: 'model_credentials_backend_unavailable',
    });
    expect(await f.open().resolve(b)).toBe('SYNTHETIC_CONCURRENT');
  } finally {
    f.close();
  }
});

test.skipIf(process.platform === 'win32')(
  'rejects weak permissions, links and traversal before legacy lookup',
  async () => {
    const f = fixture();
    try {
      const a = id();
      const b = id();
      const calls: string[] = [];
      const backend = f.open({
        legacy: {
          async resolve(ref) {
            calls.push(ref);
            return null;
          },
          async remove() {},
        },
      });
      await backend.put(a, 'SYNTHETIC_PRIVATE');
      const aPath = record(f.directory, a);
      const bPath = record(f.directory, b);
      chmodSync(aPath, 0o644);
      await expect(backend.resolve(a)).rejects.toMatchObject(unavailable);
      chmodSync(aPath, 0o600);
      linkSync(aPath, bPath);
      await expect(backend.resolve(a)).rejects.toMatchObject(unavailable);
      unlinkSync(bPath);
      symlinkSync(aPath, bPath);
      await expect(backend.resolve(b)).rejects.toMatchObject(unavailable);
      await expect(backend.resolve('credential:../key')).rejects.toMatchObject(unavailable);
      chmodSync(f.directory, 0o755);
      await expect(backend.resolve(a)).rejects.toMatchObject(unavailable);
      expect(calls).toEqual([]);
    } finally {
      f.close();
    }
  },
);
