import { dlopen, type Pointer, ptr } from 'bun:ffi';
import { closeSync, readSync, writeSync } from 'node:fs';
import type { AuthorityKeyV1 } from './authority-boundary';

/** The inherited descriptor immediately after the fd 3 supervisor lock. */
export const POSIX_AUTHORITY_FRAME_KEY_FD_V1 = 4;
const AUTHORITY_KEY_BOOTSTRAP_MAGIC_V1 = Buffer.from('KITEAFK1', 'ascii');
const AUTHORITY_KEY_BOOTSTRAP_VERSION_V1 = 1;
const AUTHORITY_KEY_BYTES_V1 = 32;
const AUTHORITY_KEY_ID_BYTES_MAX_V1 = 255;
const AUTHORITY_KEY_RECORD_BYTES_MAX_V1 =
  AUTHORITY_KEY_BOOTSTRAP_MAGIC_V1.byteLength +
  1 +
  2 +
  AUTHORITY_KEY_ID_BYTES_MAX_V1 +
  AUTHORITY_KEY_BYTES_V1;
const F_SETFD_V1 = 2;
const FD_CLOEXEC_V1 = 1;

interface PosixAuthorityKeyPipeV1 {
  readonly readFd: number;
  write(key: AuthorityKeyV1): void;
  closeRead(): void;
  closeWrite(): void;
}

/**
 * Creates an anonymous pipe whose read end is explicitly inherited by the
 * supervisor. Key material never enters argv, the environment, a filesystem
 * path, or the authority JSONL stream.
 */
export function createPosixAuthorityKeyPipeV1(): PosixAuthorityKeyPipeV1 {
  if (process.platform === 'win32') {
    throw new Error('POSIX authority key bootstrap is unavailable on Windows.');
  }
  const descriptors = new Int32Array(2);
  const api = posixPipeApi();
  const result = api.pipe(ptr(descriptors));
  const readFd = descriptors[0] ?? -1;
  const writeFd = descriptors[1] ?? -1;
  if (result !== 0 || readFd < 0 || writeFd < 0) {
    throw new Error('POSIX authority key bootstrap pipe could not be created.');
  }
  if (
    api.fcntl(readFd, F_SETFD_V1, FD_CLOEXEC_V1) === -1 ||
    api.fcntl(writeFd, F_SETFD_V1, FD_CLOEXEC_V1) === -1
  ) {
    closeSync(readFd);
    closeSync(writeFd);
    throw new Error('POSIX authority key bootstrap descriptors could not be cloexec.');
  }
  let readOpen = true;
  let writeOpen = true;
  const closeRead = (): void => {
    if (!readOpen) return;
    readOpen = false;
    try {
      closeSync(readFd);
    } catch (error) {
      if (!isBadFileDescriptor(error)) throw error;
    }
  };
  const closeWrite = (): void => {
    if (!writeOpen) return;
    writeOpen = false;
    try {
      closeSync(writeFd);
    } catch (error) {
      if (!isBadFileDescriptor(error)) throw error;
    }
  };
  return {
    readFd,
    write(key) {
      if (!writeOpen) throw new Error('POSIX authority key bootstrap pipe is closed.');
      const keyId = Buffer.from(key.keyId, 'utf8');
      if (
        !key.keyId ||
        keyId.byteLength === 0 ||
        keyId.byteLength > AUTHORITY_KEY_ID_BYTES_MAX_V1 ||
        key.key.byteLength !== AUTHORITY_KEY_BYTES_V1
      ) {
        throw new Error('POSIX authority key bootstrap material is invalid.');
      }
      const encoded = Buffer.alloc(
        AUTHORITY_KEY_BOOTSTRAP_MAGIC_V1.byteLength +
          1 +
          2 +
          keyId.byteLength +
          AUTHORITY_KEY_BYTES_V1,
      );
      let cursor = 0;
      AUTHORITY_KEY_BOOTSTRAP_MAGIC_V1.copy(encoded, cursor);
      cursor += AUTHORITY_KEY_BOOTSTRAP_MAGIC_V1.byteLength;
      encoded.writeUInt8(AUTHORITY_KEY_BOOTSTRAP_VERSION_V1, cursor++);
      encoded.writeUInt16BE(keyId.byteLength, cursor);
      cursor += 2;
      keyId.copy(encoded, cursor);
      cursor += keyId.byteLength;
      const keyBytes = Buffer.from(key.key);
      try {
        keyBytes.copy(encoded, cursor);
      } finally {
        keyBytes.fill(0);
      }
      let offset = 0;
      try {
        while (offset < encoded.byteLength) {
          const written = writeWithoutEintr(writeFd, encoded, offset, encoded.byteLength - offset);
          if (written <= 0) throw new Error('POSIX authority key bootstrap write failed.');
          offset += written;
        }
      } finally {
        encoded.fill(0);
        keyId.fill(0);
      }
    },
    closeRead,
    closeWrite,
  };
}

