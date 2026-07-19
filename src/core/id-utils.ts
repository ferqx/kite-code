// src/core/id-utils.ts
// 共享的随机 ID 生成函数，供 runner / collector / recorder 复用
//
// traceId: 16-byte random hex → 32 hex chars (OTel traceId 格式)
// spanId:  8-byte random hex  → 16 hex chars (OTel spanId 格式)

/** 16-byte 随机 hex（OTel traceId 格式） */
export function genTraceId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 8-byte 随机 hex（spanId 格式） */
export function genSpanId(): string {
  return genTraceId().slice(0, 16);
}
