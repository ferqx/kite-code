import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  acquireFileLock,
  assertLiveLock,
  ConfigurationError,
  type CredentialBackend,
  LockBusyError,
} from '@kite-ai/agent/config';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const credentialId = new RegExp(`^credential:(${uuid})$`, 'u');
const recordName = new RegExp(`^${uuid}\\.credential$`, 'u');
const keyRecord = new RegExp(`^1:(pending|ready):(${uuid})$`, 'u');
const version = 1;
const encrypted = 1;
const revoked = Buffer.from([version, 0]);
const nonceBytes = 12;
const tagBytes = 16;
const maxSecretBytes = 65536;
const prefixBytes = 2 + nonceBytes + tagBytes;
const maximumBytes = prefixBytes + maxSecretBytes;
type Operation = ReturnType<typeof openStore> & { verify(): void };

function unavailable(): never {
  throw new ConfigurationError('credential_unavailable');
}

function privateFile(info: Stats) {
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (info.mode & 0o7777) !== 0o600 ||
    info.uid !== process.getuid?.()
  )
    unavailable();
}

function sameFile(first: Stats, second: Stats) {
  if (first.dev !== second.dev || first.ino !== second.ino) unavailable();
}

function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function openStore(configurationPath: string) {
  if (
    typeof configurationPath !== 'string' ||
    !configurationPath ||
    configurationPath.includes('\0')
  )
    unavailable();
  const requestedParent = dirname(resolve(configurationPath));
  const windows = defaultWindowsPathSecurity();
  privateDirectory(requestedParent);
  const parent = realpathSync.native(requestedParent);
  const parentInfo = lstatSync(requestedParent);
  if (
    !parentInfo.isDirectory() ||
    (!windows && ((parentInfo.mode & 0o022) !== 0 || parentInfo.uid !== process.getuid?.()))
  )
    unavailable();
  const directory = join(parent, 'model-credentials');
  if (windows) privateDirectory(directory);
  else {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const original = lstatSync(directory);
  function verifyDirectory() {
    const currentParent = lstatSync(requestedParent);
    if (
      !currentParent.isDirectory() ||
      (!windows && ((currentParent.mode & 0o022) !== 0 || currentParent.uid !== process.getuid?.()))
    )
      unavailable();
    sameFile(parentInfo, currentParent);
    if (realpathSync.native(requestedParent) !== parent) unavailable();
    if (windows) {
      windows.verifyDirectory(parent);
      windows.verifyDirectory(directory);
    }
    const current = lstatSync(directory);
    if (
      !current.isDirectory() ||
      (!windows && ((current.mode & 0o7777) !== 0o700 || current.uid !== process.getuid?.()))
    )
      unavailable();
    sameFile(original, current);
  }
  verifyDirectory();
  const lockPath = join(directory, 'records.lock');

  function read(path: string): Buffer | null {
    if (windows) {
      const content = windows.readScopeFile(path, maximumBytes, true);
      return content === null ? null : Buffer.from(content);
    }
    const initial = lstatSync(path, { throwIfNoEntry: false });
    if (!initial) return null;
    privateFile(initial);
    if (initial.size > maximumBytes) unavailable();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      privateFile(opened);
      sameFile(initial, opened);
      if (opened.size > maximumBytes) unavailable();
      const buffer = Buffer.alloc(opened.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const count = readSync(fd, buffer, total, buffer.length - total, null);
        if (!count) break;
        total += count;
      }
      const final = lstatSync(path);
      privateFile(final);
      sameFile(opened, final);
      if (total !== opened.size || final.size !== total || opened.mtimeMs !== final.mtimeMs)
        unavailable();
      return buffer.subarray(0, total);
    } finally {
      closeSync(fd);
    }
  }

  function publish(path: string, bytes: Buffer, replace: boolean, verify: () => void) {
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    if (windows) {
      const written = windows.writePrivateRecordFile(temporary, bytes);
      try {
        verify();
        windows.movePrivateEntry(temporary, path, replace);
      } finally {
        if (lstatSync(temporary, { throwIfNoEntry: false })) written.remove();
      }
    } else {
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const own = fstatSync(fd);
        privateFile(own);
        // A concurrent first caller may have created this directory just before exiting.
        // Make its name durable before acknowledging any child publication.
        syncDirectory(parent);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        verify();
        const existing = lstatSync(path, { throwIfNoEntry: false });
        if (existing) {
          if (!replace) unavailable();
          privateFile(existing);
        }
        sameFile(own, lstatSync(temporary));
        // Every writer holds the same verified exclusive lock across admission and rename.
        renameSync(temporary, path);
        syncDirectory(directory);
      } finally {
        try {
          const remaining = lstatSync(temporary, { throwIfNoEntry: false });
          if (remaining) {
            sameFile(fstatSync(fd), remaining);
            unlinkSync(temporary);
          }
        } finally {
          closeSync(fd);
        }
      }
    }
    verify();
  }

  function hasEncryptedRecords() {
    return readdirSync(directory).some(
      (name) => recordName.test(name) && !read(join(directory, name))?.equals(revoked),
    );
  }

  return { directory, lockPath, verifyDirectory, read, publish, hasEncryptedRecords };
}