/** Reads exactly one bounded key record and closes the inherited descriptor. */
export function readPosixAuthorityFrameKeyV1(
  fd = POSIX_AUTHORITY_FRAME_KEY_FD_V1,
): AuthorityKeyV1 | undefined {
  const encoded = Buffer.alloc(AUTHORITY_KEY_RECORD_BYTES_MAX_V1);
  let total = 0;
  try {
    while (true) {
      if (total === encoded.byteLength) return undefined;
      const count = readWithoutEintr(fd, encoded, total, encoded.byteLength - total);
      if (count === 0) break;
      total += count;
    }
    const headerBytes = AUTHORITY_KEY_BOOTSTRAP_MAGIC_V1.byteLength + 1 + 2;
    if (total < headerBytes || !encoded.subarray(0, 8).equals(AUTHORITY_KEY_BOOTSTRAP_MAGIC_V1)) {
      return undefined;
    }
    if (encoded.readUInt8(8) !== AUTHORITY_KEY_BOOTSTRAP_VERSION_V1) return undefined;
    const keyIdBytes = encoded.readUInt16BE(9);
    const expectedBytes = headerBytes + keyIdBytes + AUTHORITY_KEY_BYTES_V1;
    if (keyIdBytes === 0 || keyIdBytes > AUTHORITY_KEY_ID_BYTES_MAX_V1 || total !== expectedBytes) {
      return undefined;
    }
    const keyIdBuffer = Buffer.from(encoded.subarray(headerBytes, headerBytes + keyIdBytes));
    const keyBuffer = Buffer.from(encoded.subarray(headerBytes + keyIdBytes, expectedBytes));
    const keyId = keyIdBuffer.toString('utf8');
    const normalizedKeyId = Buffer.from(keyId, 'utf8');
    const validKeyId = normalizedKeyId.compare(keyIdBuffer) === 0;
    normalizedKeyId.fill(0);
    keyIdBuffer.fill(0);
    if (!validKeyId) {
      keyBuffer.fill(0);
      return undefined;
    }
    return { keyId, key: keyBuffer };
  } catch {
    return undefined;
  } finally {
    encoded.fill(0);
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already be closed by a failed bootstrap.
    }
  }
}

let cachedPipeApi:
  | {
      pipe(descriptors: Pointer): number;
      fcntl(fd: number, command: number, value: number): number;
    }
  | undefined;

function posixPipeApi(): {
  pipe(descriptors: Pointer): number;
  fcntl(fd: number, command: number, value: number): number;
} {
  if (cachedPipeApi) return cachedPipeApi;
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  cachedPipeApi = dlopen(library, {
    pipe: { args: ['ptr'], returns: 'i32' },
    fcntl: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
  }).symbols as unknown as {
    pipe(descriptors: Pointer): number;
    fcntl(fd: number, command: number, value: number): number;
  };
  return cachedPipeApi;
}

function writeWithoutEintr(fd: number, buffer: Buffer, offset: number, length: number): number {
  while (true) {
    try {
      return writeSync(fd, buffer, offset, length);
    } catch (error) {
      if (isEintr(error)) continue;
      throw error;
    }
  }
}

function readWithoutEintr(fd: number, buffer: Buffer, offset: number, length: number): number {
  while (true) {
    try {
      return readSync(fd, buffer, offset, length, null);
    } catch (error) {
      if (isEintr(error)) continue;
      throw error;
    }
  }
}

function isEintr(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EINTR');
}

function isBadFileDescriptor(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EBADF');
}
