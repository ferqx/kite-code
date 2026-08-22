// App-owned random OTel identity generation for local session logs.

export function genTraceId(): string {
  const buffer = new Uint8Array(16);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function genSpanId(): string {
  return genTraceId().slice(0, 16);
}
