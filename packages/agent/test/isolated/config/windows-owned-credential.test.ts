import { expect, test } from '#kite-test';
import type { NativeCredentialEntry } from '../../../src/config/os-credentials';
import { windowsOwnedCredential } from '../../../src/config/windows-owned-credential';

function fixture() {
  const values = new Map<string, string>();
  let interrupted: number | undefined;
  let deleteFailure: string | undefined;
  let mutateRead: (() => void) | undefined;
  let publicationUnknown = false;
  const entry = (key: string): NativeCredentialEntry => ({
    async getPassword() {
      const result = values.get(key);
      if (key === 'part-0' && mutateRead) {
        const change = mutateRead;
        mutateRead = undefined;
        change();
      }
      return result ?? null;
    },
    async setPassword(value) {
      if (Buffer.byteLength(value, 'utf16le') > 2560) throw Error('native_size_limit');
      if (key === `part-${interrupted}`) throw Error('native_write_interrupted');
      values.set(key, value);
      if (publicationUnknown && key === 'base' && value.includes('"state":"ready"'))
        throw Error('native_publication_unknown');
    },
    async deleteCredential() {
      if (key === deleteFailure) throw Error('native_delete_failed');
      return values.delete(key);
    },
  });
  const fresh = () => windowsOwnedCredential(entry('base'), async (i) => entry(`part-${i}`));
  return {
    values,
    fresh,
    interrupt: (i?: number) => {
      interrupted = i;
    },
    failDelete: (key?: string) => {
      deleteFailure = key;
    },
    mutateRead: (change: () => void) => {
      mutateRead = change;
    },
    publicationUnknown: () => {
      publicationUnknown = true;
    },
  };
}

test('Windows owned material supports the full UTF-8 bound in native-size entries and fresh readers', async () => {
  const f = fixture();
  const maximum = 'x'.repeat(65536);
  await f.fresh().setPassword(maximum);
  expect(await f.fresh().getPassword()).toBe(maximum);
  expect([...f.values.values()].every((v) => Buffer.byteLength(v, 'utf16le') <= 2560)).toBe(true);
  await expect(f.fresh().setPassword(`${maximum}x`)).rejects.toThrow('credential_unavailable');
  expect(await f.fresh().getPassword()).toBe(maximum);
  const unicode = '认证🔑'.repeat(2000);
  await f.fresh().setPassword(unicode);
  expect(await f.fresh().getPassword()).toBe(unicode);
  await f.fresh().setPassword('small');
  expect(f.values.size).toBe(2);
  expect(await f.fresh().getPassword()).toBe('small');
  await f.fresh().deleteCredential();
  expect(f.values.size).toBe(0);
});

test('interrupted writes cannot expose mixed materials and clearing removes every bounded slot', async () => {
  const f = fixture();
  await f.fresh().setPassword('old'.repeat(1000));
  f.interrupt(2);
  await expect(f.fresh().setPassword('new'.repeat(4000))).rejects.toThrow(
    'native_write_interrupted',
  );
  await expect(f.fresh().getPassword()).rejects.toThrow('credential_unavailable');
  f.interrupt();
  f.failDelete('part-1');
  await expect(f.fresh().deleteCredential()).rejects.toThrow('native_delete_failed');
  expect(f.values.has('base')).toBe(true);
  f.failDelete();
  await f.fresh().deleteCredential();
  expect(f.values.size).toBe(0);
  expect(await f.fresh().getPassword()).toBeNull();
});

test('missing, tampered or concurrently replaced parts fail closed and legacy material stays readable', async () => {
  const f = fixture();
  f.values.set('base', 'legacy OAuth material');
  expect(await f.fresh().getPassword()).toBe('legacy OAuth material');
  await f.fresh().setPassword('secret'.repeat(500));
  const part = f.values.get('part-0')!;
  f.values.set('part-0', part.slice(0, -1) + (part.endsWith('A') ? 'B' : 'A'));
  await expect(f.fresh().getPassword()).rejects.toThrow('credential_unavailable');
  await f.fresh().setPassword('secret'.repeat(500));
  f.mutateRead(() => f.values.set('base', 'replacement'));
  await expect(f.fresh().getPassword()).rejects.toThrow('credential_unavailable');
  await f.fresh().deleteCredential();
  expect(f.values.size).toBe(0);
});

test('an error after native publication keeps the actual material and leaves every slot explicitly removable', async () => {
  const f = fixture();
  f.publicationUnknown();
  const value = 'published'.repeat(500);
  await expect(f.fresh().setPassword(value)).rejects.toThrow('native_publication_unknown');
  expect(await f.fresh().getPassword()).toBe(value);
  await f.fresh().deleteCredential();
  expect(f.values.size).toBe(0);
});
