import { createHash, randomUUID } from 'node:crypto';
import type { NativeCredentialEntry } from './os-credentials';
import { ConfigurationError } from './types';

const prefix = 'kite-owned-chunks:';
const partSize = 1000;
const maxBytes = 65536;
const maxParts = Math.ceil((Math.ceil(maxBytes / 3) * 4) / partSize);
type Manifest = {
  state: 'writing' | 'ready';
  nonce: string;
  parts: number;
  bytes: number;
  sha256: string;
};
function fail(): never {
  throw new ConfigurationError('credential_unavailable');
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function manifest(value: string): Manifest {
  try {
    const row = JSON.parse(value.slice(prefix.length)) as Manifest;
    if (
      Object.keys(row).sort().join(',') !== 'bytes,nonce,parts,sha256,state' ||
      !['writing', 'ready'].includes(row.state) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.nonce) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      row.bytes > maxBytes ||
      !Number.isSafeInteger(row.parts) ||
      row.parts !== Math.ceil((Math.ceil(row.bytes / 3) * 4) / partSize) ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      fail();
    return row;
  } catch {
    return fail();
  }
}

/** Windows-owned OAuth only. Fixed bounded slots let deletion cover interrupted writes, too. */
export function windowsOwnedCredential(
  base: NativeCredentialEntry,
  part: (index: number) => Promise<NativeCredentialEntry>,
): NativeCredentialEntry {
  const remove = async (entry: NativeCredentialEntry) => {
    if (!(await entry.deleteCredential()) && (await entry.getPassword()) != null) fail();
    if ((await entry.getPassword()) != null) fail();
  };
  const read = async (): Promise<string | null> => {
    const saved = await base.getPassword();
    if (saved == null || !saved.startsWith(prefix)) return saved ?? null;
    const row = manifest(saved);
    if (row.state !== 'ready') fail();
    let encoded = '';
    for (let index = 0; index < row.parts; index++) {
      const chunk = await (await part(index)).getPassword();
      if (typeof chunk !== 'string' || !chunk.startsWith(`${row.nonce}:`)) fail();
      const value = chunk.slice(row.nonce.length + 1);
      if (!value || value.length > partSize || (index < row.parts - 1 && value.length !== partSize))
        fail();
      encoded += value;
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.length !== row.bytes ||
      bytes.toString('base64') !== encoded ||
      digest(bytes) !== row.sha256
    )
      fail();
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if ((await base.getPassword()) !== saved) fail();
    return value;
  };
  return {
    getPassword: read,
    async setPassword(value) {
      const bytes = Buffer.from(value, 'utf8');
      if (!bytes.length || bytes.length > maxBytes || bytes.toString('utf8') !== value) fail();
      const encoded = bytes.toString('base64');
      const row: Manifest = {
        state: 'writing',
        nonce: randomUUID(),
        parts: Math.ceil(encoded.length / partSize),
        bytes: bytes.length,
        sha256: digest(bytes),
      };
      const writing = prefix + JSON.stringify(row);
      // Publish the bounded write intent first. Partial writes are unreadable and remain removable.
      await base.setPassword(writing);
      for (let index = 0; index < row.parts; index++) {
        if ((await base.getPassword()) !== writing) fail();
        await (await part(index)).setPassword(
          `${row.nonce}:${encoded.slice(index * partSize, (index + 1) * partSize)}`,
        );
      }
      for (let index = row.parts; index < maxParts; index++) await remove(await part(index));
      if ((await base.getPassword()) !== writing) fail();
      await base.setPassword(prefix + JSON.stringify({ ...row, state: 'ready' }));
      if ((await read()) !== value) fail();
    },
    async deleteCredential() {
      // The account domain is fixed by the caller; no enumeration or unrelated account is touched.
      for (let index = 0; index < maxParts; index++) await remove(await part(index));
      await remove(base);
      return true;
    },
  };
}
