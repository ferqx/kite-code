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
export function nativeModelPreferences(directory: string) {
  function path(storeId: string) {
    if (typeof storeId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(storeId))
      throw Error('model_preference_invalid');
    return join(directory, `${createHash('sha256').update(storeId).digest('hex')}.json`);
  }
  function checkDirectory() {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('model_preference_unavailable');
  }
  return {
    read(storeId: string): NativeRecommendedModel | null {
      const file = path(storeId);
      let fd: number | undefined;
      try {
        checkDirectory();
        if (lstatSync(file).isSymbolicLink()) throw Error('model_preference_unavailable');
        fd = openSync(file, 'r');
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024)
          throw Error('model_preference_unavailable');
        const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
        if (!isNativeRecommendedModel(value)) throw Error('model_preference_invalid');
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw Error('model_preference_unavailable');
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    remember(storeId: string, choice: NativeRecommendedModel) {
      const file = path(storeId);
      if (!isNativeRecommendedModel(choice)) throw Error('model_preference_invalid');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      checkDirectory();
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        try {
          writeFileSync(fd, JSON.stringify(choice));
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
