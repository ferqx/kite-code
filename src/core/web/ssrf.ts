/** 被阻止的主机名 / Blocked hostnames */
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  // IPv6 loopback（短格式 + 长格式 + 兼容格式）
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
  '[0:0:0:0:0:0:0:1]',
  '::ffff:127.0.0.1',
  '[::ffff:127.0.0.1]',
  '169.254.169.254', // cloud metadata endpoint
  'metadata.google.internal', // GCP metadata
]);

/** 被阻止的协议 / Blocked protocols */
const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:', 'gopher:', 'data:', 'javascript:']);

/** 内网 IPv4 前缀 / Private IPv4 prefixes */
const PRIVATE_IPV4_PREFIXES = [
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
];

/** 内网 IPv6 前缀 / Private IPv6 prefixes */
const PRIVATE_IPV6_PREFIXES = [
  'fc', // fc00::/7 — Unique Local Addresses (ULA)
  'fd', // fd00::/8 — ULA (commonly used subset)
  'fe8', // fe80::/10 — Link-Local
  'fe9',
  'fea',
  'feb',
];

export interface SsrfDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * 检测并规范化混淆的 IPv4 表示形式（十进制整数、十六进制、短格式）。
 * 返回标准点分十进制字符串，不匹配则返回 null。
 *
 * Normalize obfuscated IPv4 representations (decimal integer, hex, short-form)
 * into standard dotted-quad string. Returns null if the hostname is not an IPv4.
 */
function normalizeIPv4(hostname: string): string | null {
  // 1. 十进制整数形式: http://2130706433/ → 127.0.0.1
  if (/^\d{8,10}$/.test(hostname)) {
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xffff_ffff) {
      return `${(num >>> 24) & 0xff}.${(num >>> 16) & 0xff}.${(num >>> 8) & 0xff}.${num & 0xff}`;
    }
  }

  // 2. 十六进制形式: http://0x7f000001/ → 127.0.0.1
  if (/^0x[0-9a-f]{1,8}$/i.test(hostname)) {
    const num = parseInt(hostname, 16);
    if (num >= 0 && num <= 0xffff_ffff) {
      return `${(num >>> 24) & 0xff}.${(num >>> 16) & 0xff}.${(num >>> 8) & 0xff}.${num & 0xff}`;
    }
  }

  // 3. 标准点分十进制（含短格式如 127.1）
  const parts = hostname.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const octets = parts.map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) {
      // 补齐为 4 个 octet (127.1 → 127.0.0.1, 10.0 → 10.0.0.0)
      while (octets.length < 4) octets.push(0);
      return octets.join('.');
    }
  }

  return null;
}

/** 检查 hostname 是否为私有/保留 IP / Check if hostname resolves to a private/reserved IP */
function isPrivateHostname(hostname: string): boolean {
  // 已规范化的 IPv4
  const ipv4 = normalizeIPv4(hostname);
  if (ipv4) {
    return PRIVATE_IPV4_PREFIXES.some((prefix) => ipv4.startsWith(prefix));
  }

  // 字符串前缀检查（常规域名 scenario）
  if (PRIVATE_IPV4_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    return true;
  }

  // IPv6 私有段前缀检查
  if (PRIVATE_IPV6_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    return true;
  }

  return false;
}

/** 检查 URL 是否安全可访问 / Check if URL is safe to access */
export function checkUrl(rawUrl: string): SsrfDecision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${rawUrl.slice(0, 100)}` };
  }

  // 协议检查 / Protocol check
  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'Only http/https allowed' };
  }

  // 主机检查 / Host check
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) {
    return { allowed: false, reason: `Blocked host: ${hostname}` };
  }

  // 内网 IP 检查（含混淆形式检测）/ Private IP check (includes obfuscated form detection)
  if (isPrivateHostname(hostname)) {
    return { allowed: false, reason: `Private network address blocked: ${hostname}` };
  }

  return { allowed: true };
}
