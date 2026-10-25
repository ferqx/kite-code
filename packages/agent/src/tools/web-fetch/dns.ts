import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { WebFetchError } from './network-errors';

export interface WebDnsSettings {
  readonly url: string;
  readonly addresses: readonly string[];
}
export const defaultWebDns: WebDnsSettings = Object.freeze({
  url: 'https://cloudflare-dns.com/dns-query',
  addresses: Object.freeze(['1.1.1.1', '1.0.0.1']),
});
export function fakeIp(address: string): boolean {
  if (isIP(address) === 4) return /^198\.(18|19)\./.test(address);
  if (isIP(address) === 6)
    return (
      new URL(`http://[${address}]/`).hostname.toLowerCase().startsWith('[2001:2:0:') ||
      /^\[2001:2::/.test(new URL(`http://[${address}]/`).hostname.toLowerCase())
    );
  return false;
}
function query(host: string, type: number) {
  const names = host.toLowerCase().replace(/\.$/, '').split('.');
  if (host.length > 253 || names.some((name) => !/^[a-z0-9_-]{1,63}$/.test(name)))
    throw new WebFetchError('web_dns_unavailable');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(randomInt(65536), 0);
  header.writeUInt16BE(0x100, 2);
  header.writeUInt16BE(1, 4);
  const question = Buffer.concat([
    ...names.map((name) => Buffer.concat([Buffer.from([name.length]), Buffer.from(name)])),
    Buffer.from([0, 0, type, 0, 1]),
  ]);
  return Buffer.concat([header, question]);
}
function answers(bytes: Buffer, request: Buffer, host: string, type: number): string[] {
  const invalid = (): never => {
    throw new WebFetchError('web_dns_unavailable');
  };
  const u16 = (at: number) => (at + 2 <= bytes.length ? bytes.readUInt16BE(at) : invalid());
  if (
    bytes.length < 12 ||
    bytes.length > 65535 ||
    u16(0) !== request.readUInt16BE(0) ||
    (u16(2) & 0xfa00) !== 0x8000 ||
    u16(4) !== 1
  )
    invalid();
  const name = (start: number): { value: string; next: number } => {
    let offset = start,
      next = -1;
    const seen = new Set<number>(),
      parts: string[] = [];
    for (;;) {
      if (offset >= bytes.length || seen.has(offset) || seen.size > 128) invalid();
      seen.add(offset);
      const length = bytes[offset++]!;
      if ((length & 0xc0) === 0xc0) {
        const pointer = ((length & 63) << 8) | (bytes[offset] ?? invalid());
        if (next < 0) next = offset + 1;
        offset = pointer;
        continue;
      }
      if (length & 0xc0 || length > 63 || offset + length > bytes.length) invalid();
      if (!length) return { value: parts.join('.').toLowerCase(), next: next < 0 ? offset : next };
      parts.push(bytes.subarray(offset, offset + length).toString('ascii'));
      offset += length;
      if (parts.join('.').length > 253) invalid();
    }
  };
  const question = name(12);
  if (
    question.value !== host.toLowerCase().replace(/\.$/, '') ||
    u16(question.next) !== type ||
    u16(question.next + 2) !== 1
  )
    invalid();
  const rcode = u16(2) & 15;
  if (rcode !== 0 && rcode !== 3) invalid();
  let at = question.next + 4;
  const count = u16(6) + u16(8) + u16(10);
  if (count > 1024) invalid();
  const aliases = new Map<string, string>(),
    records: { owner: string; address: string }[] = [];
  for (let i = 0; i < count; i++) {
    const owner = name(at);
    at = owner.next;
    const kind = u16(at),
      klass = u16(at + 2),
      length = u16(at + 8);
    at += 10;
    if (at + length > bytes.length) invalid();
    if (i < u16(6) && klass === 1) {
      if (kind === 5) {
        const alias = name(at);
        if (
          alias.next !== at + length ||
          (aliases.has(owner.value) && aliases.get(owner.value) !== alias.value)
        )
          invalid();
        aliases.set(owner.value, alias.value);
      } else if (kind === type) {
        if (length !== (type === 1 ? 4 : 16)) invalid();
        const address =
          type === 1
            ? [...bytes.subarray(at, at + 4)].join('.')
            : Array.from({ length: 8 }, (_, j) => bytes.readUInt16BE(at + j * 2).toString(16)).join(
                ':',
              );
        records.push({ owner: owner.value, address });
      }
    }
    at += length;
  }
  if (at !== bytes.length) invalid();
  const allowed = new Set<string>();
  let owner = question.value;
  for (;;) {
    if (allowed.has(owner)) invalid();
    allowed.add(owner);
    const next = aliases.get(owner);
    if (!next) break;
    owner = next;
  }
  return rcode === 3
    ? []
    : records.filter((record) => allowed.has(record.owner)).map((record) => record.address);
}
export async function resolveWebDns(
  host: string,
  exchange: (body: Uint8Array) => Promise<Uint8Array>,
): Promise<{ address: string; family: 4 | 6 }[]> {
  const result: { address: string; family: 4 | 6 }[] = [];
  for (const type of [1, 28]) {
    const request = query(host, type);
    for (const address of answers(Buffer.from(await exchange(request)), request, host, type))
      result.push({ address, family: type === 1 ? 4 : 6 });
  }
  return result;
}