type KeyStore = {
  /** Return a new buffer owned by the caller. null means the key item is absent. */
  read(keyId: string): Promise<Buffer | null>;
  /** Do not replace an existing item or interact with the user. */
  create(keyId: string, key: Buffer): Promise<void>;
  /** Return whether the item exists after any required user confirmation. */
  authorize?(keyId: string): Promise<boolean>;
};
type LegacyStore = Pick<CredentialBackend, 'resolve' | 'remove'> & {
  authorize?(id: string): Promise<string | null>;
};

function credentialError(error: unknown): never {
  if (
    error instanceof ConfigurationError &&
    (error.code === 'model_credentials_locked' ||
      error.code === 'model_credentials_backend_unavailable')
  )
    throw error;
  unavailable();
}

function pathFor(directory: string, id: string) {
  const match = credentialId.exec(id);
  if (!match || id.length !== 47) unavailable();
  return join(directory, `${match[1]}.credential`);
}

/** Same encrypted record format on all hosts. The OS owns the separately stored wrapping key. */
export function createEncryptedModelCredentialBackend(options: {
  configurationPath: string;
  wrappingKey: KeyStore;
  legacy?: LegacyStore;
}): CredentialBackend & { authorize(id?: string): Promise<void> } {
  async function locked<T>(operation: (store: Operation) => T | Promise<T>) {
    try {
      const store = openStore(options.configurationPath);
      const started = performance.now();
      for (;;) {
        store.verifyDirectory();
        let lock: ReturnType<typeof acquireFileLock>;
        try {
          lock = acquireFileLock(store.lockPath, 'exclusive');
        } catch (error) {
          if (!(error instanceof LockBusyError) || performance.now() - started >= 5000) throw error;
          await delay(20);
          continue;
        }
        const verify = () => {
          store.verifyDirectory();
          assertLiveLock(lock, store.lockPath, 'exclusive');
        };
        try {
          verify();
          const result = await operation({ ...store, verify });
          verify();
          return result;
        } finally {
          lock.release();
        }
      }
    } catch (error) {
      credentialError(error);
    }
  }

  function keyState(store: Operation) {
    const path = join(store.directory, 'key');
    const metadata = store.read(path);
    if (!metadata) return { path, state: undefined, id: undefined };
    const text = metadata.toString('latin1');
    const match = keyRecord.exec(text);
    if (!match || match[0] !== text) unavailable();
    return { path, state: match[1]!, id: match[2]! };
  }

  async function key(store: Operation, create: boolean) {
    const { path, state, id: knownId } = keyState(store);
    if (!knownId && !create) unavailable();
    if (!knownId && store.hasEncryptedRecords()) unavailable();
    const id = knownId ?? randomUUID();
    if (!knownId) store.publish(path, Buffer.from(`1:pending:${id}`), false, store.verify);
    let material = await options.wrappingKey.read(id);
    try {
      store.verify();
      if (material === null) {
        if (!create || state === 'ready') unavailable();
        // Tombstones can precede the first credential. Ciphertext may never bind to a new key.
        if (knownId && store.hasEncryptedRecords()) unavailable();
        const proposed = randomBytes(32);
        try {
          await options.wrappingKey.create(id, proposed);
          material = await options.wrappingKey.read(id);
          if (
            !Buffer.isBuffer(material) ||
            material.length !== 32 ||
            !timingSafeEqual(material, proposed)
          )
            unavailable();
        } finally {
          proposed.fill(0);
        }
      }
      if (!Buffer.isBuffer(material) || material.length !== 32) unavailable();
      store.verify();
      if (state !== 'ready') store.publish(path, Buffer.from(`1:ready:${id}`), true, store.verify);
      return Buffer.from(material);
    } finally {
      if (Buffer.isBuffer(material)) material.fill(0);
    }
  }

  async function readRecord(store: Operation, id: string) {
    const bytes = store.read(pathFor(store.directory, id));
    if (!bytes) return undefined;
    if (bytes.equals(revoked)) return null;
    if (bytes.length <= prefixBytes || bytes[0] !== version || bytes[1] !== encrypted)
      unavailable();
    const material = await key(store, false);
    let plaintext: Buffer | undefined;
    let tail: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', material, bytes.subarray(2, 2 + nonceBytes));
      decipher.setAAD(Buffer.from(`kite-model-credential-v${version}\0${id}`));
      decipher.setAuthTag(bytes.subarray(2 + nonceBytes, prefixBytes));
      plaintext = decipher.update(bytes.subarray(prefixBytes));
      tail = decipher.final();
      if (tail.length !== 0) unavailable();
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
    } finally {
      plaintext?.fill(0);
      tail?.fill(0);
      material.fill(0);
    }
  }

  async function putRecord(store: Operation, id: string, secret: string) {
    const path = pathFor(store.directory, id);
    if (
      store.read(path) !== null ||
      typeof secret !== 'string' ||
      !secret ||
      Buffer.byteLength(secret) > maxSecretBytes ||
      /[\uD800-\uDFFF]/u.test(secret)
    )
      unavailable();
    const material = await key(store, true);
    try {
      const nonce = randomBytes(nonceBytes);
      const cipher = createCipheriv('aes-256-gcm', material, nonce);
      cipher.setAAD(Buffer.from(`kite-model-credential-v${version}\0${id}`));
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      store.publish(
        path,
        Buffer.concat([Buffer.from([version, encrypted]), nonce, cipher.getAuthTag(), ciphertext]),
        false,
        store.verify,
      );
    } finally {
      material.fill(0);
    }
  }

  async function prepareKey(store: Operation) {
    (await key(store, true)).fill(0);
  }

  async function resolve(id: string, legacyLookup?: (id: string) => Promise<string | null>) {
    const local = await locked((store) => readRecord(store, id));
    if (local !== undefined) return local;
    if (!legacyLookup) return null;
    const lookup = await Promise.resolve()
      .then(() => legacyLookup(id))
      .then(
        (secret) => ({ secret }),
        (error: unknown) => ({ error }),
      );
    return locked(async (store) => {
      const current = await readRecord(store, id);
      if (current !== undefined) return current;
      if ('error' in lookup) credentialError(lookup.error);
      if (lookup.secret === null) return null;
      await putRecord(store, id, lookup.secret);
      return lookup.secret;
    });
  }

  return {
    kind: 'os',
    async authorize(ref) {
      const authorizeKey = options.wrappingKey.authorize;
      try {
        const original = authorizeKey ? await locked(keyState) : undefined;
        const keyId = original?.id;
        // Interactive reads stay outside the file lock. Absence is recoverable
        // only for the same unfinished publication without encrypted records.
        const exists = keyId ? await authorizeKey!(keyId) : true;
        if (!ref || keyId) {
          await locked(async (store) => {
            if (keyId) {
              const current = keyState(store);
              if (
                current.id !== keyId ||
                (!exists &&
                  (original.state !== 'pending' ||
                    current.state !== 'pending' ||
                    store.hasEncryptedRecords()))
              )
                unavailable();
            }
            if (!ref) await prepareKey(store);
          });
        }
        const legacy = options.legacy;
        if (
          ref &&
          legacy?.authorize &&
          (await resolve(ref, (id) => legacy.authorize!(id))) === null
        )
          unavailable();
      } catch (error) {
        credentialError(error);
      }
    },
    put(id, secret) {
      return locked((store) => putRecord(store, id, secret));
    },
    resolve(id) {
      const legacy = options.legacy;
      return resolve(id, legacy ? (ref) => legacy.resolve(ref) : undefined);
    },
    async remove(id) {
      await locked((store) => {
        const path = pathFor(store.directory, id);
        const previous = store.read(path);
        if (!previous?.equals(revoked))
          store.publish(path, revoked, previous !== null, store.verify);
      });
      try {
        await options.legacy?.remove(id);
      } catch (error) {
        credentialError(error);
      }
    },
  };
}
