import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { NativeRecommendedModel } from '../src/native-bridge';
import { isNativeRecommendedModel } from '../src/native-model-preference-bridge';

/** Client display preferences survive renderer origins and never select a Session route. */
export function nativeDisplayPreferences<T>(
  directory: string,
  validate: (value: unknown) => value is T,
  maxBytes: number,
  errorPrefix: string,
) {
  const path = (key: string) =>
    join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  function checkDirectory() {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`${errorPrefix}_unavailable`);
  }
  return {
    read(key: string): T | null {
      const file = path(key);
      let fd: number | undefined;
      try {
        checkDirectory();
        if (lstatSync(file).isSymbolicLink()) throw Error(`${errorPrefix}_unavailable`);
        fd = openSync(file, 'r');
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
          throw Error(`${errorPrefix}_unavailable`);
        const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
        if (!validate(value)) throw Error(`${errorPrefix}_invalid`);
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw Error(`${errorPrefix}_unavailable`);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    remember(key: string, choice: T) {
      const file = path(key);
      if (!validate(choice)) throw Error(`${errorPrefix}_invalid`);
      const encoded = JSON.stringify(choice);
      if (Buffer.byteLength(encoded) > maxBytes) throw Error(`${errorPrefix}_invalid`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      checkDirectory();
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        try {
          writeFileSync(fd, encoded);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, file);
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          /* Preserve the original save failure. */
        }
        throw error;
      }
    },
  };
}

export function nativeModelPreferences(directory: string) {
  const storage = nativeDisplayPreferences(
    directory,
    isNativeRecommendedModel,
    1024,
    'model_preference',
  );
  function key(storeId: string) {
    if (typeof storeId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(storeId))
      throw Error('model_preference_invalid');
    return storeId;
  }
  return {
    read: (storeId: string) => storage.read(key(storeId)),
    remember: (storeId: string, choice: NativeRecommendedModel) =>
      storage.remember(key(storeId), choice),
  };
}
