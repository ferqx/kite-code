import { X509Certificate } from 'node:crypto';

/** Trusted local fixture input only. Validation and hostname checks remain enabled. */
export function mcpTestCertificate(
  value: string | undefined,
  loopback: boolean,
): string | undefined {
  if (value === undefined) return;
  if (
    !loopback ||
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 16384 ||
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(value)
  )
    throw Error('mcp_test_certificate_invalid');
  new X509Certificate(value);
  return value;
}
